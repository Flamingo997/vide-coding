// Cloudflare Pages Function：TMDB 演职员表接口（点开卡片详情时前端懒加载）
// GET /api/credits?id=tmdb-movie-123 / tmdb-tv-456 / tmdb-docmovie-789
// 返回前 12 位演员名字；成功响应边缘缓存 1 小时（演职员表基本不变），失败不缓存
// 单独成端点而非塞进 /api/tmdb 列表：182 条全量取 credits 会打爆子请求预算，
// 按点击懒加载每次只花 1 个子请求，符合「点开名片才要演员」的使用节奏

const BASE = 'https://api.themoviedb.org/3';
const MAX_CAST = 12;

function json(body, status = 200, cache = false) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      ...(cache ? { 'Cache-Control': 'public, max-age=3600, s-maxage=3600' } : {}),
    },
  });
}

export async function onRequestGet(context) {
  const key = context.env.TMDB_API_KEY;
  if (!key) return json({ code: 500, message: '未配置 TMDB_API_KEY' }, 500);

  const id = (new URL(context.request.url).searchParams.get('id') || '').trim();
  const m = id.match(/^tmdb-(movie|tv|docmovie)-(\d+)$/);
  if (!m) return json({ code: 400, message: 'id 需为 tmdb-movie|tv|docmovie-数字 形态' }, 400);

  // docmovie 与 movie 同源（discover/movie）；tv 走 /tv
  const mediaType = m[1] === 'tv' ? 'tv' : 'movie';
  try {
    const r = await fetch(`${BASE}/${mediaType}/${m[2]}/credits?api_key=${key}&language=zh-CN`, {
      signal: AbortSignal.timeout(7000),
    });
    if (!r.ok) return json({ code: 502, message: 'TMDB 演职员表获取失败：' + r.status }, 502);
    const j = await r.json();
    const cast = (j.cast || [])
      .slice(0, MAX_CAST)
      .map(c => String(c.name || '').trim())
      .filter(Boolean);
    return json({ code: 0, message: 'ok', count: cast.length, cast, attribution: '数据来源 TMDB（themoviedb.org）' }, 200, true);
  } catch (e) {
    return json({ code: 502, message: '演职员表获取失败：' + (e?.message || '超时') }, 502);
  }
}
