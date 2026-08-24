// Cloudflare Pages Function：TMDB 真实影视数据接口
// GET /api/tmdb  返回本站时间线格式的真实影视上新数据
// 数据来源：TMDB（themoviedb.org），Key 存于 Pages 环境变量 TMDB_API_KEY
// 品类映射：电影 movie / 电视剧 drama / 综艺 show / 动漫 anime / 纪录片 doc

const BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w342';

const TV_GENRE_TYPE = {
  16: 'anime',
  99: 'doc',
  10764: 'show',
  10767: 'show',
  10766: 'drama',
  10765: 'drama'
};
const MOVIE_GENRE_TYPE = {
  16: 'anime',
  99: 'doc'
};

// 双语言并行请求：zh-CN 优先，en-US 兜底
async function tmdb(path, key, lang = 'zh-CN') {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${BASE}${path}${sep}api_key=${key}&language=${lang}`);
  if (!r.ok) throw new Error('TMDB 请求失败: ' + r.status);
  return r.json();
}

function cut(text, len) {
  if (!text) return '';
  return text.length > len ? text.slice(0, len) + '…' : text;
}

function hasChinese(text) {
  return /[\u4e00-\u9fff]/.test(text || '');
}

// 返回完整简介（仅清理空白）
function zhSummary(overview) {
  if (!overview) return '';
  return overview.replace(/\s+/g, ' ').trim();
}

function fmtDate(dateStr) {
  const d = new Date(dateStr);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

// 合并中英文结果：中文 overview 优先，空则用英文
function pickOverview(zhItem, enItem) {
  if (zhItem && zhItem.overview && hasChinese(zhItem.overview)) return zhItem.overview;
  if (enItem && enItem.overview) return enItem.overview;
  return '';
}

// 选取标题：华语用原名，其他用英文标题
function pickTitle(zhItem, enItem, isMovie) {
  const zh = zhItem || {};
  const en = enItem || {};
  const origTitle = isMovie ? (zh.original_title || en.original_title) : (zh.original_name || en.original_name);
  const zhTitle = isMovie ? zh.title : zh.name;
  const enTitle = isMovie ? en.title : en.name;
  const origLang = zh.original_language || en.original_language || '';
  // 华语内容用中文名
  if (origLang === 'zh' || origLang === 'cn') return origTitle || zhTitle || enTitle || '未知';
  // 非华语：优先英文标题
  return enTitle || zhTitle || origTitle || '未知';
}

function mapShow(zhItem, enItem, genreNames) {
  const s = zhItem || enItem;
  if (!s) return null;
  const gids = s.genre_ids || [];
  let type = 'drama';
  for (const id of gids) {
    if (TV_GENRE_TYPE[id]) { type = TV_GENRE_TYPE[id]; break; }
  }
  const genres = gids.map(id => genreNames[id]).filter(Boolean).join(' / ');
  const title = pickTitle(zhItem, enItem, false);
  const overview = pickOverview(zhItem, enItem);
  return {
    id: 'tmdb-tv-' + s.id,
    date: s.first_air_date,
    type,
    event: 'online',
    status: 'done',
    title: `《${title}》热播中`,
    summary: zhSummary(overview),
    source: 'TMDB',
    sourceLink: `https://www.themoviedb.org/tv/${s.id}`,
    poster: s.poster_path ? IMG + s.poster_path : '',
    detail: {
      intro: overview,
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
    // 双语言并行请求：zh-CN + en-US
    // 日期过滤：first_air_date.gte=2026-06-01 确保只返回2026年6月后开播的内容
    const DATE_GTE = '2026-06-01';
    const DATE_LTE = '2026-12-31';
    const MOVIE_DATE_GTE = '2026-06-01';
    const MOVIE_DATE_LTE = '2026-12-31';

    const [
      nowPlayingZh, nowPlayingEn,
      upcomingZh, upcomingEn,
      onAirZh, onAirEn,
      // 电视剧（drama）：按日期过滤的 discover 替代旧的 tv/popular
      dramaDiscoverZh, dramaDiscoverEn,
      // 动漫（anime）：新增专属 discover 请求
      animeDiscoverZh, animeDiscoverEn,
      // 综艺（show）：加日期过滤
      showZh, showEn,
      // 纪录片电影（doc）：加日期过滤
      docMoviesZh, docMoviesEn,
      // 纪录片剧集（doc）：加日期过滤
      docTvZh, docTvEn,
      movieGenres, tvGenres
    ] = await Promise.all([
      tmdb('/movie/now_playing?region=CN&page=1', key, 'zh-CN'),
      tmdb('/movie/now_playing?region=CN&page=1', key, 'en-US'),
      tmdb('/movie/upcoming?region=CN&page=1', key, 'zh-CN'),
      tmdb('/movie/upcoming?region=CN&page=1', key, 'en-US'),
      tmdb('/tv/on_the_air?page=1', key, 'zh-CN'),
      tmdb('/tv/on_the_air?page=1', key, 'en-US'),
      // 电视剧：genre 10766(剧情) 10765(肥皂)，日期>=2026-06-01
      tmdb(`/discover/tv?with_genres=10766,10765&first_air_date.gte=${DATE_GTE}&first_air_date.lte=${DATE_LTE}&sort_by=popularity.desc&page=1`, key, 'zh-CN'),
      tmdb(`/discover/tv?with_genres=10766,10765&first_air_date.gte=${DATE_GTE}&first_air_date.lte=${DATE_LTE}&sort_by=popularity.desc&page=1`, key, 'en-US'),
      // 动漫：genre 16(动画)，日期>=2026-06-01
      tmdb(`/discover/tv?with_genres=16&first_air_date.gte=${DATE_GTE}&first_air_date.lte=${DATE_LTE}&sort_by=popularity.desc&page=1`, key, 'zh-CN'),
      tmdb(`/discover/tv?with_genres=16&first_air_date.gte=${DATE_GTE}&first_air_date.lte=${DATE_LTE}&sort_by=popularity.desc&page=1`, key, 'en-US'),
      // 综艺：genre 10764(真人秀) 10767(脱口秀)，日期>=2026-06-01
      tmdb(`/discover/tv?with_genres=10764,10767&first_air_date.gte=${DATE_GTE}&first_air_date.lte=${DATE_LTE}&sort_by=popularity.desc&page=1`, key, 'zh-CN'),
      tmdb(`/discover/tv?with_genres=10764,10767&first_air_date.gte=${DATE_GTE}&first_air_date.lte=${DATE_LTE}&sort_by=popularity.desc&page=1`, key, 'en-US'),
      // 纪录片电影：genre 99，日期>=2026-06-01
      tmdb(`/discover/movie?with_genres=99&primary_release_date.gte=${MOVIE_DATE_GTE}&primary_release_date.lte=${MOVIE_DATE_LTE}&sort_by=popularity.desc&page=1`, key, 'zh-CN'),
      tmdb(`/discover/movie?with_genres=99&primary_release_date.gte=${MOVIE_DATE_GTE}&primary_release_date.lte=${MOVIE_DATE_LTE}&sort_by=popularity.desc&page=1`, key, 'en-US'),
      // 纪录片剧集：genre 99，日期>=2026-06-01
      tmdb(`/discover/tv?with_genres=99&first_air_date.gte=${DATE_GTE}&first_air_date.lte=${DATE_LTE}&sort_by=popularity.desc&page=1`, key, 'zh-CN'),
      tmdb(`/discover/tv?with_genres=99&first_air_date.gte=${DATE_GTE}&first_air_date.lte=${DATE_LTE}&sort_by=popularity.desc&page=1`, key, 'en-US'),
      tmdb('/genre/movie/list', key, 'zh-CN'),
      tmdb('/genre/tv/list', key, 'zh-CN')
    ]);

    const mg = Object.fromEntries((movieGenres.genres || []).map(g => [g.id, g.name]));
    const tg = Object.fromEntries((tvGenres.genres || []).map(g => [g.id, g.name]));

    // 构建 ID -> 英文条目 的索引（用于 fallback）
    const enMovieMap = new Map();
    (nowPlayingEn.results || []).forEach(m => enMovieMap.set(m.id, m));
    (upcomingEn.results || []).forEach(m => enMovieMap.set(m.id, m));
    (docMoviesEn.results || []).forEach(m => enMovieMap.set(m.id, m));

    const enTvMap = new Map();
    (onAirEn.results || []).forEach(s => enTvMap.set(s.id, s));
    (dramaDiscoverEn.results || []).forEach(s => enTvMap.set(s.id, s));
    (animeDiscoverEn.results || []).forEach(s => enTvMap.set(s.id, s));
    (docTvEn.results || []).forEach(s => enTvMap.set(s.id, s));
    (showEn.results || []).forEach(s => enTvMap.set(s.id, s));

    const items = [];
    const seen = new Set();

    // 正在热映
    (nowPlayingZh.results || []).slice(0, 14).forEach(m => {
      seen.add('m' + m.id);
      const en = enMovieMap.get(m.id) || {};
      const gids = m.genre_ids || en.genre_ids || [];
      let type = 'movie';
      for (const id of gids) {
        if (MOVIE_GENRE_TYPE[id]) { type = MOVIE_GENRE_TYPE[id]; break; }
      }
      const genres = gids.map(id => mg[id]).filter(Boolean).join(' / ');
      const title = pickTitle(m, en, true);
      const overview = pickOverview(m, en);
      items.push({
        id: 'tmdb-movie-' + m.id,
        date: m.release_date,
        type,
        event: 'online',
        status: 'done',
        title: `《${title}》正在热映`,
        summary: zhSummary(overview),
        source: 'TMDB',
        sourceLink: `https://www.themoviedb.org/movie/${m.id}`,
        poster: (m.poster_path || en.poster_path) ? IMG + (m.poster_path || en.poster_path) : '',
        detail: {
          intro: overview,
          cast: genres || '暂无',
          platform: `TMDB 评分：${(m.vote_average || en.vote_average || 0).toFixed(1)}（${m.vote_count || en.vote_count || 0} 人评价）`,
          ep: (m.original_language || en.original_language) === 'zh' ? '华语影片' : '外语影片'
        }
      });
    });

    // 即将上映
    (upcomingZh.results || []).slice(0, 14).forEach(m => {
      if (seen.has('m' + m.id)) return;
      const en = enMovieMap.get(m.id) || {};
      const gids = m.genre_ids || en.genre_ids || [];
      let type = 'movie';
      for (const id of gids) {
        if (MOVIE_GENRE_TYPE[id]) { type = MOVIE_GENRE_TYPE[id]; break; }
      }
      const genres = gids.map(id => mg[id]).filter(Boolean).join(' / ');
      const title = pickTitle(m, en, true);
      const overview = pickOverview(m, en);
      const isPast = new Date(m.release_date || en.release_date) < new Date();
      items.push({
        id: 'tmdb-movie-' + m.id,
        date: m.release_date || en.release_date,
        type,
        event: isPast ? 'online' : 'schedule',
        status: isPast ? 'done' : 'pending',
        title: isPast ? `《${title}》正在热映` : `《${title}》定档${fmtDate(m.release_date || en.release_date)}`,
        summary: zhSummary(overview),
        source: 'TMDB',
        sourceLink: `https://www.themoviedb.org/movie/${m.id}`,
        poster: (m.poster_path || en.poster_path) ? IMG + (m.poster_path || en.poster_path) : '',
        detail: {
          intro: overview,
          cast: genres || '暂无',
          platform: `TMDB 评分：${(m.vote_average || en.vote_average || 0).toFixed(1)}（${m.vote_count || en.vote_count || 0} 人评价）`,
          ep: (m.original_language || en.original_language) === 'zh' ? '华语影片' : '外语影片'
        }
      });
    });

    // 正在播出 + 各分类 discover 结果（电视剧/动漫/综艺/纪录片）
    const tvSeen = new Set();
    const allTvResults = [
      ...(onAirZh.results || []),
      ...(dramaDiscoverZh.results || []),
      ...(animeDiscoverZh.results || []),
      ...(showZh.results || [])
    ];
    allTvResults.forEach(s => {
      if (tvSeen.has(s.id)) return;
      tvSeen.add(s.id);
      const en = enTvMap.get(s.id) || {};
      const item = mapShow(s, en, tg);
      if (item) items.push(item);
    });

    // 纪录片
    const docSeen = new Set();
    (docMoviesZh.results || []).slice(0, 10).forEach(m => {
      if (seen.has('m' + m.id) || docSeen.has(m.id)) return;
      docSeen.add(m.id);
      const en = enMovieMap.get(m.id) || {};
      const gids = m.genre_ids || en.genre_ids || [];
      const genres = gids.map(id => mg[id]).filter(Boolean).join(' / ');
      const title = pickTitle(m, en, true);
      const overview = pickOverview(m, en);
      items.push({
        id: 'tmdb-docmovie-' + m.id,
        date: m.release_date || en.release_date,
        type: 'doc',
        event: 'online',
        status: 'done',
        title: `《${title}》纪录电影热映`,
        summary: zhSummary(overview),
        source: 'TMDB',
        sourceLink: `https://www.themoviedb.org/movie/${m.id}`,
        poster: (m.poster_path || en.poster_path) ? IMG + (m.poster_path || en.poster_path) : '',
        detail: {
          intro: overview,
          cast: genres || '纪录',
          platform: `TMDB 评分：${(m.vote_average || en.vote_average || 0).toFixed(1)}（${m.vote_count || en.vote_count || 0} 人评价）`,
          ep: (m.original_language || en.original_language) === 'zh' ? '华语纪录片' : '海外纪录片'
        }
      });
    });
    (docTvZh.results || []).slice(0, 10).forEach(s => {
      if (tvSeen.has(s.id) || docSeen.has(s.id)) return;
      docSeen.add(s.id);
      const en = enTvMap.get(s.id) || {};
      const item = mapShow(s, en, tg);
      if (item) {
        item.type = 'doc';
        item.title = `《${pickTitle(s, en, false)}》纪录片热播中`;
        items.push(item);
      }
    });

    // 过滤
    const BLOCK_TITLES = ['100个男生与我', '100 Boyfriends', 'Bonnie Blue', 'Doble tentación', 'Doble Tentación'];
    // 全局日期下限：所有内容必须 >= 2026-01-01，杜绝年代久远的影片混入
    const MIN_DATE = '2026-01-01';
    let list = items
      .filter(n => n.date && n.date >= MIN_DATE)   // 日期下限：2026年起
      .filter(n => n.poster)
      .filter(n => !BLOCK_TITLES.some(bt => n.title.includes(bt)))
      .filter(n => !BLOCK_TITLES.some(bt => (n.summary || '').includes(bt)))
      .sort((a, b) => new Date(b.date) - new Date(a.date));

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
