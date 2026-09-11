// 全站 AI 助手：站内条目检索 + 流式问答（UIMessage SSE）
// 前端：chat-island.js 全站模式（右下角圆形按钮）经 DefaultChatTransport 调本端点
// 请求体：{ messages: UIMessage[], items?: [{id,title,type,date?,summary?}] }
//   items = 策略A：前端当前页条目（≤50），searchItems 在这批 + TMDB + 服务端新闻池 中检索
// Tool：searchItems 由模型运行时自主调用（真 tool calling），返回站内真实条目；任何异常消化为空结果，绝不 500
import { streamText, generateText, convertToModelMessages, toUIMessageStream, createUIMessageStreamResponse, tool, stepCountIs } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { STATION_ASSISTANT_SYSTEM } from '../_lib/prompts.js';
import { buildNewsPool } from '../_lib/newsPool.js';

// DeepSeek 探针缓存（isolate 级模块作用域，与 news-chat.js 同策略；60s TTL）
let dsAlive = null;
let dsCheckedAt = 0;
const DS_CACHE_MS = 60000;

// 护栏常量
const MAX_MSGS = 20;          // 对话历史裁剪
const MAX_USER_INPUT = 500;   // 单条用户输入截断
const STREAM_TIMEOUT_MS = 45000;
const TMDB_TIMEOUT_MS = 7000; // TMDB 检索超时（超时该源返回空，不阻塞工具）
const POOL_TIMEOUT_MS = 6000; // 新闻池构建超时（走 CF 边缘缓存，冷启动兜底）
const MAX_BODY_ITEMS = 50;    // 策略A：前端携带条目上限

const TYPE_LABEL = { movie: '电影', drama: '电视剧', show: '综艺', anime: '动漫', doc: '纪录片', duan: '短剧', news: '影视资讯' };

// 中文类型词 → TMDB genre id（movie / tv；null 表示该媒介无此类型）
// 命中类型词走 discover（按热度），否则走 search/multi（片名/人名文本搜索）
const GENRE_ZH = [
  { key: '科幻', movie: 878, tv: 10765 },
  { key: '悬疑', movie: 9648, tv: 9648 },
  { key: '喜剧', movie: 35, tv: 35 },
  { key: '爱情', movie: 10749, tv: 10749 },
  { key: '动作', movie: 28, tv: 10759 },
  { key: '恐怖', movie: 27, tv: 27 },
  { key: '动画', movie: 16, tv: 16 },
  { key: '动漫', movie: 16, tv: 16 },
  { key: '纪录', movie: 99, tv: 99 },
  { key: '犯罪', movie: 80, tv: 80 },
  { key: '剧情', movie: 18, tv: 18 },
  { key: '奇幻', movie: 14, tv: 10765 },
  { key: '惊悚', movie: 53, tv: 53 },
  { key: '战争', movie: 10752, tv: 10768 },
  { key: '冒险', movie: 12, tv: 10759 },
  { key: '家庭', movie: 10751, tv: 10751 },
  { key: '历史', movie: 36, tv: 36 },
  { key: '综艺', movie: null, tv: 10764 },
];

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

// 站内条目链接：影视卡片走站内搜索深链（首页 ?q= 自动检索定位），资讯走原文链接
function stationUrl(title) {
  return '/?q=' + encodeURIComponent(String(title || '').slice(0, 40));
}

function normTmdbItem(it, mediaType) {
  const isMovie = mediaType === 'movie';
  const title = isMovie ? (it.title || it.original_title) : (it.name || it.original_name);
  if (!title) return null;
  return {
    id: 'tmdb-' + mediaType + '-' + it.id,
    title,
    type: isMovie ? 'movie' : 'drama',
    date: isMovie ? (it.release_date || '') : (it.first_air_date || ''),
    rating: it.vote_count ? Number((it.vote_average || 0).toFixed(1)) : null,
    url: stationUrl(title),
  };
}

// TMDB 文本搜索（片名/人名/主题词）
async function tmdbTextSearch(query, limit, key) {
  try {
    const r = await fetch(
      `https://api.themoviedb.org/3/search/multi?api_key=${key}&language=zh-CN&query=${encodeURIComponent(query)}&include_adult=false&page=1`,
      { signal: AbortSignal.timeout(TMDB_TIMEOUT_MS) }
    );
    if (!r.ok) return [];
    const j = await r.json();
    const out = [];
    for (const it of j.results || []) {
      if (it.media_type !== 'movie' && it.media_type !== 'tv') continue;
      const item = normTmdbItem(it, it.media_type);
      if (item) out.push(item);
      if (out.length >= limit) break;
    }
    return out;
  } catch (_) {
    return [];
  }
}

