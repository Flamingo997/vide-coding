// 全站 AI 助手：站内条目检索 + 流式问答（UIMessage SSE）
// 前端：chat-island.js 全站模式（右下角圆形按钮）经 DefaultChatTransport 调本端点
// 请求体：{ messages: UIMessage[], items?: [{id,title,type,date?,summary?}] }
//   items = 策略A：前端当前页条目（≤50），searchItems 在这批 + TMDB + 服务端新闻池 中检索
// Tool：searchItems 由模型运行时自主调用（真 tool calling），返回站内真实条目；任何异常消化为空结果，绝不 500
import { streamText, generateText, convertToModelMessages, toUIMessageStream, createUIMessageStream, createUIMessageStreamResponse, tool, stepCountIs } from 'ai';
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
const TMDB_TIMEOUT_MS = 7000; // TMDB 单次请求超时（工具内部会重试一次，该源整体失败时不阻塞工具）
const POOL_TIMEOUT_MS = 6000; // 新闻池构建超时（走 CF 边缘缓存，冷启动兜底）

// TMDB GET 统一入口：失败重试 1 次 + isolate 内存缓存（默认 30min）。
// 关键：只缓存 cacheIf 谓词通过（业务非空）的响应——TMDB 搜索后端偶发返回 200+空 results，
// 这种「假空」绝不能被缓存（之前用 cf.cacheEverything 会把空结果钉在边缘节点 1 小时，
// 导致该节点用户稳定「搜啥都没有」）。两次请求都失败返回 null，调用方据此区分瞬态与真空。
const TMDB_MEM_TTL = 30 * 60000;
const TMDB_MEM_MAX = 200;
const tmdbMem = new Map(); // url -> { at, json }
function tmdbMemGet(url) {
  const hit = tmdbMem.get(url);
  if (hit && Date.now() - hit.at < TMDB_MEM_TTL) return hit.json;
  if (hit) tmdbMem.delete(url);
  return undefined;
}
function tmdbMemSet(url, json) {
  if (tmdbMem.size >= TMDB_MEM_MAX) tmdbMem.delete(tmdbMem.keys().next().value);
  tmdbMem.set(url, { at: Date.now(), json });
}
async function tmdbGetJson(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || TMDB_TIMEOUT_MS;
  const cacheIf = opts.cacheIf || null;
  const cached = tmdbMemGet(url);
  if (cached !== undefined) return cached;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) {
        const j = await r.json();
        if (!cacheIf || cacheIf(j)) tmdbMemSet(url, j);
        return j;
      }
    } catch (_) {}
  }
  return null;
}
const tmdbNonEmpty = j => Array.isArray(j?.results) && j.results.length > 0;
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

// TMDB 文本搜索（片名/人名/主题词）：multi/movie/tv 三端点并行冗余。
// 背景：单一 multi 端点偶发「200+空 results」或超时，一个端点抽风不该让整部片「消失」。
// 语义：任一端点有命中 → 合并按 tmdb id 去重（multi 相关性排序在前）；
//      三端点全部成功但全空 → []（真空）；只要有端点请求失败且整体无命中 → null（证据不足=瞬态）
async function tmdbTextSearch(query, limit, key) {
  const enc = encodeURIComponent(query);
  const base = `api_key=${key}&language=zh-CN&query=${enc}&include_adult=false&page=1`;
  const opt = { cacheIf: tmdbNonEmpty };
  const [multiJ, movieJ, tvJ] = await Promise.all([
    tmdbGetJson(`https://api.themoviedb.org/3/search/multi?${base}`, opt),
    tmdbGetJson(`https://api.themoviedb.org/3/search/movie?${base}`, opt),
    tmdbGetJson(`https://api.themoviedb.org/3/search/tv?${base}`, opt),
  ]);
  if (multiJ === null && movieJ === null && tvJ === null) return null;

  const out = [];
  const seen = new Set();
  const push = (it, mediaType) => {
    const item = normTmdbItem(it, mediaType);
    if (item && !seen.has(item.id)) {
      seen.add(item.id);
      out.push(item);
    }
  };
  for (const it of multiJ?.results || []) {
    if (it.media_type === 'movie' || it.media_type === 'tv') push(it, it.media_type);
  }
  for (const it of movieJ?.results || []) push(it, 'movie');
  for (const it of tvJ?.results || []) push(it, 'tv');

  if (!out.length && (multiJ === null || movieJ === null || tvJ === null)) return null;
  return out.slice(0, limit);
}

