// Cloudflare Pages Function：TMDB 真实影视数据接口
// GET /api/tmdb  返回本站时间线格式的真实影视上新数据
// 数据来源：TMDB（themoviedb.org），Key 存于 Pages 环境变量 TMDB_API_KEY
// 品类映射：电影 movie / 电视剧 drama / 综艺 show / 动漫 anime / 纪录片 doc

const BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w342';

// 引入豆瓣客户端（本文件与 douban.js 同目录）
import { searchMovie as dbSearch, fetchDetail as dbDetail } from './douban.js';

// TMDB 类型 ID → 本站品类
const TV_GENRE_TYPE = {
  16: 'anime',    // 动画
  99: 'doc',      // 纪录片
  10764: 'show',  // 真人秀
  10767: 'show',  // 脱口秀
  10766: 'drama', // 肥皂剧
  10765: 'drama'  // 科幻奇幻剧
};
const MOVIE_GENRE_TYPE = {
  16: 'anime',  // 动画
  99: 'doc'     // 纪录片
};

async function tmdb(path, key) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${BASE}${path}${sep}api_key=${key}&language=zh-CN`);
  if (!r.ok) throw new Error('TMDB 请求失败: ' + r.status);
  return r.json();
}

function cut(text, len) {
  if (!text) return '暂无中文简介。';
  return text.length > len ? text.slice(0, len) + '…' : text;
}

function fmtDate(dateStr) {
  const d = new Date(dateStr);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

// 电视剧/综艺/动漫/纪录片条目
function mapShow(s, genreNames) {
  const gids = s.genre_ids || [];
  let type = 'drama';
  for (const id of gids) {
    if (TV_GENRE_TYPE[id]) { type = TV_GENRE_TYPE[id]; break; }
  }
  const genres = gids.map(id => genreNames[id]).filter(Boolean).join(' / ');
  return {
    date: s.first_air_date,
    type,
    event: 'online',
    status: 'done',
    title: `《${s.name}》热播中`,
    summary: cut(s.overview, 80),
    source: 'TMDB',
    sourceLink: `https://www.themoviedb.org/tv/${s.id}`,
    poster: s.poster_path ? IMG + s.poster_path : '',
    detail: {
      intro: s.overview || '暂无中文简介。',
      cast: genres || '暂无',
      platform: `TMDB 评分：${s.vote_average.toFixed(1)}（${s.vote_count} 人评价）`,
      ep: (s.origin_country || []).includes('CN') ? '华语内容' : '海外内容'
    }
  };
}

// ===== 豆瓣详情增强：用中文详情覆盖 TMDB，失败回退原数据 =====
// 复用 douban.js 的查询客户端，cookie 读自环境变量 DOUBAN_COOKIE

async function enrichWithDouban(items, cookie, maxItems) {
  if (!items.length) return items;
  // 仅对前 maxItems 部影片做增强，避免请求过多触发豆瓣反爬
  const targets = items.slice(0, maxItems).filter(n => n.poster || n.type);

  // 限并发数为 2，逐批处理
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      const item = items[i];
      if (!targets.includes(item)) { results[i] = item; continue; }
      try {
        // 尝试按 TMDB 标题在豆瓣搜索
        const name = item.title.replace(/[《》]/g, '');
        let found = await dbSearch(name, cookie);
        if (!found || !found.length) { results[i] = item; continue; }
        let detail = await dbDetail(found[0].id, cookie);
        if (!detail && found[1]) detail = await dbDetail(found[1].id, cookie);
        results[i] = applyDouban(item, detail);
      } catch (e) {
        results[i] = item; // 豆瓣失败回退原数据
      }
    }
  }
  await Promise.all([worker(), worker()]);
  return results;
}