// TMDB 类型发现（中文类型词 → discover，2023 年以来按热度）
async function tmdbGenreDiscover(genre, limit, key) {
  const out = [];
  const want = Math.ceil(limit / 2);
  const tasks = [];
  if (genre.movie) {
    tasks.push(fetch(
      `https://api.themoviedb.org/3/discover/movie?api_key=${key}&language=zh-CN&with_genres=${genre.movie}` +
      `&sort_by=popularity.desc&primary_release_date.gte=2023-01-01&include_adult=false&page=1`,
      { signal: AbortSignal.timeout(TMDB_TIMEOUT_MS) }
    ).then(r => r.ok ? r.json() : null).then(j => ({ j, mediaType: 'movie' })).catch(() => null));
  }
  if (genre.tv) {
    // 竖线 = OR（逗号是 AND 会查空）；剧集类型结果不足时用 18（剧情）兜底保证数量
    const tvGenre = genre.key === '综艺' ? '10764|10767' : `${genre.tv}|18`;
    tasks.push(fetch(
      `https://api.themoviedb.org/3/discover/tv?api_key=${key}&language=zh-CN&with_genres=${tvGenre}` +
      `&sort_by=popularity.desc&first_air_date.gte=2023-01-01&include_adult=false&page=1`,
      { signal: AbortSignal.timeout(TMDB_TIMEOUT_MS) }
    ).then(r => r.ok ? r.json() : null).then(j => ({ j, mediaType: 'tv' })).catch(() => null));
  }
  const results = await Promise.all(tasks);
  for (const { j, mediaType } of results.filter(Boolean)) {
    for (const it of j?.results || []) {
      const item = normTmdbItem(it, mediaType);
      if (item) out.push(item);
      if (out.length >= want) break;
    }
  }
  return out;
}

// 服务端新闻池检索（buildNewsPool 走 CF 边缘缓存：RSS 30min / 环球 10min；冷启动 6s 超时兜底）
async function searchNewsPool(query, limit) {
  try {
    const timer = new Promise(resolve => setTimeout(() => resolve(null), POOL_TIMEOUT_MS));
    const result = await Promise.race([buildNewsPool(), timer]);
    if (!result || !Array.isArray(result.pool)) return [];
    const q = String(query).toLowerCase().trim();
    return result.pool
      .filter(n => {
        const t = String(n.title || '').toLowerCase();
        const s = String(n.summary || '').toLowerCase();
        return t.includes(q) || s.includes(q);
      })
      .slice(0, limit)
      .map(n => ({
        id: 'news-' + String(n.url || '').slice(-32),
        title: n.title,
        type: 'news',
        date: n.ts ? new Date(n.ts).toISOString().slice(0, 10) : '',
        source: n.source || '',
        url: n.url || stationUrl(n.title),
      }));
  } catch (_) {
    return [];
  }
}

// 策略A：前端当前页条目内检索
function searchBodyItems(items, query, limit) {
  const q = String(query).toLowerCase().trim();
  const out = [];
  for (const it of items) {
    const title = String(it.title || '');
    const summary = String(it.summary || '');
    if (title.toLowerCase().includes(q) || summary.toLowerCase().includes(q)) {
      out.push({
        id: String(it.id || ''),
        title,
        type: String(it.type || ''),
        date: String(it.date || ''),
        url: stationUrl(title),
      });
      if (out.length >= limit) break;
    }
  }
  return out;
}

// ===== D1 收藏查询（复用 favorites.js 的会话校验逻辑） =====
function getCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

async function verifySession(db, request) {
  const token = getCookie(request.headers.get('Cookie'), 'session');
  if (!token) return null;
  const row = await db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?').bind(token).first();
  if (!row) return null;
  if (Date.now() > row.expires_at) {
    await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return null;
  }
  return row.user_id;
}

const MAX_FAV_RETURN = 10; // getFavorites 返回条数上限（作业要求 limit ≤10）

