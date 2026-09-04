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
function parseArticles(raw, fallbackMaterial5) {
  // 正则提取 5 个 ART 区块，每个区块含 SUMMARY / TWEET1 / TWEET2
  const blocks = [];
  const artRe = /===ART(\d)===\s*([\s\S]*?)(?====ART\d===|$)/gi;
  let mm;
  while ((mm = artRe.exec(raw)) !== null) {
    const body = mm[2];
    const s = (body.match(/===SUMMARY===\s*([\s\S]*?)(?====TWEET1===|$)/) || [])[1]?.trim() || '';
    const t1 = (body.match(/===TWEET1===\s*([\s\S]*?)(?====TWEET2===|$)/) || [])[1]?.trim() || '';
    const t2 = (body.match(/===TWEET2===\s*([\s\S]*?)(?====ART\d===|$)/) || [])[1]?.trim() || '';
    if (s || t1 || t2) blocks.push({ summary: s, t1, t2 });
  }
  // 不足 5 条：按 fallbackMaterial5 的索引补齐
  const out = [];
  for (let i = 0; i < 5; i++) {
    const src = fallbackMaterial5[i] || {};
    const b = blocks[i] || {};
    const summary = b.summary || src.summary || src.title || '';
    const ts1 = b.t1;
    const ts2 = b.t2;
    out.push({
      articleTitle: src.title || '',
      articleUrl: src.url || '',
      summary,
      tweets: [ts1, ts2].filter(Boolean).map(text => ({ text, angle: '' })).slice(0, 2),
    });
  }
  // 若某篇 tweets 不足 2 条，补空壳兜底 + 用原摘要当速报推文占位
  out.forEach((o, i) => {
    const src = fallbackMaterial5[i] || {};
    while (o.tweets.length < 2) {
      o.tweets.push({
        text: o.summary ? `【${src.title || '影讯'}】${o.summary.slice(0, 80)}…\n${SITE_URL}` : SITE_URL,
        angle: '',
      });
    }
  });
  return out;
}

// ===== Agent 生成（AI SDK ToolLoopAgent）=====
// 结构化输出不用 response_format（DeepSeek 不支持 json_schema 类型），
// 改用 submitArticles 工具提交——任何支持工具调用的模型通用（含 Workers AI qwen）
const articlesSchema = jsonSchema({
  type: 'object',
  properties: {
    articles: {
      type: 'array',
      minItems: 5,
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          articleTitle: { type: 'string', description: '文章标题，从候选列表中原样复制' },
          articleUrl: { type: 'string', description: '文章 URL，从候选列表中原样复制，作为生源锚' },
          summary: { type: 'string', description: '基于原文真实事实写的 100-160 字中文摘要' },
          tweets: {
            type: 'array', minItems: 2, maxItems: 2,
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: '推文全文（含链接与hashtag）' },
                angle: { type: 'string', description: '角度标签：速报|观点|盘点|共鸣，两条必须不同' },
              },
              required: ['text', 'angle'],
            },
          },
        },
        required: ['articleTitle', 'articleUrl', 'summary', 'tweets'],
      },
    },
  },
  required: ['articles'],
});