// 借助豆瓣返回的详情覆盖现有条目
function applyDouban(item, d) {
  if (!d) return item;
  const out = { ...item };
  if (d.vod_name) out.title = out.title.includes('上映') || out.title.includes('热播') || out.title.includes('热映') ? `《${d.vod_name}》${out.title.split('》')[1] || '热映中'}` : `《${d.vod_name}》`;
  if (d.vod_pic) out.poster = d.vod_pic;
  if (d.vod_score) {
    out.detail = out.detail || {};
    out.detail.platform = `豆瓣评分：${d.vod_score}`;
  }
  if (d.vod_content) {
    out.detail = out.detail || {};
    out.detail.intro = d.vod_content;
  }
  if (d.vod_area) {
    out.detail = out.detail || {};
    out.detail.ep = d.vod_area + (out.detail.ep && out.detail.ep.includes('海外') === false ? '' : '');
  }
  if (d.vod_director || d.vod_actor) {
    out.detail = out.detail || {};
    out.detail.cast = [d.vod_director, d.vod_actor].filter(Boolean).join(' / ') || out.detail.cast;
  }
  out.source = 'TMDB+豆瓣';
  return out;
}

export async function onRequestGet(context) {
  const key = context.env.TMDB_API_KEY;
  if (!key) {
    return new Response(JSON.stringify({ code: 500, message: '未配置 TMDB_API_KEY' }), {
      status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  try {
    const [nowPlaying, upcoming, onAir, tvPopular, docMovies, docTv, movieGenres, tvGenres] = await Promise.all([
      tmdb('/movie/now_playing?region=CN&page=1', key),
      tmdb('/movie/upcoming?region=CN&page=1', key),
      tmdb('/tv/on_the_air?page=1', key),
      tmdb('/tv/popular?page=1', key),
      tmdb('/discover/movie?with_genres=99&sort_by=popularity.desc&page=1', key),
      tmdb('/discover/tv?with_genres=99&sort_by=popularity.desc&page=1', key),
      tmdb('/genre/movie/list', key),
      tmdb('/genre/tv/list', key)
    ]);

    const mg = Object.fromEntries((movieGenres.genres || []).map(g => [g.id, g.name]));
    const tg = Object.fromEntries((tvGenres.genres || []).map(g => [g.id, g.name]));

    const items = [];
    const seen = new Set();

    // 正在热映 → 按类型细分为 电影/动漫/纪录片 · 上线
    (nowPlaying.results || []).slice(0, 12).forEach(m => {
      seen.add('m' + m.id);
      const gids = m.genre_ids || [];
      let type = 'movie';
      for (const id of gids) {
        if (MOVIE_GENRE_TYPE[id]) { type = MOVIE_GENRE_TYPE[id]; break; }
      }
      const genres = gids.map(id => mg[id]).filter(Boolean).join(' / ');
      items.push({
        date: m.release_date,
        type,
        event: 'online',
        status: 'done',
        title: `《${m.title}》正在热映`,
        summary: cut(m.overview, 80),
        source: 'TMDB',
        sourceLink: `https://www.themoviedb.org/movie/${m.id}`,
        poster: m.poster_path ? IMG + m.poster_path : '',
        detail: {
          intro: m.overview || '暂无中文简介。',
          cast: genres || '暂无',
          platform: `TMDB 评分：${m.vote_average.toFixed(1)}（${m.vote_count} 人评价）`,
          ep: m.original_language === 'zh' ? '华语影片' : '外语影片'
        }
      });
    });

    // 即将上映 → 按类型细分 · 定档（去重已热映条目）
    (upcoming.results || []).slice(0, 12).forEach(m => {
      if (seen.has('m' + m.id)) return;
      const gids = m.genre_ids || [];
      let type = 'movie';
      for (const id of gids) {
        if (MOVIE_GENRE_TYPE[id]) { type = MOVIE_GENRE_TYPE[id]; break; }
      }
      const genres = gids.map(id => mg[id]).filter(Boolean).join(' / ');
      const isPast = new Date(m.release_date) < new Date();
      items.push({
        date: m.release_date,
        type,
        event: isPast ? 'online' : 'schedule',
        status: isPast ? 'done' : 'pending',
        title: isPast ? `《${m.title}》正在热映` : `《${m.title}》定档${fmtDate(m.release_date)}`,
        summary: cut(m.overview, 80),
        source: 'TMDB',
        sourceLink: `https://www.themoviedb.org/movie/${m.id}`,
        poster: m.poster_path ? IMG + m.poster_path : '',
        detail: {
          intro: m.overview || '暂无中文简介。',
          cast: genres || '暂无',
          platform: `TMDB 评分：${m.vote_average.toFixed(1)}（${m.vote_count} 人评价）`,
          ep: m.original_language === 'zh' ? '华语影片' : '外语影片'
        }
      });
    });

    // 正在播出 + 热门剧集/综艺/动漫/纪录片（合并去重）
    const tvSeen = new Set();
    [...(onAir.results || []), ...(tvPopular.results || [])].forEach(s => {
      if (tvSeen.has(s.id)) return;
      tvSeen.add(s.id);
      items.push(mapShow(s, tg));
    });

    // 纪录片专门榜单：电影纪录片 + TV纪录片，按热度排序，去重后补足
    const docSeen = new Set();
    (docMovies.results || []).slice(0, 8).forEach(m => {
      if (seen.has('m' + m.id) || docSeen.has(m.id)) return;
      docSeen.add(m.id);
      const genres = (m.genre_ids || []).map(id => mg[id]).filter(Boolean).join(' / ');
      items.push({
        date: m.release_date,
        type: 'doc',
        event: 'online',
        status: 'done',
        title: `《${m.title}》纪录电影热映`,
        summary: cut(m.overview, 80),
        source: 'TMDB',
        sourceLink: `https://www.themoviedb.org/movie/${m.id}`,
        poster: m.poster_path ? IMG + m.poster_path : '',
        detail: {
          intro: m.overview || '暂无中文简介。',
          cast: genres || '纪录',
          platform: `TMDB 评分：${m.vote_average.toFixed(1)}（${m.vote_count} 人评价）`,
          ep: m.original_language === 'zh' ? '华语纪录片' : '海外纪录片'
        }
      });
    });
    (docTv.results || []).slice(0, 8).forEach(s => {
      if (tvSeen.has(s.id) || docSeen.has(s.id)) return;
      docSeen.add(s.id);
      const genres = (s.genre_ids || []).map(id => tg[id]).filter(Boolean).join(' / ');
      items.push({
        date: s.first_air_date,
        type: 'doc',
        event: 'online',
        status: 'done',
        title: `《${s.name}》纪录片热播中`,
        summary: cut(s.overview, 80),
        source: 'TMDB',
        sourceLink: `https://www.themoviedb.org/tv/${s.id}`,
        poster: s.poster_path ? IMG + s.poster_path : '',
        detail: {
          intro: s.overview || '暂无中文简介。',
          cast: genres || '纪录',
          platform: `TMDB 评分：${s.vote_average.toFixed(1)}（${s.vote_count} 人评价）`,
          ep: (s.origin_country || []).includes('CN') ? '华语纪录片' : '海外纪录片'
        }
      });
    });

    // 过滤无日期条目并按日期倒序
    let list = items.filter(n => n.date).sort((a, b) => new Date(b.date) - new Date(a.date));

    // 豆瓣详情增强：用中文详情覆盖 TMDB（失败回退原数据）
    const doubanCookie = context.env.DOUBAN_COOKIE || '';
    if (doubanCookie) {
      list = await enrichWithDouban(list, doubanCookie, 20);
    }

    // 各品类数量统计（便于调用方了解覆盖情况）
    const coverage = {};
    list.forEach(n => { coverage[n.type] = (coverage[n.type] || 0) + 1; });

    return new Response(JSON.stringify({
      code: 0,
      message: 'ok',
      total: list.length,
      coverage,
      attribution: '数据来源 TMDB（themoviedb.org）',
      data: list
    }), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300'
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ code: 502, message: 'TMDB 数据获取失败：' + e.message }), {
      status: 502, headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }
}