// 查当前登录用户的 D1 收藏（未登录返回提示文案，不抛错）
async function getFavoritesData(db, request) {
  try {
    if (!db) return { loggedIn: false, note: '收藏服务暂不可用（数据库未绑定）' };
    const userId = await verifySession(db, request);
    if (!userId) return { loggedIn: false, note: '用户未登录，无法查询收藏' };
    const results = await db
      .prepare('SELECT item_id, item_data, saved_at FROM favorites WHERE user_id = ? ORDER BY saved_at DESC')
      .bind(userId)
      .all();
    const favorites = (results.results || []).map(row => {
      try {
        const item = JSON.parse(row.item_data);
        return {
          id: item.id || row.item_id,
          title: item.title || '',
          type: item.type || '',
          date: item.date || '',
          savedAt: row.saved_at,
        };
      } catch (_) {
        return null;
      }
    }).filter(x => x && x.title);
    return { loggedIn: true, favorites, count: favorites.length };
  } catch (_) {
    // 收藏查询失败消化为提示，绝不 500
    return { loggedIn: false, note: '收藏查询暂时失败' };
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
  const { messages = [], items = [] } = payload || {};
  const bodyItems = (Array.isArray(items) ? items : []).slice(0, MAX_BODY_ITEMS);

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

  // ===== 站内检索工具：模型运行时自主调用，数据全部来自本站（TMDB代理/新闻池/当前页条目）=====
  const searchItems = tool({
    description: '在本站条目（电影、电视剧、综艺、动漫、纪录片、短剧、影视资讯）中按关键词搜索，返回匹配条目标题、类型与站内链接。用户找片、问类型、问片名、查站内有没有某部作品、问最近有什么可看时，必须先调用本工具再回答。',
    inputSchema: z.object({
      query: z.string().describe('搜索关键词：片名、演员名、类型词（如科幻/悬疑/喜剧）或主题词，尽量简短'),
      limit: z.number().min(1).max(10).optional().default(5),
    }),
    execute: async ({ query, limit }) => {
      try {
        const q = String(query || '').trim().slice(0, 30);
        if (!q) return { count: 0, items: [] };
        const perSource = Math.max(4, limit);

        // 类型词 → discover；否则文本搜索（并行三源）
        const genreHit = GENRE_ZH.find(g => q.includes(g.key));
        const tmdbTask = !env.TMDB_API_KEY
          ? Promise.resolve([])
          : genreHit
            ? tmdbGenreDiscover(genreHit, perSource, env.TMDB_API_KEY)
            : tmdbTextSearch(q, perSource, env.TMDB_API_KEY);

        const [tmdbHits, newsHits, bodyHits] = await Promise.all([
          tmdbTask,
          searchNewsPool(q, perSource),
          Promise.resolve(searchBodyItems(bodyItems, q, perSource)),
        ]);

        // 合并去重（按标题）：当前页条目优先，其次 TMDB，最后资讯
        const seen = new Set();
        const merged = [];
        for (const it of [...bodyHits, ...tmdbHits, ...newsHits]) {
          const key = String(it.title || '').trim();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          merged.push({ ...it, typeLabel: TYPE_LABEL[it.type] || it.type || '条目' });
          if (merged.length >= limit) break;
        }
        return { count: merged.length, items: merged };
      } catch (_) {
        // 工具异常绝不冒泡导致整请求 500
        return { count: 0, items: [], error: '检索暂时不可用' };
      }
    },
  });

  // ===== 收藏工具：查当前登录用户的 D1 收藏（策略B，个性化推荐数据源） =====
  const getFavorites = tool({
    description: '获取当前用户在本站的收藏列表（真实收藏数据，存于 D1 数据库）。用户问「我的收藏」「我标记过的片」「我收藏的有哪些」「根据我的收藏推荐」等问题时调用本工具。可选传关键词过滤收藏标题。未登录时返回提示，应引导用户先登录。',
    inputSchema: z.object({
      keyword: z.string().optional().describe('可选：按关键词过滤收藏标题（如类型词、片名片段）'),
    }),
    execute: async ({ keyword }) => {
      try {
        const data = await getFavoritesData(env.DB, request);
        if (!data.loggedIn) {
          return { loggedIn: false, note: data.note, hint: '引导用户登录后再查收藏' };
        }
        const kw = String(keyword || '').toLowerCase().trim();
        let favorites = data.favorites;
        if (kw) {
          favorites = favorites.filter(f => String(f.title).toLowerCase().includes(kw) || String(f.type).toLowerCase().includes(kw));
        }
        return {
          loggedIn: true,
          count: favorites.length,
          totalCount: data.count,
          favorites: favorites.slice(0, MAX_FAV_RETURN).map(f => ({
            ...f,
            typeLabel: TYPE_LABEL[f.type] || f.type || '条目',
          })),
        };
      } catch (_) {
        // 工具异常绝不冒泡导致整请求 500
        return { loggedIn: false, note: '收藏查询暂时失败', hint: '请稍后再试' };
      }
    },
  });

  // ===== 流式生成 + UIMessage SSE（tools 双通道都挂，stopWhen 防 tool 死循环）=====
  const result = streamText({
    model,
    system: STATION_ASSISTANT_SYSTEM,
    messages: modelMessages,
    temperature: 0.7,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
    tools: { searchItems, getFavorites },
    stopWhen: stepCountIs(5),
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