async function runAgent({ model, prompt, env, material, totalMs, stepMs, maxRetries }) {
  const fetchTool = tool({
    description: '获取新闻文章的完整原文。输入文章URL，返回正文文本（英文原文保持英文，写作时再转述为中文）。',
    inputSchema: jsonSchema({ type: 'object', properties: { url: { type: 'string', description: '候选列表中的文章完整URL' } }, required: ['url'] }),
    execute: async ({ url }) => {
      const item = material.find(m => m.url === url) || {};
      const r = await fetchArticleContent(url, env, { title: item.title, summary: item.summary });
      return r;
    },
  });

  const submitArticles = tool({
    description: '提交最终结果：必须恰好 5 篇文章，每篇包含摘要 + 恰好 2 条推文。完成原文阅读后必须调用此工具提交，禁止以文本形式直接输出推文。',
    inputSchema: articlesSchema,
    execute: async (input) => ({ received: true }),
  });

  const agent = new ToolLoopAgent({
    model,
    instructions: NEWS_TWEET_AGENT_SYSTEM,
    tools: { fetchArticle: fetchTool, submitArticles },
    stopWhen: isStepCount(12),
    temperature: 0.9,
    maxRetries,
  });

  const result = await agent.generate({ prompt, timeout: { totalMs, stepMs } });

  let articles = null;
  const articlesRead = [];
  for (const step of result.steps || []) {
    for (const part of step.content || []) {
      if (part.type === 'tool-call') {
        if (part.toolName === 'submitArticles' && Array.isArray(part.input?.articles)) {
          articles = part.input.articles.slice(0, 5);
        }
      } else if (part.type === 'tool-result' && part.toolName === 'fetchArticle' && part.input?.url) {
        const it = material.find(m => m.url === part.input.url);
        articlesRead.push({
          title: it?.title || part.output?.title || part.input.url,
          url: part.input.url,
          ok: part.output?.ok !== false,
        });
      }
    }
  }

  if (!articles || articles.length < 5) {
    throw new Error('Agent 未通过 submitArticles 提交 5 篇完整结果（实际' + (articles?.length ?? 0) + '）');
  }
  // 补齐到正好 5 条（Agent 若提交 <5 则用候选列表兜底）
  while (articles.length < 5 && material.length > articles.length) {
    const src = material[articles.length];
    articles.push({
      articleTitle: src.title, articleUrl: src.url,
      summary: src.summary || src.title || '',
      tweets: [
        { text: (src.summary || src.title || '') + `\n${SITE_URL}`, angle: '速报' },
        { text: SITE_URL, angle: '观点' },
      ],
    });
  }
  return { articles, articlesRead };
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

请按以下严格流程执行：
1) 从候选列表中选出 5 篇最契合画像 + 最具话题度的新闻（必须恰好 5 篇）
2) 对每一篇，先调用 fetchArticle 获取其完整原文（可并行请求多篇）
3) 阅读后，为每一篇产出：
   · 100-160 字中文摘要（严格基于原文事实，不能凭标题脑补）
   · 2 条备选推文（速报/观点/共鸣/盘点，两条角度必须不同；≤240字符CJK×2；首句钩子；末尾UTM链接；带hashtag）
