// Cloudflare Pages Function：TMDB 真实影视数据接口
// GET /api/tmdb  返回本站时间线格式的真实影视上新数据
// 数据来源：TMDB（themoviedb.org），Key 存于 Pages 环境变量 TMDB_API_KEY
// 品类映射：电影 movie / 电视剧 drama / 综艺 show / 动漫 anime / 纪录片 doc

const BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w342';

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

function hasChinese(text) {
  return /[\u4e00-\u9fff]/.test(text || '');
}

// 将英文简介转为中文占位一句话
function zhSummary(overview, fallbackTitle = '') {
  if (!overview) return '精彩内容，敬请期待。';
  if (hasChinese(overview)) return cut(overview, 80);
  // 英文简介 → 生成中文占位描述
  const cleanTitle = (fallbackTitle || '这部作品').replace(/^《|》$/g, '');
  const t = cleanTitle || '这部作品';
  const lang = /[\u4e00-\u9fff]/.test(t) ? '' : '海外';
  // 根据标题类型生成不同模板
  if (t.includes('纪录片')) return `${lang}纪录片《${t}》，用镜头记录真实故事。`;
  if (t.includes('综艺') || t.includes('真人秀')) return `${lang}综艺节目《${t}》，精彩内容不容错过。`;
  if (t.includes('动画') || t.includes('动漫')) return `${lang}动画作品《${t}》，讲述一段奇幻冒险。`;
  if (t.includes('电影')) return `${lang}电影《${t}》，精彩故事引人入胜。`;
  if (t.includes('剧')) return `${lang}剧集《${t}》，演绎精彩故事。`;
  return `${lang}影视作品《${t}》，讲述一段精彩故事。`;
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
    id: 'tmdb-tv-' + s.id,
    date: s.first_air_date,
    type,
    event: 'online',
    status: 'done',
    title: `《${s.name}》热播中`,
    summary: zhSummary(s.overview, s.name),
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

export async function onRequestGet(context) {
  const key = context.env.TMDB_API_KEY;
  if (!key) {
    return new Response(JSON.stringify({ code: 500, message: '未配置 TMDB_API_KEY' }), {
      status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  try {
    // 每个分类拉两页，确保有足够多带海报的条目（短剧外其他品类必须有 poster）
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
    (nowPlaying.results || []).slice(0, 14).forEach(m => {
      seen.add('m' + m.id);
      const gids = m.genre_ids || [];
      let type = 'movie';
      for (const id of gids) {
        if (MOVIE_GENRE_TYPE[id]) { type = MOVIE_GENRE_TYPE[id]; break; }
      }
      const genres = gids.map(id => mg[id]).filter(Boolean).join(' / ');
      items.push({
        id: 'tmdb-movie-' + m.id,
        date: m.release_date,
        type,
        event: 'online',
        status: 'done',
        title: `《${m.title}》正在热映`,
        summary: zhSummary(m.overview, m.title),
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
    (upcoming.results || []).slice(0, 14).forEach(m => {
      if (seen.has('m' + m.id)) return;
      const gids = m.genre_ids || [];
      let type = 'movie';
      for (const id of gids) {
        if (MOVIE_GENRE_TYPE[id]) { type = MOVIE_GENRE_TYPE[id]; break; }
      }
      const genres = gids.map(id => mg[id]).filter(Boolean).join(' / ');
      const isPast = new Date(m.release_date) < new Date();
      items.push({
        id: 'tmdb-movie-' + m.id,
        date: m.release_date,
        type,
        event: isPast ? 'online' : 'schedule',
        status: isPast ? 'done' : 'pending',
        title: isPast ? `《${m.title}》正在热映` : `《${m.title}》定档${fmtDate(m.release_date)}`,
        summary: zhSummary(m.overview, m.title),
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
    (docMovies.results || []).slice(0, 10).forEach(m => {
      if (seen.has('m' + m.id) || docSeen.has(m.id)) return;
      docSeen.add(m.id);
      const genres = (m.genre_ids || []).map(id => mg[id]).filter(Boolean).join(' / ');
      items.push({
        id: 'tmdb-docmovie-' + m.id,
        date: m.release_date,
        type: 'doc',
        event: 'online',
        status: 'done',
        title: `《${m.title}》纪录电影热映`,
        summary: zhSummary(m.overview, m.title),
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
    (docTv.results || []).slice(0, 10).forEach(s => {
      if (tvSeen.has(s.id) || docSeen.has(s.id)) return;
      docSeen.add(s.id);
      const genres = (s.genre_ids || []).map(id => tg[id]).filter(Boolean).join(' / ');
      items.push({
        id: 'tmdb-doctv-' + s.id,
        date: s.first_air_date,
        type: 'doc',
        event: 'online',
        status: 'done',
        title: `《${s.name}》纪录片热播中`,
        summary: zhSummary(s.overview, s.name),
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

    // 过滤：①必须有 date；②除短剧（走另一接口）外必须带 poster；③过滤海报不雅观的条目
    const BLOCK_TITLES = ['100个男生与我', '100 Boyfriends', '100 Boyfriends & Me', 'Bonnie Blue'];
    let list = items
      .filter(n => n.date)
      .filter(n => n.poster)
      .filter(n => !BLOCK_TITLES.some(bt => n.title.includes(bt)))
      .filter(n => !BLOCK_TITLES.some(bt => (n.summary || '').includes(bt)))
      .sort((a, b) => new Date(b.date) - new Date(a.date));

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
