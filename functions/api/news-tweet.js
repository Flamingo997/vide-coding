// Cloudflare Pages Function：影讯推文生成
// POST /api/news-tweet  body: { profileText?, profileKeywords?[] }
// 流程：拉 24h 新闻池 -> 按用户偏好+新鲜度打分匹配 -> 取 Top 素材 -> DeepSeek 生成 3 条备选中文推文
// 返回 { code:0, tweets:[{text,charCount}], material:[...], poolTotal, poolStats, generatedAt }

import OpenAI from 'openai';
import { buildNewsPool } from '../_lib/newsPool.js';
import { NEWS_TWEET_SYSTEM } from '../_lib/prompts.js';

const SITE_URL = 'https://yingxinxian.pages.dev/?utm_source=x&utm_medium=news_tweet';
const MATERIAL_TOP = 10; // 喂给 AI 的素材条数上限

// 源权重（可按需要调整）
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
  // 先把 URL 折算成 23
  const parts = t.split(/(https?:\/\/\S+)/g);
  for (const p of parts) {
    if (/^https?:\/\//.test(p)) { n += 23; continue; }
    for (const ch of p) {
      const cp = ch.codePointAt(0);
      // CJK 统一表意文字 + 扩展 + 常用全角标点 + emoji 区段
      if (
        (cp >= 0x2E80 && cp <= 0x9FFF) ||   // CJK 部首/康熙/注音/统一表意
        (cp >= 0x3000 && cp <= 0x303F) ||   // CJK 标点
        (cp >= 0xFF00 && cp <= 0xFFEF) ||   // 全角形式
        (cp >= 0xF900 && cp <= 0xFAFF) ||   // CJK 兼容表意
        (cp >= 0x20000 && cp <= 0x3FFFF) || // CJK 扩展 B-F
        (cp >= 0x1F300 && cp <= 0x1FAFF) || // emoji
        (cp >= 0x2600 && cp <= 0x27BF)      // 杂项符号（含部分 emoji）
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

  // 关键词命中（前端传来的画像关键词）
  for (const kw of keywords) {
    if (kw && kw.length >= 2 && title.includes(kw)) score += 10;
  }

  // 新鲜度：越新分越高（24h 内线性衰减）
  const hoursAgo = (Date.now() - item.ts) / 3600000;
  score += Math.max(0, 24 - hoursAgo) * 1.5;

  // 源权重
  score += (SOURCE_WEIGHT[item.source] || 0.7) * 5;

  return score;
}

// 解析三段式 AI 输出
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

// 诊断端点：报告函数运行时可见的环境变量（仅名称与前几位，不泄露完整值）
export async function onRequestGet({ env }) {
  const names = Object.keys(env).filter(k => !k.startsWith('__'));
  const preview = {};
  for (const k of names) {
    const v = env[k];
    if (typeof v === 'string' && v.length > 0) preview[k] = v.slice(0, 6) + '...';
    else preview[k] = typeof v; // object = binding
  }
  return new Response(JSON.stringify({ code: 0, vars: names, preview }, null, 2), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
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

    // ===== 3. AI 生成 3 条备选 =====
    const materialText = material
      .map((n, i) => {
        const line = `${i + 1}. [${n.source}] ${n.title}`;
        return n.summary ? `${line}\n   摘要：${n.summary}` : line;
      })
      .join('\n');

    const userPrompt = `【今日影视新闻素材（24小时内）】
${materialText}

【用户兴趣画像】
${profileText || '（无特定偏好，请按新闻热度和可讨论度选材）'}

请生成 3 条备选推文。`;

    const messages = [
      { role: 'system', content: NEWS_TWEET_SYSTEM },
      { role: 'user', content: userPrompt },
    ];

    // ===== 双通道 LLM：DeepSeek 直连 → 失败自动降级 Cloudflare Workers AI =====
    // 根因：Workers 出口到 api.deepseek.com 跨境连接分时段完全挂死（TCP 层不通，重试无解）
    // Workers AI 与 Pages 同网络，零跨境，永不受此影响
    let raw = '';
    let channel = '';
    try {
      const openai = new OpenAI({
        baseURL: 'https://api.deepseek.com',
        apiKey: apiKey,
        timeout: 12000,  // 快断：挂起时 12s 掐掉（连接要么秒通要么完全挂）
        maxRetries: 1,   // 2 次尝试，24s 内决定是否降级
      });
      const completion = await openai.chat.completions.create({
        model: 'deepseek-v4-flash',
        messages,
        stream: false,
        temperature: 0.9, // 推文需要创意
      });
      raw = completion.choices?.[0]?.message?.content || '';
      channel = 'deepseek';
    } catch (e1) {
      if (env.CF_ACCOUNT_ID && env.CF_AI_TOKEN) {
        // 降级通道：Workers AI OpenAI 兼容端点（同网络）
        try {
          const cf = new OpenAI({
            baseURL: `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/v1`,
            apiKey: env.CF_AI_TOKEN,
            timeout: 45000,
            maxRetries: 1,
          });
          const completion = await cf.chat.completions.create({
            model: '@cf/qwen/qwen3.8-27b', // 免费额度内可用的中文旗舰模型
            messages,
            stream: false,
            temperature: 0.9,
          });
          raw = completion.choices?.[0]?.message?.content || '';
          channel = 'workers-ai';
        } catch (e2) {
          throw new Error('DeepSeek超时,降级通道(Workers AI)也失败: ' + (e2.message || String(e2)));
        }
      } else {
        // 诊断：明确告知降级通道环境变量不可见
        throw new Error('DeepSeek超时,且降级通道环境变量(CF_ACCOUNT_ID/CF_AI_TOKEN)未生效——请检查Pages环境变量配置(需Production环境)');
      }
    }

    let tweets = parseTweets(raw);

    // 解析失败兜底：整体当一条
    if (!tweets.length && raw.trim()) tweets = [raw.trim()];
    if (!tweets.length) {
      return jsonResponse({ code: 502, message: 'AI 未返回有效推文' }, 200);
    }

    // 规范化：确保每条带站点链接（AI 漏了就补在末尾）
    tweets = tweets.map(t => t.includes('yingxinxian.pages.dev') ? t : t + '\n' + SITE_URL);

    return jsonResponse({
      code: 0,
      tweets: tweets.map(t => ({ text: t, charCount: xCharCount(t) })),
      material: material.map(n => ({
        title: n.title, source: n.source, url: n.url, ts: n.ts,
      })),
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
