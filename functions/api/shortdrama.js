// Cloudflare Pages Function：短剧数据接口（来源 HOSHIYOMI Aggregation API）
// HOSHIYOMI 是一个短剧聚合 API，统一接入 16+ 短剧平台（DramaBox / ReelShort / GoodShort / ShortMax 等）
// 文档：https://api.hoshiyomi.my.id/docs
// GET /api/shortdrama?limit=16

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

// 8 个数据量大且稳定的短剧平台
const PLATFORMS = [
  'dramabox', 'reelshort', 'goodshort', 'shortmax',
  'dramabite', 'pinedrama', 'moboreels', 'netshort'
];

// 每个平台请求的语言（中文优先，次英文，次印尼文），保证中文短剧有中文名，海外短剧有英文名
const LANGS = ['zh', 'en'];

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 解析 HOSHIYOMI 条目日期：优先 created_at / updated_at，兜底为当天
function pickDate(item) {
  const candidates = [item.created_at, item.updated_at, item.release_date, item.air_date, item.date];
  for (const c of candidates) {
    if (!c) continue;
    const m = String(c).match(/(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
    if (m) {
      const [_, y, mo, d] = m;
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  return todayStr();
}

// 请求单个 HOSHIYOMI 平台 + endpoint + lang
async function fetchHoshiyomi(apiKey, platform, endpoint, lang) {
  const url = `https://api.hoshiyomi.my.id/api/${platform}/${endpoint}?lang=${lang}&page=1`;
  try {
    const r = await fetch(url, {
      headers: {
        'X-API-Key': apiKey,
        'User-Agent': UA,
        'Accept': 'application/json'
      }
    });
    if (!r.ok) return [];
    const j = await r.json();
    // HOSHIYOMI 可能返回多种格式：
    //   { items: [...] } / { data: [...] }
    //   { success: true, data: { items: [...] } } / { result: [...] }
    let arr = null;
    if (Array.isArray(j)) arr = j;
    else if (j) {
      if (Array.isArray(j.items)) arr = j.items;
      else if (Array.isArray(j.data)) arr = j.data;
      else if (Array.isArray(j.result)) arr = j.result;
      else if (j.data && Array.isArray(j.data.items)) arr = j.data.items;
      else if (j.result && Array.isArray(j.result.items)) arr = j.result.items;
    }
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

// 去掉剧名首尾多余符号和集数后缀，保持中文书名号内部纯内容
function cleanTitle(raw) {
  if (!raw) return '';
  let t = String(raw).trim();
  t = t.replace(/^[\s\-—–_·•.。,，、:：;；!！?？]+/g, '');
  t = t.replace(/[\s\-—–_·•.。,，、:：;；!！?？]+$/g, '');
  t = t.replace(/\s*\(?（?\s*\d+\s*(集|EP| episodes?)\s*\)?）?.*$/i, '');
  return t.trim();
}

const POSTER_BASE = 'https://image.tmdb.org/t/p/w500';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '16', 10) || 16, 40);
  const apiKey = (context.env && context.env.HOSHIYOMI_API_KEY) || 'HOSHIYOMI-FREE-d45bc973';

  try {
    // 多平台 + 多接口 + 多语言 并发请求，最大化覆盖面
    // 每个平台同时拉取 trending（热门） 和 latest（最新）
    const tasks = [];
    for (const p of PLATFORMS) {
      for (const ep of ['trending', 'latest']) {
        for (const lang of LANGS) {
          tasks.push(fetchHoshiyomi(apiKey, p, ep, lang));
        }
      }
    }
    const batches = await Promise.all(tasks);
    const flat = batches.flat();

    // 以 title 为主键去重，优先保留有海报 + 有简介的版本
    const map = new Map();
    for (const it of flat) {
      if (!it || (!it.title && !it.name)) continue;
      const rawTitle = it.title || it.name || '';
      const name = cleanTitle(rawTitle);
      if (!name) continue;
      const key = name.toLowerCase();
      const old = map.get(key);
      const poster = it.poster || it.poster_path || it.thumbnail || it.cover || it.image || '';
      const desc = it.description || it.overview || it.synopsis || it.intro || '';
      const score = (poster ? 2 : 0) + (desc ? 1 : 0) + (Number(it.episodes || 0) > 0 ? 1 : 0);
      if (!old || score > old.score) {
        map.set(key, {
          it, name, poster, desc, score,
          episodes: it.episodes || it.total_episodes || '',
          rating: it.rating || it.score || ''
        });
      }
    }

    // 转为统一结构，保证至少 limit 条
    const items = [];
    for (const { it, name, poster, desc, episodes, rating } of map.values()) {
      const date = pickDate(it);
      const epText = episodes ? `共 ${episodes} 集` : '集数见详情';
      const rtText = rating ? `，评分 ${rating}` : '';
      const intro = desc
        ? `${name}${rtText}。${desc}`
        : `${name}${rtText}，点击查看来源平台播放链接。`;
      const posterUrl = poster
        ? (poster.startsWith('http') ? poster : `${POSTER_BASE}${poster.startsWith('/') ? '' : '/'}${poster}`)
        : '';
      items.push({
        date,
        type: 'duan',
        event: 'online',
        status: 'released',
        title: `《${name}》短剧上新`,
        summary: intro.length > 60 ? intro.slice(0, 60) + '…' : intro,
        source: 'HOSHIYOMI',
        sourceLink: it.url || it.link || it.viewlink || it.source_url || '#',
        poster: posterUrl,
        detail: {
          intro,
          cast: '短剧',
          platform: `HOSHIYOMI 短剧聚合 · ${epText}`,
          ep: epText
        }
      });
      if (items.length >= limit) break;
    }

    return new Response(JSON.stringify({
      code: 0,
      message: 'ok',
      total: items.length,
      attribution: '数据来源 HOSHIYOMI（聚合 DramaBox / ReelShort / GoodShort / ShortMax 等16+平台）',
      data: items
    }), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=600'
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ code: 502, message: '短剧数据获取失败：' + e.message }), {
      status: 502, headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }
}
