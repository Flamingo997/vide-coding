// Cloudflare Pages Function：用户认证（简单密码登录）
// POST /api/auth/login   { password } -> 登录，设置 cookie
// POST /api/auth/logout  -> 登出，清除 cookie
// GET  /api/auth/check   -> 检查登录状态

const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 天

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
}

function setCookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;
}

function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

function getCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

// 验证 session 是否有效，返回 user_id 或 null
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
    return json({ loggedIn: false, error: 'D1 未绑定' }, 200);
  }
  const userId = await verifySession(db, context.request);
  return json({ loggedIn: !!userId, userId }, 200);
}

export async function onRequestPost(context) {
  const db = context.env.DB;
  if (!db) {
    return json({ code: 500, message: 'D1 未绑定' }, 500);
  }

  const body = await context.request.json().catch(() => ({}));

  // 登出
  if (body.action === 'logout') {
    const token = getCookie(context.request.headers.get('Cookie'), 'session');
    if (token) {
      await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    }
    return new Response(JSON.stringify({ code: 0, message: '已登出' }), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': clearCookie('session')
      }
    });
  }

  // 登录
  const password = body.password || '';
  if (!password) {
    return json({ code: 400, message: '请输入密码' }, 400);
  }

  const hash = await sha256(password);

  // 查找匹配的用户
  const user = await db.prepare('SELECT id, role FROM users WHERE password_hash = ?').bind(hash).first();
  if (!user) {
    return json({ code: 401, message: '密码错误' }, 401);
  }

  // 创建 session
  const token = randomToken();
  const now = Date.now();
  await db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(token, user.id, now + SESSION_DURATION, now).run();

  return new Response(JSON.stringify({
    code: 0,
    message: '登录成功',
    userId: user.id,
    role: user.role
  }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': setCookie('session', token, SESSION_DURATION / 1000)
    }
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

export { verifySession };
