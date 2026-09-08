// 影视资讯聊天助手：就单条新闻正文开放式对谈（流式 UIMessage SSE）
// 前端：chat-island.js（React + useChat）通过 DefaultChatTransport 调本端点
// 请求体：{ url, title, source, text(原文全文), messages: UIMessage[] }
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
  const { url = '', title = '', source = '', text = '', messages = [] } = payload || {};

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

  const system = `${NEWS_CHAT_SYSTEM}

【当前讨论的原文】
来源：${source || '未知'}
标题：${title || '（无标题）'}
链接：${url || '（无）'}
正文（以下是你唯一的事实依据）：
${text.slice(0, MAX_TEXT)}`;

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
