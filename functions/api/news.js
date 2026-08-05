// Cloudflare Pages Function：资讯 API
// GET /api/news            全部资讯（按日期倒序）
// GET /api/news?type=movie 按类型过滤（movie/drama/show/anime/doc）
// GET /api/news?range=week 按时间范围过滤（week/month/upcoming）
// GET /api/news?keyword=深海 按标题/摘要关键词过滤
export async function onRequestGet(context) {
  const url = new URL(context.request.url);

  // 读取同站点静态数据 data.json
  const res = await context.env.ASSETS.fetch(new Request(url.origin + '/data.json'));
  const data = await res.json();

  let items = [...data.NEWS];

  // 类型过滤
  const type = url.searchParams.get('type');
  if (type && type !== 'all') {
    items = items.filter(n => n.type === type);
  }

  // 时间范围过滤（基准日与站点一致）
  const range = url.searchParams.get('range');
  const TODAY = new Date('2026-07-23');
  if (range && range !== 'all') {
    items = items.filter(n => {
      const diffDays = Math.round((new Date(n.date) - TODAY) / 86400000);
      if (range === 'week')     return diffDays >= -7 && diffDays <= 0;
      if (range === 'month')    return diffDays >= -30 && diffDays <= 0;
      if (range === 'upcoming') return diffDays > 0;
      return true;
    });
  }

  // 关键词过滤
  const keyword = url.searchParams.get('keyword');
  if (keyword) {
    items = items.filter(n => n.title.includes(keyword) || n.summary.includes(keyword));
  }

  // 按日期倒序
  items.sort((a, b) => new Date(b.date) - new Date(a.date));

  return new Response(JSON.stringify({
    code: 0,
    message: 'ok',
    total: items.length,
    updated: '2026-07-23',
    data: items
  }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300'
    }
  });
}

// 预检请求：允许跨域
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