4) 全部完成后，调用 submitArticles 工具一次性提交 5 篇结构化结果。`;

    const mat5 = material.slice(0, 5); // 用于 legacy 兜底锚定

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
        } catch (_) {}
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

    let articles = null;
    let articlesRead = [];
    let channel = '';
    let lastError = null;
    let legacyMode = false; // 决定 ok 默认值（legacy=摘要,Agent=看具体条目）

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

    if (deepseekAlive) {
      try {
        const r = await runAgent({
          model: deepseek.chat('deepseek-v4-flash'),
          prompt: agentPrompt, env, material,
          totalMs: 110000, stepMs: 50000, maxRetries: 1,
        });
        articles = r.articles; articlesRead = r.articlesRead; channel = 'deepseek-agent';
      } catch (e1) { lastError = e1; }
    } else {
      lastError = new Error('DeepSeek 探活失败（跨境不通）');
    }

    if (!articles && cf) {
      try {
        const r = await runAgent({
          model: cf.chat('@cf/qwen/qwen3-30b-a3b-fp8'),
          prompt: agentPrompt, env, material,
          totalMs: 100000, stepMs: 45000, maxRetries: 0,
        });
        articles = r.articles; articlesRead = r.articlesRead; channel = 'workers-ai-agent';
      } catch (e2) { lastError = e2; }
    }

    // -- 通道3: 旧链路兜底（按前5篇素材，每篇摘要+2推文）
    if (!articles) {
      const legacy = await legacyGenerate({ apiKey, env, cf, material: mat5, profileText });
      articles = legacy.articles;
      channel = legacy.channel;
      legacyMode = true;
      articlesRead = mat5.map(m => ({ title: m.title, url: m.url, ok: false }));
    }

    if (!articles || articles.length < 5) {
      return jsonResponse({ code: 502, message: '推文生成失败: ' + (lastError?.message || `产出不足5篇（${articles?.length ?? 0}）`) }, 200);
    }
    const okMap = new Map(articlesRead.map(a => [a.url, a.ok === true]));

    // 规范化：补齐 site link + charCount，然后并行抓 5 篇正文放进响应（用于前端直接展开显示）
    const finalArticles = articles.slice(0, 5).map((a, i) => {
      const url = a.articleUrl || mat5[i]?.url || '';
      const title = a.articleTitle || mat5[i]?.title || '';
      const meta = material.find(m => m.url === url) || mat5[i] || {};
      const tweets = (a.tweets || []).slice(0, 2).map(t => {
        const text = (t.text || '').includes('yingxinxian.pages.dev') ? (t.text || '') : `${t.text || ''}\n${SITE_URL}`;
        return {
          text,
          charCount: xCharCount(text),
          angle: t.angle || '',
        };
      });
      while (tweets.length < 2) tweets.push({ text: SITE_URL, charCount: xCharCount(SITE_URL), angle: '' });
      return {
        title,
        url,
        source: meta.source || '',
        summary: String(a.summary || meta.summary || title || '').slice(0, 300),
        tweets,
        ok: okMap.has(url) ? okMap.get(url) : !legacyMode,
        text: '', // 下方并行抓
      };
    });
    // 并行拉正文（Agent 读过的命中缓存；超时/失败放降级提示，正文抓取不阻塞整体返回）
    await Promise.allSettled(finalArticles.map(async (art) => {
      if (!art.url) { art.ok = false; art.text = '（无有效素材链接）'; return; }
      const meta = material.find(m => m.url === art.url) || {};
      try {
        const r = await Promise.race([
          fetchArticleContent(art.url, env, { title: meta.title, summary: meta.summary }),
          new Promise((_, rj) => setTimeout(() => rj(new Error('正文抓取超时(15s)')), 15000)),
        ]);
        art.ok = art.ok && (r.ok !== false);
        art.text = r.text || '';
        if (!art.title && r.title) art.title = r.title;
      } catch (e) {
        art.ok = false;
        art.text = `（原文获取失败：${e.message || '未知错误'}。可点"源站↗"直接源站查看，或参考摘要核对推文）`;
      }
    }));

    return jsonResponse({
      code: 0,
      articles: finalArticles,
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

// ===== 旧链路（兜底）：前5条标题+摘要 → 单次生成 → 正则解析为 5×(摘要+2推文) =====
async function legacyGenerate({ apiKey, env, cf, material, profileText }) {
  const materialText = material
    .map((n, i) => {
      const line = `${i + 1}. [${n.source}] ${n.title}`;
      return n.summary ? `${line}\n   摘要：${n.summary}` : line;
    })
    .join('\n');

  const messages = [
    { role: 'system', content: NEWS_TWEET_SYSTEM },
    { role: 'user', content: `【今日影视新闻素材（24小时内，按匹配度排序，共 ${material.length} 条）】\n${materialText}\n\n【用户兴趣画像】\n${profileText || '（无特定偏好）'}\n\n请严格按系统提示的 5 组区块格式（===ART1=== ... ===ART5===）输出：每条素材 1 条中文摘要 + 2 条不同角度推文。` },
  ];

  let raw = '';
  let channel = '';
  try {
    const openai = new OpenAI({ baseURL: 'https://api.deepseek.com', apiKey, timeout: 15000, maxRetries: 1 });
    const c = await openai.chat.completions.create({
      model: 'deepseek-v4-flash',
      messages,
      stream: false,
      temperature: 0.9,
      thinking: { type: 'disabled' },
    });
    raw = c.choices?.[0]?.message?.content || '';
    channel = 'legacy-deepseek';
  } catch (e1) {
    if (!cf) throw e1;
    const openai2 = new OpenAI({
      baseURL: `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/v1`,
      apiKey: env.CF_AI_TOKEN,
      timeout: 70000,
      maxRetries: 0,
    });
    const c = await openai2.chat.completions.create({
      model: '@cf/qwen/qwen3-30b-a3b-fp8', messages, stream: false, temperature: 0.9,
    });
    raw = c.choices?.[0]?.message?.content || '';
    channel = 'legacy-workers-ai';
  }

  const articles = parseArticles(raw, material.slice(0, 5));
  // parseArticles 已保证恰好 5 条、每条 2 条推文（不足时已兜底）
  return { articles, channel };
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
