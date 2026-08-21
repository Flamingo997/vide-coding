// Cloudflare Pages Function：豆瓣电影详情接口
// 改写自 unified_douban.php，适配 Workers/Pages 环境（fetch + 正则解析）
// GET /api/douban?id=<豆瓣ID>   或   GET /api/douban?movieName=<片名>
// 豆瓣 Cookie 从 Pages 环境变量 DOUBAN_COOKIE 读取

const MIN_VALID_ID = 10000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

// 内存缓存：{ key -> { time, data } }，避免每次请求重复抓取
const cache = new Map();
const DETAIL_TTL = 3600 * 1000;   // 详情缓存 1 小时
const SEARCH_TTL = 600 * 1000;    // 搜索缓存 10 分钟

function getHeader(cookie) {
  const h = {
    'User-Agent': UA,
    'Referer': 'https://movie.douban.com/',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9'
  };
  if (cookie) h['Cookie'] = cookie;
  return h;
}

async function searchMovie(name, cookie) {
  const key = 's:' + name;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.time < SEARCH_TTL) return hit.data;

  const url = 'https://movie.douban.com/j/subject_suggest?q=' + encodeURIComponent(name);
  const r = await fetch(url, { headers: getHeader(cookie) });
  if (!r.ok) return [];
  const arr = await r.json();
  const clean = Array.isArray(arr) ? arr.filter(x => x && typeof x.id === 'string' && parseInt(x.id) >= MIN_VALID_ID) : [];
  cache.set(key, { time: now, data: clean });
  return clean;
}

// 从豆瓣详情 HTML 中提取字段（正则版，对应 PHP 的 strSubstr）
function strSubstr(html, start, end) {
  const i = html.indexOf(start);
  if (i === -1) return '';
  const rest = html.slice(i + start.length);
  const j = rest.indexOf(end);
  return (j === -1 ? rest : rest.slice(0, j)).trim();
}

function cleanHtml(s) {
  return s.replace(/<[^>]+>/g, '')
    .replace(/[\t\r\n　]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchDetail(id, cookie) {
  const key = 'd:' + id;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.time < DETAIL_TTL) return hit.data;

  const url = 'https://movie.douban.com/subject/' + id + '/';
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Referer': 'https://movie.douban.com/', 'Accept-Language': 'zh-CN,zh;q=0.9', ...(cookie ? { 'Cookie': cookie } : {}) },
    redirect: 'follow'
  });
  const html = await r.text();
  if (!r.ok || html.length < 500) return null;

  const meta = (prop) => {
    const m = html.match(new RegExp(`<meta property="${prop}" content="([^"]*)"`));
    return m ? m[1] : '';
  };
  const multiMeta = (prop) => {
    const m = [...html.matchAll(new RegExp(`<meta property="${prop}" content="([^"]*)"`, 'g'))];
    return m.map(x => x[1]).join('，');
  };

  const name = cleanHtml(strSubstr(html, '<span property="v:itemreviewed">', '</span>')) || meta('og:title');
  const score = strSubstr(html, '<strong class="ll rating_num" property="v:average">', '</strong>');
  const year = cleanHtml(strSubstr(html, '<span class="year">(', ')</span>'));
  const director = cleanHtml(strSubstr(html, '导演</span>: <span class=\'attrs\'>', '</a></span></span><br/>'));
  const actor = cleanHtml(strSubstr(html, '主演</span>: <span class=\'attrs\'>', '</span></span><br/>'));
  const writer = cleanHtml(strSubstr(html, '编剧</span>: <span class=\'attrs\'>', '</span></span><br/>'));
  const genre = cleanHtml(strSubstr(html, '类型:</span> ', '<br/>'));
  const area = cleanHtml(strSubstr(html, '制片国家/地区:</span> ', '<br/>'));
  const lang = cleanHtml(strSubstr(html, '语言:</span> ', '<br/>'));
  const sub = cleanHtml(strSubstr(html, '又名:</span> ', '<br/>'));
  const pubdate = strSubstr(html, '<span property="v:initialReleaseDate" content="', '">') ||
                  cleanHtml(strSubstr(html, '上映日期:</span> ', '<br/>'));
  const duration = strSubstr(html, '片长:</span> <span property="v:runtime" content="', '">') ||
                   strSubstr(html, '单集片长:</span> ', '<br/>');
  const poster = meta('og:image') || strSubstr(html, '"image": "', '"');
  let content = cleanHtml(strSubstr(html, '<span class="all hidden">', '</span>'));
  if (!content) content = cleanHtml(strSubstr(html, '<span property="v:summary">', '</span>'));
  if (!content) content = meta('og:description') || '';

  const result = {
    vod_name: name,
    vod_score: score,
    vod_year: year,
    vod_director: director,
    vod_actor: actor || multiMeta('video:actor'),
    vod_writer: writer,
    vod_class: genre,
    vod_area: area,
    vod_lang: lang,
    vod_sub: sub,
    vod_pubdate: pubdate,
    vod_duration: duration,
    vod_pic: poster,
    vod_content: content,
    vod_douban_id: id
  };
  cache.set(key, { time: now, data: result });
  return result;
}

export { searchMovie, fetchDetail, cleanHtml };

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const id = (url.searchParams.get('id') || '').trim();
  let name = (url.searchParams.get('movieName') || '').trim();
  const cookie = context.env.DOUBAN_COOKIE || '';

  if (!id && !name) {
    return new Response(JSON.stringify({ code: 104, msg: '豆瓣ID或电影名称不能都为空！' }), {
      status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
  }

  try {
    // 若传入的是链接则提取 ID
    let realId = id;
    if (id.includes('.com')) {
      const m = id.match(/subject\/(\d+)/);
      realId = m ? m[1] : '';
    }

    // 无有效 ID 则按名称搜索，取第一条
    if (!realId || !/^\d+$/.test(realId) || parseInt(realId) < MIN_VALID_ID) {
      if (!name && realId) name = realId;
      const results = await searchMovie(name, cookie);
      if (!results.length) {
        return new Response(JSON.stringify({ code: 102, msg: '没有找到搜索结果！' }), {
          status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
        });
      }
      realId = results[0].id;
    }

    const detail = await fetchDetail(realId, cookie);
    if (!detail) {
      return new Response(JSON.stringify({ code: 102, msg: 'Failed to fetch movie detail' }), {
        status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
      });
    }

    return new Response(JSON.stringify({ code: 1, msg: '', auth: 'iFuns动漫内部API', data: detail }), {
      status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ code: 502, msg: '豆瓣请求失败：' + e.message }), {
      status: 502, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
  }
}