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
const MAX_BODY_ITEMS = 120;   // 策略A：前端携带条目上限（时间线全量约百条，短字段开销可接受）

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

// 通用 TMDB 列表端点（now_playing / upcoming / on_the_air / trending 均返回 {results}）
async function tmdbList(path, mediaType, limit, key) {
  try {
    const r = await fetch(
      `https://api.themoviedb.org/3${path}?api_key=${key}&language=zh-CN&page=1`,
      { signal: AbortSignal.timeout(TMDB_TIMEOUT_MS) }
    );
    if (!r.ok) return [];
    const j = await r.json();
    const out = [];
    for (const it of j.results || []) {
      // trending 端点自带 media_type；列表端点 media_type 由参数指定
      const mt = it.media_type === 'movie' || it.media_type === 'tv' ? it.media_type : mediaType;
      const item = normTmdbItem(it, mt);
      if (item && item.date) out.push(item);
      if (out.length >= limit) break;
    }
    return out;
  } catch (_) {
    return [];
  }
}

// 时效浏览「最近上映」：在映电影 + 待映电影 + 热播剧集，合并按日期倒序
async function tmdbLatest(limit, key) {
  const per = Math.ceil(limit / 2) + 2;
  const [now, upcoming, onAir] = await Promise.all([
    tmdbList('/movie/now_playing', 'movie', per, key),
    tmdbList('/movie/upcoming', 'movie', per, key),
    tmdbList('/tv/on_the_air', 'tv', per, key),
  ]);
  const seen = new Set();
  return [...now, ...upcoming, ...onAir]
    .filter(x => { if (seen.has(x.id)) return false; seen.add(x.id); return true; })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

// 热门浏览「有什么好看的」：本周趋势电影+剧集（每周更新，天然不固定）
async function tmdbTrending(limit, key) {
  const per = Math.ceil(limit / 2) + 2;
  const [movies, tvs] = await Promise.all([
    tmdbList('/trending/movie/week', 'movie', per, key),
    tmdbList('/trending/tv/week', 'tv', per, key),
  ]);
  const seen = new Set();
  return [...movies, ...tvs].filter(x => {
    if (seen.has(x.id)) return false;
    seen.add(x.id);
    return true;
  });
}

// body items（站内时间线快照）统一映射为工具返回格式
function normBodyItem(it) {
  if (!it || !it.title) return null;
  return {
    id: String(it.id || ''),
    title: String(it.title).replace(/^《|》$/g, ''),
    type: String(it.type || ''),
    date: String(it.date || ''),
    url: stationUrl(String(it.title).replace(/^《|》$/g, '')),
  };
}

// 站内时间线·最近：按日期倒序（这就是「站内最近上了什么」最权威的答案）
function bodyLatest(items, limit) {
  return items.map(normBodyItem).filter(Boolean)
    .filter(x => x.date)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);
}

// 站内时间线·逛一逛：洗牌抽样，避免每次都推荐同样几部
function bodyShuffle(items, limit) {
  const pool = items.map(normBodyItem).filter(Boolean);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, limit);
}

// 合并两组并按标题去重（a 组优先），满 limit 即止
function mergeDedup(a, b, limit) {
  const seen = new Set();
  const out = [];
  for (const x of [...a, ...b]) {
    const key = String(x.title || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...x, typeLabel: TYPE_LABEL[x.type] || x.type || '条目' });
    if (out.length >= limit) break;
  }
  return out;
}

