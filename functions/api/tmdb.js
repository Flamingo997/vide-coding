// Cloudflare Pages Function：TMDB 真实影视数据接口
// GET /api/tmdb  返回本站时间线格式的真实影视上新数据
// 数据来源：TMDB（themoviedb.org），Key 存于 Pages 环境变量 TMDB_API_KEY

const BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w342';

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

export async function onRequestGet(context) {
  const key = context.env.TMDB_API_KEY;
  if (!key) {
    return new Response(JSON.stringify({ code: 500, message: '未配置 TMDB_API_KEY' }), {
      status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  try {
    const [nowPlaying, upcoming, onAir, movieGenres, tvGenres] = await Promise.all([
      tmdb('/movie/now_playing?region=CN&page=1', key),
      tmdb('/movie/upcoming?region=CN&page=1', key),
      tmdb('/tv/on_the_air?page=1', key),
      tmdb('/genre/movie/list', key),
      tmdb('/genre/tv/list', key)
    ]);

    const mg = Object.fromEntries((movieGenres.genres || []).map(g => [g.id, g.name]));
    const tg = Object.fromEntries((tvGenres.genres || []).map(g => [g.id, g.name]));

    const items = [];

    // 正在热映 → 院线电影 · 上线
    (nowPlaying.results || []).slice(0, 10).forEach(m => {
      const genres = (m.genre_ids || []).map(id => mg[id]).filter(Boolean).join(' / ');
      items.push({
        date: m.release_date,
        type: 'movie',
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

    // 即将上映 → 院线电影 · 定档
    (upcoming.results || []).slice(0, 10).forEach(m => {
      const genres = (m.genre_ids || []).map(id => mg[id]).filter(Boolean).join(' / ');
      items.push({
        date: m.release_date,
        type: 'movie',
        event: 'release',
        status: 'pending',
        title: `《${m.title}》定档${fmtDate(m.release_date)}`,
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

    // 正在播出 → 电视剧 · 上线
    (onAir.results || []).slice(0, 10).forEach(s => {
      const genres = (s.genre_ids || []).map(id => tg[id]).filter(Boolean).join(' / ');
      items.push({
        date: s.first_air_date,
        type: 'drama',
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
          ep: (s.origin_country || []).includes('CN') ? '华语剧集' : '海外剧集'
        }
      });
    });

    // 过滤无日期条目并按日期倒序
    const list = items.filter(n => n.date).sort((a, b) => new Date(b.date) - new Date(a.date));

    return new Response(JSON.stringify({
      code: 0,
      message: 'ok',
      total: list.length,
      attribution: '数据来源 TMDB（themoviedb.org）',
      data: list
    }), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=1800'
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ code: 502, message: 'TMDB 数据获取失败：' + e.message }), {
      status: 502, headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }
}
