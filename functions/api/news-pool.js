// Cloudflare Pages Function：新闻池聚合输出
// GET /api/news-pool -> { code:0, total, stats, pool:[{id,title,url,ts,source,lang}] }
// CDN 缓存 30 分钟；GitHub Actions cron 每 6h 打一次做预热

import { buildNewsPool } from '../_lib/newsPool.js';

export async function onRequestGet() {
  try {
    const result = await buildNewsPool();
    return new Response(JSON.stringify({ code: 0, ...result }), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, s-maxage=1800, max-age=300',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ code: 502, message: '新闻池构建失败: ' + (e.message || String(e)) }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}