// TMDB 类型发现（中文类型词 → discover，2023 年以来按热度）
// 两源全部抖动失败返回 null（瞬态）；只要有一源成功即返回数组（可能为空）
async function tmdbGenreDiscover(genre, limit, key) {
  const out = [];
  const want = Math.ceil(limit / 2);
  const tasks = [];
  if (genre.movie) {
    tasks.push(tmdbGetJson(
      `https://api.themoviedb.org/3/discover/movie?api_key=${key}&language=zh-CN&with_genres=${genre.movie}` +
      `&sort_by=popularity.desc&primary_release_date.gte=2023-01-01&include_adult=false&page=1`,
      { cacheIf: tmdbNonEmpty }
    ).then(j => ({ j, mediaType: 'movie' })));
  }
  if (genre.tv) {
    // 竖线 = OR（逗号是 AND 会查空）；剧集类型结果不足时用 18（剧情）兜底保证数量
    const tvGenre = genre.key === '综艺' ? '10764|10767' : `${genre.tv}|18`;
    tasks.push(tmdbGetJson(
      `https://api.themoviedb.org/3/discover/tv?api_key=${key}&language=zh-CN&with_genres=${tvGenre}` +
      `&sort_by=popularity.desc&first_air_date.gte=2023-01-01&include_adult=false&page=1`,
      { cacheIf: tmdbNonEmpty }
    ).then(j => ({ j, mediaType: 'tv' })));
  }
  const results = await Promise.all(tasks);
  if (results.length && results.every(r => !r?.j)) return null;
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
// 浏览通道的补位源：失败返回 []（主源是站内时间线，不阻断）；统一入口自带重试+内存缓存
async function tmdbList(path, mediaType, limit, key) {
  const j = await tmdbGetJson(
    `https://api.themoviedb.org/3${path}?api_key=${key}&language=zh-CN&page=1`,
    { cacheIf: tmdbNonEmpty }
  );
  if (!j) return [];
  const out = [];
  for (const it of j.results || []) {
    // trending 端点自带 media_type；列表端点 media_type 由参数指定
    const mt = it.media_type === 'movie' || it.media_type === 'tv' ? it.media_type : mediaType;
    const item = normTmdbItem(it, mt);
    if (item && item.date) out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

// 时效浏览「最近上映」：在映电影 + 待映电影 + 热播剧集，合并按日期倒序
// 近 270 天窗口：now_playing 含长线在映的老片（可能是一年前上映），补位也要保证「最近」语义
async function tmdbLatest(limit, key) {
  const per = Math.ceil(limit / 2) + 2;
  const floor = new Date(Date.now() - 270 * 86400000).toISOString().slice(0, 10);
  const [now, upcoming, onAir] = await Promise.all([
    tmdbList('/movie/now_playing', 'movie', per, key),
    tmdbList('/movie/upcoming', 'movie', per, key),
    tmdbList('/tv/on_the_air', 'tv', per, key),
  ]);
  const seen = new Set();
  return [...now, ...upcoming, ...onAir]
    .filter(x => x.date && x.date >= floor)
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

// 合并两组并按标题去重（a 组优先），满 limit 即止。
// 特例：a 组里的票房桩条目没有 id、只带票房摘要（查不到详情），同名 TMDB 富条目（tmdb- 前缀、
// 可取完整简介）后到时替换桩条目——否则模型拿着空 id 调 getItemById 只能回复「查不到剧情」
function mergeDedup(a, b, limit) {
  const indexByTitle = new Map();
  const out = [];
  const decorate = x => ({ ...x, typeLabel: TYPE_LABEL[x.type] || x.type || '条目' });
  const isRichDetail = x => String(x.id || '').startsWith('tmdb-');
  for (const x of [...a, ...b]) {
    const key = String(x.title || '').trim();
    if (!key) continue;
    const pos = indexByTitle.get(key);
    if (pos === undefined) {
      if (out.length >= limit) { indexByTitle.set(key, -1); continue; }
      indexByTitle.set(key, out.length);
      out.push(decorate(x));
    } else if (pos >= 0 && !String(out[pos].id || '') && isRichDetail(x)) {
      out[pos] = decorate(x);
    }
  }
  return out;
}

// ===== query 清洗：弱模型有时把整句口语当 query（如「请你告诉我奥德赛讲了什么」），
// 整句发给 TMDB 文本搜索必然落空。服务端统一剥掉客套前缀/疑问尾巴，只留核心检索词 =====
// 前缀两层（动词短语一律 ≥2 字，绝不匹配单字「说/讲/聊/找/查/搜」——真片名可能以这些字开头，
// 如《找到你》《说唱新世代》，单字动词会把片名首字咬掉）：
//   PREFIX = 「引导词+动词」的完整客套（如 请你告诉我/帮我查查/介绍一下）；
//   LEAD   = 单独出现的纯引导词（如「请问X」——引导词命中但后面没接动词的形态）。
//   LEAD 只收录不会成为片名开头的词（你好/给我 不收：《你好李焕英》《给我一支烟》是真片名开头）；
//   2 轮循环让组合前缀可以接力剥（「跟我聊聊X」→第 1 轮剥「跟我」→第 2 轮剥「聊聊」）
const QUERY_PREFIX_RE = /^(?:请你?|麻烦你?|你好|您好|想问(一下|下|问)?|想知道|想看看?|帮我|帮忙|给我|请问)?(?:告诉我|跟我说说|跟我|说说|聊聊|聊一下|介绍(一下)?|讲讲|讲一下|讲下|说下|说一下|搜索|搜一搜|搜一下|查查|查一查|查一下|找找|找一找|找一下|找几部|推荐几部|推荐)/;
const QUERY_LEAD_RE = /^(?:请你|麻烦你|请问|帮我|帮忙|想知道|想问(一下|下|问)?|想看看?)/;
// 顺序敏感：长尾巴在前（「讲的是什么」先于「是什么」）
const QUERY_SUFFIXES = [
  '讲的是什么', '讲了什么', '讲的啥', '讲什么', '讲啥', '说了什么', '是什么电影', '是什么剧',
  '是什么', '是啥', '剧情简介', '剧情介绍', '故事情节', '内容简介', '故事梗概', '讲的故事',
  // 演员类尾巴（问「谁演的/有哪些演员」）：长的在前，防「有哪些」先咬掉「演员」
  '有哪些演员', '有哪些主演', '演员有哪些', '主演有哪些', '主演是谁', '演员是谁', '是谁演的', '是谁主演的', '谁主演的', '谁演的',
  '演员阵容', '演员名单', '演职员表', '演职员', '的演员', '的主演', '有哪些', '是谁',
  '主演', '演员', '阵容',
  '好看吗', '值得看吗', '好不好看', '怎么样', '咋样', '如何', '这部片子', '这部电影', '这部片', '这部剧', '这部',
  '剧情', '简介', '详细介绍', '介绍', '详情', '资料',
  '的电影', '的影片', '的电视剧', '的纪录片', '的综艺', '的动漫', '的动画', '的短剧', '的片子',
  '电影', '影片', '电视剧', '纪录片', '综艺', '动漫', '动画', '短剧',
  '的吗', '好吗', '行吗', '吗', '呢', '啊', '吧', '呀', '么',
];
// 剥书名号/引号包裹与结尾疑问叹号（保留片名内部标点：·—：等，删了会搜不到）
const stripWraps = q => String(q || '').replace(/^[《「“"']+/, '').replace(/[》」”"']+[？?！!]*$/, '').replace(/[？?！!]+$/, '').trim();
// 泛资讯问法（「影视资讯/影讯/新闻」等无具体关键词的）：新闻标题几乎不含这些泛词，子串匹配必空。
// 统一改走「按时间倒序给最新资讯」，且这类查询对片库做文本检索也无意义，一并跳过
const GENERIC_NEWS_RE = /^(?:最[新近]|近期)?的?(?:影视|电影|娱乐)?(?:资讯|新闻|影讯|消息|动态)[?？!！。]*$/;
function cleanSearchQuery(raw) {
  const rawStr = String(raw || '').trim().slice(0, 30);
  let q = stripWraps(rawStr);
  for (let round = 0; round < 2 && q; round++) {
    const before = q;
    q = q.replace(QUERY_PREFIX_RE, '').replace(QUERY_LEAD_RE, '');
    let stripped = q !== before;
    let grown = true;
    while (grown && q) {
      grown = false;
      for (const tail of QUERY_SUFFIXES) {
        // 必须还剩内容才剥，避免把唯一的类别词（如「动漫」）剥光
        if (q.length > tail.length && q.endsWith(tail)) {
          q = q.slice(0, q.length - tail.length);
          grown = true;
          stripped = true;
        }
      }
    }
    // 「的」只在本轮确实剥掉过客套/尾词时才作为连接虚词剥掉（「早春晴朗的简介」→「早春晴朗」）。
    // 无剥除时保留原样：真片名可能以「的」结尾（如《说唱听我的》），无条件剥会咬掉片名尾字
    if (stripped && q.length > 1 && q.endsWith('的')) q = q.slice(0, -1);
    if (q === before) break;
  }
  q = stripWraps(q);
  if (q) return q;
  // 前缀全剥光（如 query 恰好是《搜索》这类与动词同形的片名）：退化为只剥尾词再试一次
  const tailOnly = stripWraps(rawStr);
  for (const tail of QUERY_SUFFIXES) {
    if (tailOnly.length > tail.length && tailOnly.endsWith(tail)) {
      const cut = stripWraps(tailOnly.slice(0, tailOnly.length - tail.length));
      if (cut) return cut;
    }
  }
  return '';
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
    // 泛资讯问法不做子串匹配（引导问题「最近有哪些影视资讯？」就走这条路），直接按时间倒序返回最新资讯
    const genericNews = GENERIC_NEWS_RE.test(q);
    const hits = genericNews
      ? result.pool.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, limit)
      : result.pool
        .filter(n => {
          const t = String(n.title || '').toLowerCase();
          const s = String(n.summary || '').toLowerCase();
          return t.includes(q) || s.includes(q);
        })
        .slice(0, limit);
    return hits.map(n => ({
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

// TMDB 单条详情：标题/日期/评分/类型/简介（统一入口重试+内存缓存；失败/查无均返回 null）
async function tmdbDetail(tmdbId, mediaType, key) {
  const j = await tmdbGetJson(
    `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${key}&language=zh-CN`,
    { cacheIf: x => !!(x && (x.title || x.name)) }
  );
  if (!j) return null;
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
}

// TMDB 演职员表：按条目 id 取前 12 位演员（与 /api/credits 端点同源同参）。
// 统一入口自带重试 + 内存缓存（只缓存非空 cast，真空不缓存）；整体失败返回 null（瞬态），空阵容返回 []
const MAX_CAST_NAMES = 12;
const castNonEmpty = j => Array.isArray(j?.cast) && j.cast.some(c => c && c.name);
async function tmdbCastNames(tmdbId, mediaType, key) {
  const j = await tmdbGetJson(
    `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/credits?api_key=${key}&language=zh-CN`,
    { cacheIf: castNonEmpty }
  );
  if (!j) return null;
  return (j.cast || []).slice(0, MAX_CAST_NAMES).map(c => String(c.name || '').trim()).filter(Boolean);
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

  // ===== 意图识别 + 历史污染防护（convertToModelMessages 之前，castAsk 需要净化送模消息）=====
  const partIsEmptySearch = p => !!p
    && String(p.type || '') === 'tool-searchItems'
    && p.state === 'output-available'
    && p.output && typeof p.output === 'object'
    && (p.output.count === 0 || p.output.transient === true || !!p.output.error);
  const historyPoisoned = msgs => msgs.some(m =>
    m.role === 'assistant' && Array.isArray(m.parts) && m.parts.some(partIsEmptySearch));
  const lastUserText = [...trimmed].reverse().find(m => m.role === 'user')?.parts
    .filter(p => p.type === 'text').map(p => String(p.text || '')).join(' ') || '';
  const favoritesLike = /收藏|标记过|标记的|我喜欢|点赞/.test(lastUserText);
  const forceFreshSearch = historyPoisoned(trimmed) && !favoritesLike;
  // 演员类问题识别（问「某片的演员/谁演的」），必须与「用演员名搜片」区分：
  // 「沈腾主演的电影有哪些」是搜片意图，不能锁演员表链。命中模式：疑问词（谁演/谁主演/主演是谁）、
  // 「的演员/的主演」、演员/阵容类词结尾的问句
  const castAsk = /谁演|谁主演|的演员|的主演|演员名单|演员表|演员阵容|主演名单|演职员|主演是谁|演员是谁|有哪些演员|有哪些主演|(?:演员|主演|阵容)[？?。！!]*$/.test(lastUserText);
  const castFresh = castAsk && !favoritesLike;

  // 演员类问题的送模消息净化：剥离历史中全部工具 part、只保留文本轮次。
  // 两个实测原因：① 早期失败轮的空工具结果/「漏调工具下的错误文字结论」会诱导模型复读「查不到演员」；
  // ② 更硬的坑——历史里已带 searchItems 的 tool_call/result 时，step0 再强制 toolChoice=searchItems，
  // DeepSeek 兼容接口直接 400/500（start 后零帧即 error；二者单独存在都不报错，组合必现）。
  // 剥离后保留用户/助手文本以支撑「那第一部谁演的」这类代词追问；空 parts 消息整条丢弃，
  // 最后一条 user 必在（原始 trimmed 已保证）。真实阵容由下方 prepareStep 强制的新鲜工具链重新取得。
  const feedMessages = castFresh
    ? trimmed
      .map(m => (m.role === 'assistant'
        ? { ...m, parts: m.parts.filter(p => p.type === 'text') }
        : m))
      .filter(m => m.parts.length)
    : trimmed;
  const modelMessages = await convertToModelMessages(feedMessages);

  // 先建 SSE 流再干活：与 news-chat/news-tweet 同一保活模式。
  // 本站助手有两个无帧空窗会被脆弱代理掐断（实测 Failed to fetch）：
  //  ① 冷 isolate 时 DeepSeek 探针 4s await 在返回 Response 之前（实测 TTFB 3s+）；
  //  ② searchItems 工具执行期间 TMDB 三端点重试最坏 ~14s 完全静默（tool call 已输出、result 未回）。
  // createUIMessageStream 的 execute 在流拉起时即执行、响应头秒下发；无 messageId 的 start 帧
  // 客户端解析器是 noop（幂等），每 5s 一帧覆盖所有空窗，直到子流读完
  const outerStream = createUIMessageStream({
    onError: e => '生成失败：' + (e?.message || '未知错误，请重试'),
    execute: async ({ writer }) => {
      writer.write({ type: 'start' });
      const keepAlive = setInterval(() => {
        try { writer.write({ type: 'start' }); } catch (_) {}
      }, 5000);
      try {
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
    throw new Error('DeepSeek 跨境不通且未配置 Workers AI 降级通道');
  }

  // ===== 站内检索工具：模型运行时自主调用，数据全部来自本站（TMDB代理/新闻池/当前页条目）=====
  // 请求级单次锁：弱模型有时一轮里换参数连调两次 searchItems，两批结果不同会让它自我否定、
  // 拼出两段回答。第二次调用直接返回首次结果并指令其停手（getItemById/getFavorites 不受限）
  let searchOnce = null;
  const searchItems = tool({
    description: '在本站条目（电影、电视剧、综艺、动漫、纪录片、短剧、影视资讯）中检索，返回匹配条目标题、类型、上映日期与站内链接。找片、查片、问最近上什么、问有什么好看的都调用本工具。',
    inputSchema: z.object({
      intent: z.enum(['search', 'latest', 'popular']).optional().describe(
        '检索意图：latest=最近/最新/近期上映上新；popular=热门/好看/推荐/有什么可看（无具体目标地逛）；search=有明确片名、演员名、类型词，或用户想看影视资讯/影讯/新闻动态。拿不准可省略由系统判别'
      ),
      query: z.string().optional().describe('intent=search 时必填：片名、演员名、类型词（如科幻/悬疑/喜剧）或主题词，尽量简短；latest/popular 时留空。注意：用户问「影视资讯/影讯/最近有什么新闻」时要用 intent=search 且 query 传「影视资讯」，这样才能走资讯通道拿到新闻条目'),
      exclude: z.array(z.string()).optional().describe('需要排除的片名列表：用户说「换几部/还有呢/别的」时，把上一轮已经推荐过的片名（不带书名号）传进来，本轮结果不会再包含它们'),
      limit: z.number().min(1).max(10).optional().default(5),
    }),
    execute: async ({ intent, query, exclude, limit }) => {
      try {
        // 单次锁：本轮已检索过则原样返回首次结果，杜绝换参数连调导致的两批结果+双段回答
        if (searchOnce) {
          return searchOnce.transient
            ? { ...searchOnce, note: '本轮已确认片库检索服务超时，不要再调用 searchItems（换参数重调也不会有结果），直接把超时情况与「换词/稍后再问/首页搜索框」建议转告用户' }
            : { ...searchOnce, note: '本轮已经检索过，以上 items 就是站内结果，请直接据此回答，不要再调用 searchItems' };
        }
        const seal = r => { searchOnce = r; return r; };
        // 模型可能把整句口语塞进 query（「请你告诉我奥德赛讲了什么」），先服务端剥皮取核心词；
        // 剥光（纯追问如「这部怎么样」）才回退原词。
        // 旁路：模型直接传裸片名（含《》包裹）且精确命中站内条目时跳过清洗——
        // 清洗是给口语剥皮用的，套在真片名上可能咬掉首字/尾词（如《找到你》被剥成「到你」）
        const rawQ = String(query || '').trim().slice(0, 30);
        const bareTitle = s => String(s || '').replace(/^[《「“"']+/, '').replace(/[》」”"'?？!！]+$/, '').trim();
        const q = (() => {
          const b = bareTitle(rawQ);
          if (b && bodyItems.some(it => bareTitle(it.title) === b)) return b;
          return cleanSearchQuery(rawQ) || rawQ;
        })();
        const useIntent = detectIntent(intent, q);
        // 排除集合（统一剥书名号）；各源扩量取数，过滤后再截 limit，保证排除后仍拿得满
        const excl = new Set((Array.isArray(exclude) ? exclude : [])
          .map(x => String(x || '').replace(/^《|》$/g, '').trim()).filter(Boolean));
        const dropExcluded = list => list.filter(x => x && x.title && !excl.has(String(x.title).replace(/^《|》$/g, '').trim()));
        const wantN = limit + excl.size;

        // ===== 浏览通道：不做关键词匹配，直接按时效/热度取站内时间线，TMDB 仅在站内条目不足时补位 =====
        if (useIntent === 'latest' || useIntent === 'popular') {
          const bodyPart = useIntent === 'latest' ? bodyLatest(bodyItems, wantN) : bodyShuffle(bodyItems, wantN);
          // 站内时间线足够就不再请求 TMDB（结果纯站内、省一跳）；不足才补
          let tmdbPart = [];
          if (bodyPart.length < limit && env.TMDB_API_KEY) {
            tmdbPart = useIntent === 'latest'
              ? await tmdbLatest(wantN, env.TMDB_API_KEY)
              : await tmdbTrending(wantN, env.TMDB_API_KEY);
          }
          let merged = dropExcluded(mergeDedup(bodyPart, tmdbPart, wantN)).slice(0, limit);
          if (useIntent === 'latest') {
            merged = merged.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
          }
          return seal({ intent: useIntent, count: merged.length, items: merged });
        }

        // ===== 关键词检索通道：类型词 → discover；否则三源并行文本匹配 =====
        if (!q) return seal({ count: 0, items: [] });
        const perSource = Math.max(4, wantN);

        // 类型词 → discover；否则文本搜索（并行三源）。泛资讯词对片库检索无意义（搜不出东西
        // 还会挤占合并额度把真正的资讯挤掉），跳过 TMDB，让新闻池按时间倒序供给
        const genreHit = GENRE_ZH.find(g => q.includes(g.key));
        const newsQuery = GENERIC_NEWS_RE.test(q);
        const tmdbTask = !env.TMDB_API_KEY || newsQuery
          ? Promise.resolve([])
          : genreHit
            ? tmdbGenreDiscover(genreHit, perSource, env.TMDB_API_KEY)
            : tmdbTextSearch(q, perSource, env.TMDB_API_KEY);

        const [tmdbHits, newsHits, bodyHits] = await Promise.all([
          tmdbTask,
          searchNewsPool(q, perSource),
          Promise.resolve(searchBodyItems(bodyItems, q, perSource)),
        ]);

        // 片库三个端点均重试失败（null）且站内两源（当前页条目/新闻池）也全空 → 瞬态失败。
        // 服务端已穷尽 multi/movie/tv 三端点 + 每端点两次重试，模型换参数重调没有意义，
        // 故 seal 锁定本轮，只允许向用户如实转述超时——没查到 ≠ 不存在，严禁断言「站内没有」
        if (tmdbHits === null && bodyHits.length === 0 && newsHits.length === 0) {
          return seal({
            intent: 'search',
            count: 0,
            items: [],
            transient: true,
            note: '片库检索服务刚才超时失败（服务端已重试多个片库端点），本次空结果不可信，绝不代表站内没有收录。请直接告知用户：片库查询刚才超时了，可以换个关键词（演员名/类型词）或稍后再问一次，也可以用首页搜索框直接搜「' + q + '」。禁止说「站内没有/没收录/片名记错/刚又搜了一遍没有」之类的话。',
          });
        }

        // 合并去重（按标题）：当前页条目优先，其次 TMDB，最后资讯；再剔除 exclude
        // tmdbHits 为 null（片库抖动）但站内其他源有命中时按空数组处理
        const merged = dropExcluded(mergeDedup([...bodyHits, ...(tmdbHits || [])], newsHits, wantN)).slice(0, limit);
        return seal({ intent: 'search', count: merged.length, items: merged });
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

  // ===== 演职员工具：按 id 查演员阵容（用户问「这部片谁演的/有哪些演员」时先 searchItems 拿 id 再调这里）=====
  // id 形态与站内条目一致：tmdb-(movie|docmovie)-N → /movie；tmdb-(tv|drama|anime|show)-N → /tv（站内实际只用 tv）。
  // 非 tmdb id（短剧/资讯）直接返回说明文案；任何异常消化为文案，绝不 500
  const getCredits = tool({
    description: '获取某部影视条目的演员阵容（演职员表，前 12 位演员名）。用户问「谁演的」「有哪些演员」「主演是谁」「演员阵容」时，先用 searchItems 检索该作品拿到条目 id，再把 id 传给本工具。仅支持 tmdb- 前缀条目；短剧/资讯条目没有演职员数据。',
    inputSchema: z.object({
      id: z.string().describe('条目 id，来自 searchItems/getItemById 返回结果中的 id 字段（如 tmdb-movie-123、tmdb-tv-456）'),
    }),
    execute: async ({ id }) => {
      try {
        const raw = String(id || '').trim();
        const m = raw.match(/^tmdb-([a-z]+)-(\d+)$/);
        if (!m || !env.TMDB_API_KEY) {
          return { count: 0, cast: [], note: '该条目不是影视库条目（短剧/资讯等）或演职员服务未配置：如实告知用户站内暂无这部作品的演职员资料，不要凭记忆编造演员名单' };
        }
        const mediaType = ['tv', 'drama', 'anime', 'show'].includes(m[1]) ? 'tv' : 'movie';
        const cast = await tmdbCastNames(m[2], mediaType, env.TMDB_API_KEY);
        if (cast === null) {
          return { count: 0, cast: [], transient: true, note: '演职员查询刚才超时失败，不代表没有数据：如实告知用户稍后再问，禁止断言该片没有演员信息' };
        }
        if (!cast.length) return { count: 0, cast: [], note: '该片暂无演职员数据（片库收录为空）：如实告知用户，不要凭记忆编造演员名单' };
        return { count: cast.length, cast };
      } catch (_) {
        // 工具异常绝不冒泡导致整请求 500
        return { count: 0, cast: [], note: '演职员查询暂时失败，稍后再试' };
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
    tools: { searchItems, getFavorites, getItemById, getCredits },
    // 工具调用硬约束（只作用于前两步，后续步自由生成文本；全局 toolChoice 会连文本步也锁死导致空回答）：
    // ① 演员类问题不信任历史里任何「查不到演员」的旧结论——实测过三种污染形态：空 getCredits 结果、
    //    模型漏调 getCredits 仅凭 item 无 cast 字段下的错误文字结论、新片 TMDB 阵容后补录。
    //    枚举不完，改为无条件重走新鲜链：step0 锁 searchItems 重取本片 id → step1 搜到条目则锁
    //    getCredits 查真实阵容（非 tmdb 条目由工具 note 兜底）；搜不到则放行，让模型回答「没找到这片」。
    // ② 其余空检索污染：step0 锁 searchItems
    prepareStep: ({ stepNumber, steps }) => {
      if (castFresh) {
        if (stepNumber === 0) return { toolChoice: { type: 'tool', toolName: 'searchItems' } };
        if (stepNumber === 1) {
          const hitItem = steps?.[0]?.toolResults?.some(r =>
            r?.toolName === 'searchItems' && r?.result
            && Array.isArray(r.result.items) && r.result.items.length > 0);
          if (hitItem) return { toolChoice: { type: 'tool', toolName: 'getCredits' } };
        }
        return undefined;
      }
      if (stepNumber === 0 && forceFreshSearch) {
        return { toolChoice: { type: 'tool', toolName: 'searchItems' } };
      }
      return undefined;
    },
    stopWhen: stepCountIs(5),
  });

  // 手动逐块搬运（不用 writer.merge）：keepAlive 心跳持续到子流读完，
  // 工具执行（TMDB 重试）与模型首 token 慢造成的 >5s 空窗全程有保活帧
  const innerReader = toUIMessageStream({
    stream: result.stream,
    onError: e => '生成失败：' + (e?.message || '未知错误，请重试'),
  }).getReader();
  while (true) {
    const { done, value } = await innerReader.read();
    if (done) break;
    writer.write(value);
  }
      } finally {
        clearInterval(keepAlive);
      }
    },
  });

  return createUIMessageStreamResponse({ stream: outerStream });
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
