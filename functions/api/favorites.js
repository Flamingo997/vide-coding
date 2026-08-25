// Cloudflare Pages Function：收藏夹 CRUD（D1 数据库）
// GET    /api/favorites          -> 获取当前用户收藏列表
// POST   /api/favorites          -> 添加收藏 { item }
// DELETE /api/favorites          -> 取消收藏 { itemId }
// GET    /api/favorites/count    -> 获取收藏数量（未登录也返回 0）

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

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

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) {
    return json({ code: 500, message: 'D1 未绑定', favorites: [] }, 500);
  }

  const userId = await verifySession(db, context.request);

  if (!userId) {
    return json({ code: 0, loggedIn: false, favorites: [], count: 0 });
  }

  const path = new URL(context.request.url).pathname;
  if (path.endsWith('/count')) {
    const row = await db.prepare('SELECT COUNT(*) as cnt FROM favorites WHERE user_id = ?').bind(userId).first();
    return json({ code: 0, count: row?.cnt || 0 });
  }

  const results = await db.prepare('SELECT item_id, item_data, saved_at FROM favorites WHERE user_id = ? ORDER BY saved_at DESC').bind(userId).all();

  const favorites = (results.results || []).map(row => {
    try {
      const item = JSON.parse(row.item_data);
      item.savedAt = row.saved_at;
      return item;
    } catch (_) {
      return null;
    }
  }).filter(Boolean);

  return json({ code: 0, loggedIn: true, favorites, count: favorites.length });
}

export async function onRequestPost(context) {
  const db = context.env.DB;
  if (!db) {
    return json({ code: 500, message: 'D1 未绑定' }, 500);
  }

  const userId = await verifySession(db, context.request);
  if (!userId) {
    return json({ code: 401, message: '请先登录' }, 401);
  }

  const body = await context.request.json().catch(() => ({}));
  const item = body.item;
  if (!item || !item.id) {
    return json({ code: 400, message: '缺少影片数据' }, 400);
  }

  const now = Date.now();
  try {
    await db.prepare(
      'INSERT INTO favorites (user_id, item_id, item_data, saved_at) VALUES (?, ?, ?, ?)'
    ).bind(userId, item.id, JSON.stringify(item), now).run();

    return json({ code: 0, message: '收藏成功', favorited: true });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return json({ code: 0, message: '已收藏过', favorited: true });
    }
    return json({ code: 500, message: '收藏失败：' + e.message }, 500);
  }
}

export async function onRequestDelete(context) {
  const db = context.env.DB;
  if (!db) {
    return json({ code: 500, message: 'D1 未绑定' }, 500);
  }

  const userId = await verifySession(db, context.request);
  if (!userId) {
    return json({ code: 401, message: '请先登录' }, 401);
  }

  const url = new URL(context.request.url);
  const itemId = url.searchParams.get('itemId');
  if (!itemId) {
    const body = await context.request.json().catch(() => ({}));
    const bid = body.itemId;
    if (!bid) return json({ code: 400, message: '缺少 itemId' }, 400);
    await db.prepare('DELETE FROM favorites WHERE user_id = ? AND item_id = ?').bind(userId, bid).run();
    return json({ code: 0, message: '已取消收藏', favorited: false });
  }

  await db.prepare('DELETE FROM favorites WHERE user_id = ? AND item_id = ?').bind(userId, itemId).run();
  return json({ code: 0, message: '已取消收藏', favorited: false });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
