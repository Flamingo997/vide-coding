// Cloudflare Pages Function：影讯推文生成（AI SDK Agent 版）
// POST /api/news-tweet  body: { profileText?, profileKeywords?[] }
// 流程：拉 24h 新闻池 -> 偏好打分取 Top 候选 -> ToolLoopAgent 用 fetchArticle 工具阅读原文 -> 结构化输出 3 条备选
// 通道：DeepSeek Agent → Workers AI Agent → 旧链路（标题+摘要单次生成）三级降级
// 返回 { code:0, tweets:[{text,charCount,angle?,sourceTitle?}], material, articlesRead, channel, ... }

import OpenAI from 'openai';
import { ToolLoopAgent, tool, jsonSchema, isStepCount, generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { buildNewsPool } from '../_lib/newsPool.js';
import { fetchArticleContent } from '../_lib/articleFetcher.js';
import { NEWS_TWEET_AGENT_SYSTEM, NEWS_TWEET_SYSTEM } from '../_lib/prompts.js';

const SITE_URL = 'https://yingxinxian.pages.dev/?utm_source=x&utm_medium=news_tweet';
const MATERIAL_TOP = 10; // 喂给 Agent 的候选条数

const SOURCE_WEIGHT = {
  '环球影讯': 1.0,
  'Variety': 0.9,
  'Deadline': 0.9,
  'THR': 0.85,
  'IndieWire': 0.8,
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// X 字符计数：CJK/emoji 按 2，URL 按 23，其余按 1
export function xCharCount(text) {
  const t = String(text || '');
  let n = 0;
  const parts = t.split(/(https?:\/\/\S+)/g);
  for (const p of parts) {
    if (/^https?:\/\//.test(p)) { n += 23; continue; }
    for (const ch of p) {
      const cp = ch.codePointAt(0);
      if (
        (cp >= 0x2E80 && cp <= 0x9FFF) ||
        (cp >= 0x3000 && cp <= 0x303F) ||
        (cp >= 0xFF00 && cp <= 0xFFEF) ||
        (cp >= 0xF900 && cp <= 0xFAFF) ||
        (cp >= 0x20000 && cp <= 0x3FFFF) ||
        (cp >= 0x1F300 && cp <= 0x1FAFF) ||
        (cp >= 0x2600 && cp <= 0x27BF)
      ) n += 2;
      else n += 1;
    }
  }
  return n;
}

// 匹配打分：关键词命中 + 新鲜度 + 源权重
function scoreNews(item, keywords) {
  const title = item.title || '';
  let score = 0;
  for (const kw of keywords) {
    if (kw && kw.length >= 2 && title.includes(kw)) score += 10;
  }
  const hoursAgo = (Date.now() - item.ts) / 3600000;
  score += Math.max(0, 24 - hoursAgo) * 1.5;
  score += (SOURCE_WEIGHT[item.source] || 0.7) * 5;
  return score;
}

// 旧链路的正则解析（兜底用）
function parseTweets(raw) {
  const tweets = [];
  const re = /===TWEET(\d)===\s*([\s\S]*?)(?====TWEET\d===|$)/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const text = m[2].trim();
    if (text) tweets.push(text);
  }
  return tweets;
}

// ===== Agent 生成（AI SDK ToolLoopAgent）=====
// 结构化输出不用 response_format（DeepSeek 不支持 json_schema 类型），
// 改用 submitTweets 工具提交——任何支持工具调用的模型通用（含 Workers AI qwen）
const tweetsSchema = jsonSchema({
  type: 'object',
  properties: {
    tweets: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '推文全文（含链接与hashtag）' },
          angle: { type: 'string', description: '角度类型：速报/观点/盘点' },
          sourceTitle: { type: 'string', description: '主要素材的文章标题' },
          sourceUrl: { type: 'string', description: '主要素材的文章URL（必须来自候选列表）' },
        },
        required: ['text', 'angle', 'sourceTitle', 'sourceUrl'],
      },
    },
  },
  required: ['tweets'],
});