// ===== 浏览意图兜底判别：模型没显式传 intent 或把泛问题压成了无信息量 query 时，由代码纠偏 =====
const LATEST_WORDS = ['最近', '最新', '近期', '上新', '刚上', '新上', '这段时间', '这阵', '新片', '刚上映', '上映了'];
const POPULAR_WORDS = ['热门', '好看', '推荐', '值得看', '可看', '来点', '火爆', '高分', '必看', '受欢迎', '口碑', '经典'];
const BARE_NOUNS = ['电影', '影片', '电视剧', '纪录片', '综艺', '动漫', '动画', '短剧', '影视', '作品', '剧', '片'];
function detectIntent(intent, q) {
  if (intent === 'latest' || intent === 'popular' || intent === 'search') return intent;
  if (!q) return 'popular'; // 空手逛：默认热门
  if (GENRE_ZH.some(g => q.includes(g.key))) return 'search'; // 含明确类型词 → 关键词检索
  if (LATEST_WORDS.some(w => q.includes(w))) return 'latest';
  if (POPULAR_WORDS.some(w => q.includes(w))) return 'popular';
  // 剥离裸类别词和疑问虚词后若没有实际语料（如「有什么电影」「片子」），按热门逛处理
  let rest = q;
  for (const w of [...BARE_NOUNS].sort((a, b) => b.length - a.length)) rest = rest.split(w).join('');
  rest = rest.replace(/[\s的有什么了吗呢啊吧呀？?！!、，,。.\/]+/g, '');
  return rest ? 'search' : 'popular';
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

// 策略A：前端当前页条目内检索（标题统一剥书名号，与浏览通道格式一致）
function searchBodyItems(items, query, limit) {
  const q = String(query).toLowerCase().trim();
  const out = [];
  for (const it of items) {
    const rawTitle = String(it.title || '');
    const bareTitle = rawTitle.replace(/^《|》$/g, '');
    const summary = String(it.summary || '');
    if (bareTitle.toLowerCase().includes(q) || rawTitle.toLowerCase().includes(q) || summary.toLowerCase().includes(q)) {
      out.push({
        id: String(it.id || ''),
        title: bareTitle,
        type: String(it.type || ''),
        date: String(it.date || ''),
        url: stationUrl(bareTitle),
      });
      if (out.length >= limit) break;
    }
  }
  return out;
}

// ===== getItemById：按 id 查条目详情（追问场景） =====
// id 三种形态：tmdb-movie-<id> / tmdb-tv-<id>（TMDB 详情）、news-<url尾部32字符>（新闻池按url尾部匹配）、
// 其他 = 策略A body items 的原始 id（含空 id 兜底按标题跳站内搜索）
const MAX_OVERVIEW = 200; // 详情简介截断（防超上下文）

// TMDB 单条详情：标题/日期/评分/类型/简介
async function tmdbDetail(tmdbId, mediaType, key) {
  try {
    const r = await fetch(
      `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${key}&language=zh-CN`,
      { signal: AbortSignal.timeout(TMDB_TIMEOUT_MS) }
    );
    if (!r.ok) return null;
    const j = await r.json();
    const title = mediaType === 'movie' ? (j.title || j.original_title) : (j.name || j.original_name);
    if (!title) return null;
    return {
      id: `tmdb-${mediaType}-${tmdbId}`,
      title,
      type: mediaType === 'movie' ? 'movie' : 'drama',
      date: mediaType === 'movie' ? (j.release_date || '') : (j.first_air_date || ''),
      rating: j.vote_count ? Number((j.vote_average || 0).toFixed(1)) : null,
      voteCount: j.vote_count || 0,
      genres: (j.genres || []).map(g => g.name).filter(Boolean).join(' / '),
      overview: String(j.overview || '').trim().slice(0, MAX_OVERVIEW),
      url: stationUrl(title),
    };
  } catch (_) {
    return null;
  }
}

// 新闻池按 url 尾部匹配（searchNewsPool 生成的 id = 'news-' + url 后 32 字符）
async function newsDetailById(id, limit = 30) {
  try {
    const timer = new Promise(resolve => setTimeout(() => resolve(null), POOL_TIMEOUT_MS));
    const result = await Promise.race([buildNewsPool(), timer]);
    if (!result || !Array.isArray(result.pool)) return null;
    const tail = String(id).replace(/^news-/, '');
    for (const n of result.pool.slice(0, 100)) {
      if (String(n.url || '').slice(-32) === tail) {
        return {
          id,
          title: n.title,
          type: 'news',
          date: n.ts ? new Date(n.ts).toISOString().slice(0, 10) : '',
          source: n.source || '',
          summary: String(n.summary || '').slice(0, MAX_OVERVIEW),
          url: n.url || stationUrl(n.title),
        };
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}

// getItemById 总入口：按 id 前缀分发到 TMDB / 新闻池 / body items；查不到返回 null（模型会明说没有）
async function getItemByIdData(id, env, bodyItems) {
  const raw = String(id || '').trim();
  if (!raw) return null;

  const tmdbM = raw.match(/^tmdb-(movie|tv)-(\d+)$/);
  if (tmdbM && env.TMDB_API_KEY) {
    return tmdbDetail(tmdbM[2], tmdbM[1], env.TMDB_API_KEY);
  }
  if (raw.startsWith('news-')) {
    return newsDetailById(raw);
  }
  // 策略A body items：按 id 精确匹配（id 可能为空串则跳过）
  if (raw && bodyItems.length) {
    const hit = bodyItems.find(it => String(it.id || '') === raw && it.title);
    if (hit) {
      return {
        id: raw,
        title: String(hit.title),
        type: String(hit.type || ''),
        date: String(hit.date || ''),
        summary: String(hit.summary || '').slice(0, MAX_OVERVIEW),
        url: stationUrl(hit.title),
      };
    }
  }
  return null;
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

  // 历史裁剪 + 输入长度护栏：保留文本 + 已完成的 tool parts（追问场景模型要靠上一轮工具结果里的 id 调 getItemById；
  // convertToModelMessages 会把 output-available 的 tool part 转成 tool-call/tool-result）
  const slimToolPart = p => ({
    type: p.type,
    toolCallId: String(p.toolCallId || ''),
    state: 'output-available',
    input: p.input,
    output: p.output,
  });
  const trimmed = (Array.isArray(messages) ? messages : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
    .slice(-MAX_MSGS)
    .map(m => ({
      id: m.id,
      role: m.role,
      parts: (Array.isArray(m.parts) ? m.parts : [])
        .filter(p => p && (
          (p.type === 'text' && p.text && String(p.text).trim()) ||
          (typeof p.type === 'string' && p.type.startsWith('tool-') && p.state === 'output-available' && p.output != null && p.toolCallId)
        ))
        .map(p => p.type === 'text'
          ? { type: 'text', text: String(p.text).slice(0, m.role === 'user' ? MAX_USER_INPUT : 4000) }
          : slimToolPart(p)),
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
    description: '在本站条目（电影、电视剧、综艺、动漫、纪录片、短剧、影视资讯）中检索，返回匹配条目标题、类型、上映日期与站内链接。找片、查片、问最近上什么、问有什么好看的都调用本工具。',
    inputSchema: z.object({
      intent: z.enum(['search', 'latest', 'popular']).optional().describe(
        '检索意图：latest=最近/最新/近期上映上新；popular=热门/好看/推荐/有什么可看（无具体目标地逛）；search=有明确片名、演员名或类型词。拿不准可省略由系统判别'
      ),
      query: z.string().optional().describe('intent=search 时必填：片名、演员名、类型词（如科幻/悬疑/喜剧）或主题词，尽量简短；latest/popular 时留空'),
      limit: z.number().min(1).max(10).optional().default(5),
    }),
    execute: async ({ intent, query, limit }) => {
      try {
        const q = String(query || '').trim().slice(0, 30);
        const useIntent = detectIntent(intent, q);

        // ===== 浏览通道：不做关键词匹配，直接按时效/热度取站内时间线，TMDB 补位 =====
        if (useIntent === 'latest' || useIntent === 'popular') {
          if (!env.TMDB_API_KEY) {
            const items = useIntent === 'latest' ? bodyLatest(bodyItems, limit) : bodyShuffle(bodyItems, limit);
            return { intent: useIntent, count: items.length, items: items.map(x => ({ ...x, typeLabel: TYPE_LABEL[x.type] || x.type || '条目' })) };
          }
          const bodyN = Math.min(limit, Math.max(3, Math.ceil(limit * 0.6))); // 站内时间线占六成，保证回答「站里的」内容
          const bodyPart = useIntent === 'latest' ? bodyLatest(bodyItems, bodyN) : bodyShuffle(bodyItems, bodyN);
          const tmdbPart = useIntent === 'latest'
            ? await tmdbLatest(limit, env.TMDB_API_KEY)
            : await tmdbTrending(limit, env.TMDB_API_KEY);
          const merged = useIntent === 'latest'
            ? mergeDedup(bodyPart, tmdbPart, limit).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
            : mergeDedup(bodyPart, tmdbPart, limit);
          return { intent: useIntent, count: merged.length, items: merged };
        }

        // ===== 关键词检索通道：类型词 → discover；否则三源并行文本匹配 =====
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
        const merged = mergeDedup([...bodyHits, ...tmdbHits], newsHits, limit);
        return { intent: 'search', count: merged.length, items: merged };
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

  // ===== 详情工具：按 id 查单条详情（追问场景，如「那第一部讲什么」「评分多少」） =====
  const getItemById = tool({
    description: '根据条目 id 获取单条详情（标题、日期、评分、类型、简介）。用户在看到推荐结果后追问「这部讲什么」「第一部的评分/年份/详细介绍」「展开说说某一条」时调用本工具，id 来自 searchItems 或 getFavorites 返回结果里的 id 字段。查不到返回 null。',
    inputSchema: z.object({
      id: z.string().describe('条目 id，来自之前工具返回结果中的 id 字段（如 tmdb-movie-123、news-xxx）'),
    }),
    execute: async ({ id }) => {
      try {
        const item = await getItemByIdData(id, env, bodyItems);
        if (!item) return null; // 查不到返回 null，模型会明说没有
        return { ...item, typeLabel: TYPE_LABEL[item.type] || item.type || '条目' };
      } catch (_) {
        // 工具异常绝不冒泡导致整请求 500
        return null;
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
    tools: { searchItems, getFavorites, getItemById },
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
