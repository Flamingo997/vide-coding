// 文章原文抓取模块：
// - 环球网：直连抓 HTML + 解析 <article> 正文（服务端渲染，JINA 数据中心 IP 被环球反爬屏蔽，实测直连可行）
// - 国际源（Deadline/THR/Variety/IndieWire）：JINA Reader（r.jina.ai，需 JINA_API_KEY）
// - 双层缓存：模块级内存 Map（同 isolate 去重）+ cf fetch 缓存（跨请求，6h）
// - 抓取失败时返回降级内容（标题+摘要），Agent 仍可工作但会被告知原文缺失

const ARTICLE_MAX_CHARS = 6000; // 单篇截断，控制 token 成本
const MEM_CACHE_TTL = 6 * 3600 * 1000; // 内存缓存 6h

// 与 newsPool 一致的浏览器头（环球 API 已在生产验证可用）
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Referer': 'https://ent.huanqiu.com/',
};

// 模块级内存缓存（Workers 每个 isolate 一份）
const memCache = new Map();

function memGet(url) {
  const hit = memCache.get(url);
  if (hit && Date.now() - hit.ts < MEM_CACHE_TTL) return hit.value;
  memCache.delete(url);
  return null;
}

function memSet(url, value) {
  if (memCache.size > 200) memCache.clear(); // 防膨胀
  memCache.set(url, { ts: Date.now(), value });
}

// HTML 标签清洗 → 纯文本
function htmlToText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function truncate(text, max = ARTICLE_MAX_CHARS) {
  if (text.length <= max) return text;
  return text.slice(0, max).replace(/[\s,，。.；;、]+$/, '') + '…（截断）';
}

// ===== 环球：直连 HTML + 解析 <article> =====
async function fetchHuanqiu(url) {
  const r = await fetch(url, {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(15000),
    cf: { cacheTtl: 21600, cacheEverything: true }, // 6h
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const html = await r.text();

  // 正文在 <article><section data-type="rtext"> 内（服务端渲染，实测验证）
  const art = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  let text = art ? htmlToText(art[1]) : '';

  // 兜底：meta description
  if (text.length < 200) {
    const desc = html.match(/<meta[^>]+name="description"[^>]+content="([^"]{50,})"/);
    if (desc) text = htmlToText(desc[1]);
  }

  // 噪声特征：环球骨架页（Loading/没有内容了）
  if (text.length < 200 || /没有内容了|Loading/.test(text.slice(0, 100))) {
    throw new Error('正文解析失败（疑似反爬骨架页）');
  }

  const title = (html.match(/<title>([^<]+)<\/title>/) || [])[1]?.trim() || '';
  return { ok: true, title, text: truncate(text) };
}

// ===== 国际源：JINA Reader =====
async function fetchViaJina(url, env) {
  const key = env.JINA_API_KEY;
  const headers = {
    'Accept': 'text/plain',
    'X-Timeout': '25',
  };
  if (key) headers['Authorization'] = 'Bearer ' + key;

  const r = await fetch('https://r.jina.ai/' + url, {
    headers,
    signal: AbortSignal.timeout(30000),
    cf: { cacheTtl: 21600, cacheEverything: true },
  });
  if (!r.ok) throw new Error('JINA HTTP ' + r.status);
  const raw = await r.text();

  // JINA 输出格式：Title / URL Source / Published Time / Markdown Content:
  const title = (raw.match(/^Title:\s*(.+)$/m) || [])[1]?.trim() || '';
  const body = raw.split('Markdown Content:')[1] || raw;
  const text = String(body).trim();

  if (text.length < 200) throw new Error('JINA 返回内容过短');
  return { ok: true, title, text: truncate(text) };
}

/**
 * 抓取文章原文
 * @param {string} url 文章 URL
 * @param {object} env Pages 环境变量（JINA_API_KEY）
 * @param {{title?:string, summary?:string}} fallback 抓取失败时的降级信息（来自新闻池）
 * @returns {{ok:boolean, title:string, text:string}}
 */
export async function fetchArticleContent(url, env, fallback = {}) {
  const cached = memGet(url);
  if (cached) return cached;

  let result;
  try {
    result = /huanqiu\.com/.test(url)
      ? await fetchHuanqiu(url)
      : await fetchViaJina(url, env);
  } catch (e) {
    // 降级：原文不可得时返回池内标题+摘要，Agent 仍可基于此工作（但被告知限制）
    result = {
      ok: false,
      title: fallback.title || '',
      text: `（原文抓取失败：${e.message}。以下为仅有的摘要信息，请勿超出此范围编造细节）\n摘要：${fallback.summary || '（无摘要）'}`,
    };
  }

  memSet(url, result);
  return result;
}
