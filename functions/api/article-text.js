// Cloudflare Pages Function：文章原文查看（溯源用）
// GET /api/article-text?url=<encoded>
// 域名白名单限制（防开放代理/SSRF），复用 articleFetcher 的双层缓存
// 返回 { code:0, ok, title, text }

import { fetchArticleContent } from '../_lib/articleFetcher.js';

const ALLOWED_DOMAINS = [
  'huanqiu.com',
  'variety.com',
  'deadline.com',
  'hollywoodreporter.com',
  'indiewire.com',
];

function jsonResponse(obj, status = 200, cacheSecs = 0) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  };
  if (cacheSecs > 0) headers['Cache-Control'] = `public, max-age=${cacheSecs}`;
  return new Response(JSON.stringify(obj), { status, headers });
}

export async function onRequestGet({ request, env }) {
  try {
    const raw = new URL(request.url).searchParams.get('url') || '';
    let u;
    try { u = new URL(raw); } catch (_) { return jsonResponse({ code: 400, message: '无效的 URL' }, 400); }

    if (!/^https?:$/.test(u.protocol)) {
      return jsonResponse({ code: 403, message: '仅支持 http/https' }, 403);
    }
    const allowed = ALLOWED_DOMAINS.some(d => u.hostname === d || u.hostname.endsWith('.' + d));
    if (!allowed) {
      return jsonResponse({ code: 403, message: '该域名不在白名单内' }, 403);
    }

    const r = await fetchArticleContent(raw, env, {});
    // 成功的原文缓存 6h；失败的短缓存（1min）避免反复打上游
    return jsonResponse({ code: 0, ...r }, 200, r.ok ? 21600 : 60);
  } catch (e) {
    return jsonResponse({ code: 502, message: '原文获取失败: ' + (e.message || String(e)) }, 200);
  }
}
