// 影视资讯聊天助手：就单条新闻正文开放式对谈（流式 UIMessage SSE）
// 前端：chat-island.js（React + useChat）通过 DefaultChatTransport 调本端点
// 请求体：{ url, title, source, text(原文全文), messages: UIMessage[], search?: boolean }
//   search=true：来自「深挖一下」引导性问题 chip，首条消息直接联网搜索补充上下文
// 响应：UIMessage Stream（SSE），供 useChat 直接消费
import { streamText, generateText, convertToModelMessages, toUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { NEWS_CHAT_SYSTEM } from '../_lib/prompts.js';

// DeepSeek 探针结果缓存（isolate 级模块作用域，Pages Functions 同实例复用；60s TTL 省每轮 4s 探活）
let dsAlive = null;
let dsCheckedAt = 0;
const DS_CACHE_MS = 60000;

// 护栏常量
const MAX_TEXT = 8000;      // 原文截断（防超 qwen3-30b 上下文）
const MAX_MSGS = 20;        // 对话历史裁剪
const MAX_USER_INPUT = 500; // 单条用户输入截断（客户端已截，服务端双保险）
const STREAM_TIMEOUT_MS = 45000;
const SEARCH_TIMEOUT_MS = 8000;   // Jina 搜索超时（超了静默跳过，不阻塞回答）
const INTENT_TIMEOUT_MS = 7000;   // 意图判断超时（超了视为不搜）
const MAX_SEARCH_RESULT = 4000;   // 搜索结果注入长度上限

function json400(message) {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
  });
}

// DeepSeek 需要注入 thinking disabled（v4 思考模型不关会拖爆时延）
function makeDeepSeek(apiKey) {
  return createOpenAI({
    baseURL: 'https://api.deepseek.com',
    apiKey,
    fetch: (url, init) => {
      try {
        if (init?.body) {
          const b = JSON.parse(init.body);
          b.thinking = { type: 'disabled' };
          init = { ...init, body: JSON.stringify(b) };
        }
      } catch (_) {}
      return fetch(url, init);
    },
  });
}