async function runAgent({ model, prompt, env, material, totalMs, stepMs, maxRetries }) {
  const fetchTool = tool({
    description: '获取新闻文章的完整原文。输入文章URL，返回正文文本（英文原文保持英文，写作时再转述为中文）。',
    inputSchema: jsonSchema({ type: 'object', properties: { url: { type: 'string', description: '候选列表中的文章完整URL' } }, required: ['url'] }),
    execute: async ({ url }) => {
      // 找到对应池内条目做降级信息（标题+摘要）
      const item = material.find(m => m.url === url) || {};
      const r = await fetchArticleContent(url, env, { title: item.title, summary: item.summary });
      return r;
    },
  });

  const submitTweets = tool({
    description: '提交最终结果：3 条备选推文。完成原文阅读后必须调用此工具提交，不要直接以文本形式输出推文。',
    inputSchema: tweetsSchema,
    execute: async (input) => ({ received: true }),
  });

  const agent = new ToolLoopAgent({
    model,
    instructions: NEWS_TWEET_AGENT_SYSTEM,
    tools: { fetchArticle: fetchTool, submitTweets },
    stopWhen: isStepCount(10), // 防失控循环
    temperature: 0.9,
    maxRetries,
  });

  const result = await agent.generate({ prompt, timeout: { totalMs, stepMs } });

  // 从 steps 提取 submitTweets 提交结果 + 实际读过的文章（含抓取成功状态，供前端溯源展示）
  let tweets = null;
  const articlesRead = [];
  for (const step of result.steps || []) {
    for (const part of step.content || []) {
      if (part.type === 'tool-call') {
        if (part.toolName === 'submitTweets' && Array.isArray(part.input?.tweets)) {
          tweets = part.input.tweets; // 取最后一次提交
        }
      } else if (part.type === 'tool-result' && part.toolName === 'fetchArticle' && part.input?.url) {
        const it = material.find(m => m.url === part.input.url);
        articlesRead.push({
          title: it?.title || part.output?.title || part.input.url,
          url: part.input.url,
          ok: part.output?.ok !== false, // 原文是否真实抓到（false=降级到摘要）
        });
      }
    }
  }

  if (!tweets || !tweets.length) {
    throw new Error('Agent 未通过 submitTweets 提交有效结果');
  }

  return { tweets, articlesRead };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return jsonResponse({ code: 500, message: '未配置 DEEPSEEK_API_KEY' }, 500);
  }

  try {
    const body = await request.json().catch(() => ({}));
    const profileText = String(body.profileText || '').slice(0, 600);
    const keywords = Array.isArray(body.profileKeywords)
      ? body.profileKeywords.filter(k => typeof k === 'string' && k.length >= 2 && k.length <= 12).slice(0, 30)
      : [];

    // ===== 1. 拉新闻池 =====
    const poolResult = await buildNewsPool();
    if (!poolResult.pool.length) {
      return jsonResponse({ code: 404, message: '24小时内新闻池为空，稍后再试' }, 200);
    }

    // ===== 2. 偏好匹配打分 =====
    const scored = poolResult.pool
      .map(item => ({ item, score: scoreNews(item, keywords) }))
      .sort((a, b) => b.score - a.score);

    const material = scored.slice(0, MATERIAL_TOP).map(s => s.item);

    // ===== 3. Agent 生成（三级降级：DeepSeek Agent → Workers AI Agent → 旧链路）=====

    // 候选列表：标题 + 来源 + URL（刻意不给摘要——逼 Agent 读原文，满足"不基于标题推理"）
    const candidatesText = material
      .map((n, i) => `${i + 1}. [${n.source}] ${n.title}\n   URL: ${n.url}`)
      .join('\n');

    const agentPrompt = `【候选新闻（24小时内，已按与用户画像的相关度排序）】
${candidatesText}

【用户兴趣画像】
${profileText || '（无特定偏好，请按新闻热度和可讨论度选材）'}

请先用 fetchArticle 工具阅读你认为最值得写的 3-5 篇原文（优先匹配画像，可并行请求），然后调用 submitTweets 工具提交 3 条备选推文。`;

    // DeepSeek provider：经自定义 fetch 注入 thinking:disabled
    // （v4-flash 是思考模型，长上下文下思考 token 爆炸导致每步 60s+；实测 disabled 后正常）
    const deepseek = createOpenAI({
      baseURL: 'https://api.deepseek.com',
      apiKey,
      fetch: (url, init) => {
        try {
          if (init?.body) {
            const body = JSON.parse(init.body);
            body.thinking = { type: 'disabled' };
            init = { ...init, body: JSON.stringify(body) };
          }
        } catch (_) { /* 注入失败则按原样发送 */ }
        return fetch(url, init);
      },
    });
    const cfConfigured = env.CF_ACCOUNT_ID && env.CF_AI_TOKEN;
    const cf = cfConfigured
      ? createOpenAI({
          baseURL: `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/v1`,
          apiKey: env.CF_AI_TOKEN,
        })
      : null;

    let tweets = null;
    let articlesRead = [];
    let channel = '';
    let lastError = null;

    // -- 探活预检：4s 小探测决定是否走 DeepSeek Agent（跨境挂死时秒级跳过，不浪费宽 stepMs）
    let deepseekAlive = false;
    try {
      await generateText({
        model: deepseek.chat('deepseek-v4-flash'),
        prompt: 'OK',
        maxRetries: 0,
        timeout: { totalMs: 5000 },
      });
      deepseekAlive = true;
    } catch (_) { deepseekAlive = false; }

    // -- 通道1: DeepSeek Agent（探活通过才跑，宽超时）
    if (deepseekAlive) {
      try {
        const r = await runAgent({
          model: deepseek.chat('deepseek-v4-flash'), // .chat()=Chat Completions(DeepSeek无Responses API)
          prompt: agentPrompt, env, material,
          totalMs: 100000, stepMs: 45000, maxRetries: 1,
        });
        tweets = r.tweets; articlesRead = r.articlesRead; channel = 'deepseek-agent';
      } catch (e1) {
        lastError = e1;
      }
    } else {
      lastError = new Error('DeepSeek 探活失败（跨境不通）');
    }

    // -- 通道2: Workers AI Agent（同网络零跨境；qwen3-30b-a3b 支持工具调用）
    if (!tweets && cf) {
      try {
        const r = await runAgent({
          model: cf.chat('@cf/qwen/qwen3-30b-a3b-fp8'), // .chat()=OpenAI兼容端点
          prompt: agentPrompt, env, material,
          totalMs: 90000, stepMs: 40000, maxRetries: 0,
        });
        tweets = r.tweets; articlesRead = r.articlesRead; channel = 'workers-ai-agent';
      } catch (e2) {
        lastError = e2;
      }
    }

    // -- 通道3: 旧链路兜底（标题+摘要单次生成，无工具循环，已在线上验证可用）
    if (!tweets) {
      const legacy = await legacyGenerate({ apiKey, env, cf, material, profileText });
      // legacy 不读原文——用 material 顺序做 best-effort 溯源映射，并诚实标记 ok=false（琥珀色 已读·摘要）
      tweets = legacy.tweets.map((t, i) => {
        const src = material[i % Math.max(1, material.length)] || {};
        return {
          text: t.text,
          angle: t.angle || '',
          sourceTitle: src.title || t.sourceTitle || '',
          sourceUrl: src.url || t.sourceUrl || '',
        };
      });
      channel = legacy.channel;
      articlesRead = material.slice(0, Math.min(3, material.length)).map(m => ({
        title: m.title, url: m.url, ok: false,
      }));
    }

    if (!tweets || !tweets.length) {
      return jsonResponse({ code: 502, message: '推文生成失败: ' + (lastError?.message || '所有通道均失败') }, 200);
    }

    // 规范化：确保每条带站点链接 + 透传溯源字段
    const normTweets = tweets.map(t => {
      const text = t.text.includes('yingxinxian.pages.dev') ? t.text : t.text + '\n' + SITE_URL;
      return {
        text,
        charCount: xCharCount(text),
        angle: t.angle || '',
        sourceTitle: t.sourceTitle || '',
        sourceUrl: t.sourceUrl || '',
      };
    });

    return jsonResponse({
      code: 0,
      tweets: normTweets,
      material: material.map(n => ({ title: n.title, source: n.source, url: n.url, ts: n.ts })),
      articlesRead,
      poolTotal: poolResult.total,
      poolStats: poolResult.stats,
      poolWindowHours: poolResult.windowHours || 24,
      channel,
      generatedAt: Date.now(),
    });
  } catch (e) {
    return jsonResponse({ code: 502, message: '推文生成失败: ' + (e.message || String(e)) }, 200);
  }
}

