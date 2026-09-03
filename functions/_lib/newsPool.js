// 共享新闻池模块：多源聚合 + 24h 过滤 + 去重 + 上限300
// 被 functions/api/news-pool.js（GET 输出）和 functions/api/news-tweet.js（素材来源）引用
//
// 源：
//  - 环球影讯官方 JSON（多页拉取，每页24条）
//  - 国际 RSS：Variety / Deadline / The Hollywood Reporter / IndieWire

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const BROWSER_HEADERS = {
  'User-Agent': UA,
  'Referer': 'https://ent.huanqiu.com/film',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

const HUANQIU_API = 'https://ent.huanqiu.com/api/list2?node=/e3pmh1jtb/fs9nk6km6';
const HUANQIU_PAGES = 8;        // 8 页 x 24 条 = 192 条候选
const POOL_WINDOW_MS = 24 * 3600 * 1000; // 首选 24h 时间窗
const POOL_FALLBACK_MS = 72 * 3600 * 1000; // 拉取窗口放宽到 72h（源断更时降级用）
const POOL_MIN = 15;            // 降级保底条数
const POOL_CAP = 300;           // 池子上限

const RSS_SOURCES = [
  { name: 'Variety', url: 'https://variety.com/feed/' },
  { name: 'Deadline', url: 'https://deadline.com/feed/' },
  { name: 'THR', url: 'https://www.hollywoodreporter.com/feed/' },
  { name: 'IndieWire', url: 'https://www.indiewire.com/feed/' },
];

// 噪声过滤：非影视资讯或导航类标题
function isNoiseTitle(t) {
  return /邮箱|电话|编辑|联系方式|版权|关注我们|扫码|微信公众号|责编|记者|环球网首页|登录|注册|返回顶部|Subscribe|Sign Up|Newsletter/.test(t);
}

// 标题归一化去重键（去空白/标点差异）
function titleKey(t) {
  return String(t).toLowerCase().replace(/[\s\p{P}]+/gu, '');
}

// 摘要清洗：strip HTML 标签 -> 压缩空白 -> 截断
function cleanSummary(s, max = 180) {
  if (!s) return '';
  let t = xmlDecode(s)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > max) t = t.slice(0, max).replace(/[\s,，。.；;、]+$/, '') + '…';
  return t;
}

// ============ 环球影讯：多页拉取 ============
async function fetchHuanqiu() {
  const out = [];
  const seen = new Set();
  const cutoff = Date.now() - POOL_FALLBACK_MS; // 拉取时用宽窗口，聚合时再按降级策略筛

  // 并行拉 8 页
  const pages = await Promise.all(
    Array.from({ length: HUANQIU_PAGES }, (_, i) =>
      fetch(`${HUANQIU_API}&offset=${i * 24}&limit=24`, {
        headers: BROWSER_HEADERS,
        cf: { cacheTtl: 600, cacheEverything: true },
      })
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null)
    )
  );

  for (const data of pages) {
    const list = data && Array.isArray(data.list) ? data.list : [];
    for (const item of list) {
      if (!item || !item.title || !item.aid) continue;
      const ts = Number(item.xtime || item.ctime || 0);
      if (!(ts > 1e12) || ts < cutoff) continue; // 只要 24h 内
      const title = String(item.title).trim();
      if (title.length < 5 || title.length > 160 || isNoiseTitle(title)) continue;
      const key = titleKey(title);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: 'hq_' + item.aid,
        title,
        summary: cleanSummary(item.summary, 180), // 接口自带摘要（纯文本）
        url: `https://ent.huanqiu.com/article/${item.aid}`,
        ts,
        source: '环球影讯',
        lang: 'zh',
      });
    }
  }
  return out;
}

// ============ RSS 解析（Workers 无 DOMParser，用正则） ============
function xmlDecode(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d));
}

function xmlTag(block, name) {
  // 容忍命名空间前缀（如 content:encoded / dc:date）
  const m = block.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`));
  return m ? xmlDecode(m[1]).trim() : '';
}

function parseRss(xml, sourceName) {
  const out = [];
  const re = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const title = xmlTag(block, 'title');
    let link = xmlTag(block, 'link');
    if (!link) {
      const gid = block.match(/<guid(?:\s[^>]*)?>([\s\S]*?)<\/guid>/);
      if (gid && /^https?:/.test(xmlDecode(gid[1]).trim())) link = xmlDecode(gid[1]).trim();
    }
    const pubRaw = xmlTag(block, 'pubDate') || xmlTag(block, 'updated') || xmlTag(block, 'dc:date');
    const ts = pubRaw ? Date.parse(pubRaw) : 0;
    if (!title || !link || !/^https?:/.test(link)) continue;
    if (title.length < 8 || title.length > 300 || isNoiseTitle(title)) continue;
    // RSS 自带摘要（description / content:encoded，常为 HTML 片段）
    const descRaw = xmlTag(block, 'description') || xmlTag(block, 'encoded') || xmlTag(block, 'summary');
    out.push({ title, summary: cleanSummary(descRaw, 180), url: link, ts, source: sourceName, lang: 'en' });
  }
  return out;
}

async function fetchRss() {
  const results = await Promise.all(
    RSS_SOURCES.map(s =>
      fetch(s.url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
        cf: { cacheTtl: 1800, cacheEverything: true },
      })
        .then(r => (r.ok ? r.text() : ''))
        .catch(() => '')
        .then(xml => (xml ? parseRss(xml, s.name) : []))
    )
  );
  return results.flat();
}

// ============ 聚合入口 ============
export async function buildNewsPool() {
  const [hq, rss] = await Promise.all([fetchHuanqiu(), fetchRss()]);

  const seen = new Set();
  const all = [];
  for (const n of [...hq, ...rss]) {
    if (!(n.ts > 1e12)) continue;
    const key = titleKey(n.title);
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(n);
  }

  // 窗口降级策略：首选 24h；不足保底条数时逐步放宽（48h/72h），防止源断更导致空池
  let windowMs = POOL_WINDOW_MS;
  let pool = all.filter(n => n.ts >= Date.now() - windowMs);
  if (pool.length < POOL_MIN) {
    windowMs = 48 * 3600 * 1000;
    pool = all.filter(n => n.ts >= Date.now() - windowMs);
  }
  if (pool.length < POOL_MIN) {
    windowMs = POOL_FALLBACK_MS;
    pool = all.filter(n => n.ts >= Date.now() - windowMs);
  }

  // 按新鲜度降序，截断上限
  pool.sort((a, b) => b.ts - a.ts);
  const final = pool.slice(0, POOL_CAP);

  const stats = {};
  for (const n of final) stats[n.source] = (stats[n.source] || 0) + 1;

  return {
    total: final.length,
    stats,
    windowHours: Math.round(windowMs / 3600000), // 实际生效的时间窗（小时）
    generatedAt: Date.now(),
    pool: final,
  };
}