// 剥掉思考模型可能输出的 <think> 块（qwen 系列）
function stripThink(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// Jina 联网搜索（s.jina.ai，复用原文抓取的 JINA_API_KEY；no-content = 只拿 SERP 摘要不抓正文，快）
async function jinaSearch(query, apiKey) {
  try {
    const r = await fetch('https://s.jina.ai/' + encodeURIComponent(String(query).slice(0, 60)), {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'X-Respond-With': 'no-content',
        'Accept': 'text/plain',
      },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!r.ok) return '';
    const t = stripThink(await r.text());
    return t.slice(0, MAX_SEARCH_RESULT);
  } catch (_) {
    return '';
  }
}

// 意图判断：这条用户消息是否需要原文之外的外部信息；需要则返回搜索关键词，否则 null
async function intentNeedsSearch({ model, title, userText }) {
  try {
    const { text } = await generateText({
      model,
      system: `你在判断一条用户消息是否需要联网搜索。背景：用户正就影视新闻《${String(title).slice(0, 60)}》和助手对谈。若消息涉及原文之外的行业数据、市场背景、横向对比、最新进展、具体数字核实等，则需搜索。
输出格式（只输出一行）：需要时「NEED|搜索关键词」（关键词≤25字）；不需要时「NO」。`,
      prompt: String(userText).slice(0, 300),
      temperature: 0,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(INTENT_TIMEOUT_MS),
    });
    const m = stripThink(text).match(/NEED\s*[|｜:：]\s*(.+)/);
    if (m) return m[1].trim().slice(0, 60);
    return null;
  } catch (_) {
    return null; // 判断失败 = 不搜，绝不阻塞聊天
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) return json400('未配置 DEEPSEEK_API_KEY');

  let payload;
  try {
    payload = await request.json();
  } catch (_) {
    return json400('请求体不是合法 JSON');
  }
  const { url = '', title = '', source = '', text = '', messages = [], search = false } = payload || {};

  // 有正文才能聊（入口按钮已控制，这里再兜一层）
  if (!text || text.length < 100 || text.startsWith('（')) {
    return json400('该文章没有可用正文，无法对谈');
  }

  // 历史裁剪 + 输入长度护栏：只留 user/assistant 的文本部分
  const trimmed = (Array.isArray(messages) ? messages : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
    .slice(-MAX_MSGS)
    .map(m => ({
      id: m.id,
      role: m.role,
      parts: (Array.isArray(m.parts) ? m.parts : [])
        .filter(p => p && p.type === 'text' && p.text && String(p.text).trim())
        .map(p => ({
          type: 'text',
          text: String(p.text).slice(0, m.role === 'user' ? MAX_USER_INPUT : 4000),
        })),
    }))
    .filter(m => m.parts.length);

  if (!trimmed.length || trimmed[trimmed.length - 1].role !== 'user') {
    return json400('最后一条必须是用户消息');
  }

  const modelMessages = await convertToModelMessages(trimmed);

  // ===== 通道选择：DeepSeek（探针 + 60s 缓存）→ Workers AI qwen3-30b =====
  const now = Date.now();
  if (dsAlive === null || now - dsCheckedAt > DS_CACHE_MS) {
    try {
      const ds = makeDeepSeek(apiKey);
      await generateText({
        model: ds.chat('deepseek-v4-flash'),
        prompt: 'OK',
        maxRetries: 0,
        timeout: { totalMs: 4000 },
      });
      dsAlive = true;
    } catch (_) {
      dsAlive = false;
    }
    dsCheckedAt = now;
  }

  let model;
  if (dsAlive) {
    model = makeDeepSeek(apiKey).chat('deepseek-v4-flash');
  } else if (env.CF_ACCOUNT_ID && env.CF_AI_TOKEN) {
    const cf = createOpenAI({
      baseURL: `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/v1`,
      apiKey: env.CF_AI_TOKEN,
    });
    model = cf.chat('@cf/qwen/qwen3-30b-a3b-fp8');
  } else {
    return json400('DeepSeek 跨境不通且未配置 Workers AI 降级通道');
  }

  // ===== 联网搜索决策：给上下文补充外部信息 =====
  // 规则：引导性问题 chip（search=true）且是首条消息 → 直接搜（这类问题本来就要原文之外的信息）；
  // 其余消息 → 快速意图判断（模型自主决定），需要才搜；搜索失败/超时一律静默跳过
  let searchBlock = '';
  if (env.JINA_API_KEY) {
    const lastUserText = (trimmed[trimmed.length - 1].parts || []).map(p => p.text).join(' ');
    let query = null;
    if (search === true && trimmed.length === 1) {
      query = lastUserText; // chip 直搜
    } else {
      query = await intentNeedsSearch({ model, title, userText: lastUserText });
    }
    if (query) {
      const result = await jinaSearch(query, env.JINA_API_KEY);
      if (result) {
        searchBlock = `

【搜索补充资料（系统联网搜到的相关信息，仅供参考）】
搜索词：${query}
${result}`;
      }
    }
  }

  const system = `${NEWS_CHAT_SYSTEM}

【当前讨论的原文】
来源：${source || '未知'}
标题：${title || '（无标题）'}
链接：${url || '（无）'}
正文（以下是你唯一的事实依据）：
${text.slice(0, MAX_TEXT)}${searchBlock}`;

  // ===== 流式生成 + UIMessage SSE =====
  const result = streamText({
    model,
    system,
    messages: modelMessages,
    temperature: 0.8,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
  });

  const uiStream = toUIMessageStream({
    stream: result.stream,
    onError: e => '生成失败：' + (e?.message || '未知错误，请重试'),
  });

  return createUIMessageStreamResponse({ stream: uiStream });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