// ===== 旧链路（兜底）：标题+摘要 → 单次生成 → 正则解析 =====
async function legacyGenerate({ apiKey, env, cf, material, profileText }) {
  const materialText = material
    .map((n, i) => {
      const line = `${i + 1}. [${n.source}] ${n.title}`;
      return n.summary ? `${line}\n   摘要：${n.summary}` : line;
    })
    .join('\n');

  const messages = [
    { role: 'system', content: NEWS_TWEET_SYSTEM },
    { role: 'user', content: `【今日影视新闻素材（24小时内）】\n${materialText}\n\n【用户兴趣画像】\n${profileText || '（无特定偏好）'}\n\n请生成 3 条备选推文。` },
  ];

  // DeepSeek 快试 → Workers AI 单次生成
  let raw = '';
  let channel = '';
  try {
    const openai = new OpenAI({ baseURL: 'https://api.deepseek.com', apiKey, timeout: 12000, maxRetries: 1 });
    const c = await openai.chat.completions.create({
      model: 'deepseek-v4-flash',
      messages,
      stream: false,
      temperature: 0.9,
      thinking: { type: 'disabled' }, // 关思考，防长上下文下耗时爆炸
    });
    raw = c.choices?.[0]?.message?.content || '';
    channel = 'legacy-deepseek';
  } catch (e1) {
    if (!cf) throw e1;
    const openai2 = new OpenAI({
      baseURL: `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/v1`,
      apiKey: env.CF_AI_TOKEN,
      timeout: 60000,
      maxRetries: 0,
    });
    const c = await openai2.chat.completions.create({
      model: '@cf/qwen/qwen3-30b-a3b-fp8', messages, stream: false, temperature: 0.9,
    });
    raw = c.choices?.[0]?.message?.content || '';
    channel = 'legacy-workers-ai';
  }

  let texts = parseTweets(raw);
  if (!texts.length && raw.trim()) texts = [raw.trim()];
  if (!texts.length) throw new Error('旧链路也未产出有效推文');
  return { tweets: texts.map(t => ({ text: t })), channel };
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
