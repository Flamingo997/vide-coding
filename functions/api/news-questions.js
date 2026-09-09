// 引导性问题生成：基于已抓到的新闻正文，每篇生成 3 个"洞察型"问题
// 前端在推文渲染完成后异步调用本端点，问题 chips 点击后经 news-chat 对谈获得新知识
// POST /api/news-questions  body: { articles: [{ url, title, source, text }] }
// 返回 { code: 0, questions: [{ url, questions: [q1, q2, q3] }] }
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { NEWS_QUESTIONS_SYSTEM } from '../_lib/prompts.js';

const MAX_TEXT = 2500;      // 每篇正文截断（生成问题不需要全文）
const MAX_ARTICLES = 5;     // 与推文生成篇数对齐
const GEN_TIMEOUT_MS = 40000;

// DeepSeek 探针结果缓存（isolate 级，60s TTL，与 news-chat.js 同策略）
let dsAlive = null;
let dsCheckedAt = 0;
const DS_CACHE_MS = 60000;

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

// 解析 ===ART<n>=== 区块 → 每篇最多 3 行问题（去掉可能的序号前缀，按长度过滤异常输出）
function parseQuestions(raw, n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const re = new RegExp(`===ART${i}===\\s*([\\s\\S]*?)(?====ART\\d===|$)`, 'i');
    const m = raw.match(re);
    const qs = (m?.[1] || '')
      .split(/\n+/)
      .map(s => s.replace(/^[\s\d.、)．\-—*]+/, '').trim())
      .filter(s => s.length >= 8 && s.length <= 60)
      .slice(0, 3);
    out.push(qs);
  }
  return out;
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

  // 护栏：只收有真实正文的文章（占位文案以（开头）
  const articles = (Array.isArray(payload?.articles) ? payload.articles : [])
    .filter(a => a && a.url && typeof a.text === 'string' && a.text.length >= 100 && !a.text.startsWith('（'))
    .slice(0, MAX_ARTICLES);
  if (!articles.length) return json400('没有可用正文的文章');

  const materialText = articles
    .map((a, i) => `===ART${i + 1}===\n[${a.source || '未知'}] ${a.title || '（无标题）'}\n${String(a.text).slice(0, MAX_TEXT)}`)
    .join('\n\n');

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

  try {
    const { text: raw } = await generateText({
      model,
      system: NEWS_QUESTIONS_SYSTEM,
      prompt: materialText,
      temperature: 0.8,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(GEN_TIMEOUT_MS),
    });

    const parsed = parseQuestions(raw, articles.length);
    const questions = articles.map((a, i) => ({ url: a.url, questions: parsed[i] || [] }));

    return new Response(JSON.stringify({ code: 0, questions }), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ code: 502, message: '问题生成失败: ' + (e?.message || '未知错误') }), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
    });
  }
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
