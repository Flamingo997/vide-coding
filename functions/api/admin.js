// Cloudflare Pages Function：后台管理 API
// GET    /api/admin/stats       -> 统计数据（用户数、会话数、收藏数）
// GET    /api/admin/news-flash  -> 快讯列表
// DELETE /api/admin/news-flash  -> 删除快讯 { id }
// GET    /api/admin/users       -> 用户列表
// DELETE /api/admin/users      -> 删除用户 { id }

import { verifySession } from './auth.js';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

async function requireAdmin(db, request) {
  const userId = await verifySession(db, request);
  if (!userId) return null;
  const user = await db.prepare('SELECT role FROM users WHERE id = ?').bind(userId).first();
  if (!user || user.role !== 'admin') return null;
  return userId;
}

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ code: 500, message: 'D1 未绑定' }, 500);

  const url = new URL(context.request.url);
  const path = url.pathname;

  // 统计数据（登录用户即可看）
  if (path.endsWith('/stats')) {
    const userId = await verifySession(db, context.request);
    if (!userId) return json({ code: 401, message: '请先登录' }, 401);

    const [favRow, userRow, sessionRow] = await Promise.all([
      db.prepare('SELECT COUNT(*) as cnt FROM favorites').first(),
      db.prepare('SELECT COUNT(*) as cnt FROM users').first(),
      db.prepare('SELECT COUNT(*) as cnt FROM sessions WHERE expires_at > ?').bind(Date.now()).first()
    ]);
    return json({
      code: 0,
      favCount: favRow?.cnt || 0,
      userCount: userRow?.cnt || 0,
      sessionCount: sessionRow?.cnt || 0
    });
  }

  // 以下需要 admin 权限
  const adminId = await requireAdmin(db, context.request);
  if (!adminId) return json({ code: 403, message: '需要管理员权限' }, 403);

  // 快讯列表
  if (path.endsWith('/news-flash')) {
    const results = await db.prepare('SELECT * FROM news_flash ORDER BY sort_order ASC').all();
    return json({ code: 0, data: results.results || [] });
  }

  // 用户列表
  if (path.endsWith('/users')) {
    const results = await db.prepare('SELECT id, role, created_at FROM users ORDER BY created_at ASC').all();
    return json({ code: 0, data: results.results || [] });
  }

  return json({ code: 404, message: '未知接口' }, 404);
}

export async function onRequestDelete(context) {
  const db = context.env.DB;
  if (!db) return json({ code: 500, message: 'D1 未绑定' }, 500);

  const adminId = await requireAdmin(db, context.request);
  if (!adminId) return json({ code: 403, message: '需要管理员权限' }, 403);

  const body = await context.request.json().catch(() => ({}));
  const url = new URL(context.request.url);
  const path = url.pathname;

  // 删除快讯
  if (path.endsWith('/news-flash')) {
    if (!body.id) return json({ code: 400, message: '缺少 id' }, 400);
    await db.prepare('DELETE FROM news_flash WHERE id = ?').bind(body.id).run();
    return json({ code: 0, message: '已删除' });
  }

  // 删除用户（不能删自己）
  if (path.endsWith('/users')) {
    if (!body.id) return json({ code: 400, message: '缺少 id' }, 400);
    if (body.id === adminId) return json({ code: 400, message: '不能删除自己' }, 400);
    await db.batch([
      db.prepare('DELETE FROM favorites WHERE user_id = ?').bind(body.id),
      db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(body.id),
      db.prepare('DELETE FROM users WHERE id = ?').bind(body.id)
    ]);
    return json({ code: 0, message: '已删除用户及其收藏' });
  }

  return json({ code: 404, message: '未知接口' }, 404);
}
