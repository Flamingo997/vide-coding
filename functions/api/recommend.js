// Cloudflare Pages Function：TMDB 推荐代理
// 基于用户收藏的 TMDB 影片，调用 TMDB recommendations 接口获取相似推荐
// Key 存于 Pages 环境变量 TMDB_API_KEY
// POST /api/recommend  body: { "ids": ["tmdb-movie-123", "tmdb-tv-456"] }
// -> { "code": 0, "data": [site格式 item 数组] }

const BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w342';

const TV_GENRE_TYPE = { 16: 'anime', 99: 'doc', 10764: 'show', 10767: 'show', 10766: 'drama', 10765: 'drama' };
const MOVIE_GENRE_TYPE = { 16: 'anime', 99: 'doc' };

async function tmdb(path, key, lang = 'zh-CN') {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${BASE}${path}${sep}api_key=${key}&language=${lang}`);
  if (!r.ok) throw new Error('TMDB 请求失败: ' + r.status);
  return r.json();
}

function hasChinese(text) {
  return /[\u4e00-\u9fff]/.test(text || '');
}

function pickRecTitle(item, isMovie) {
  const title = isMovie ? item.title : item.name;
  const origTitle = isMovie ? item.original_title : item.original_name;
  const origLang = item.original_language || '';
  if (title && hasChinese(title)) return title;
  if (origLang === 'zh' || origLang === 'cn') return origTitle || title || '未知';
  return title || origTitle || '未知';
}

function mapRec(item, isMovie, genreMap, recCount) {
  if (!item || !item.id) return null;
  const gids = item.genre_ids || [];
  let type = isMovie ? 'movie' : 'drama';
  const genreTypeMap = isMovie ? MOVIE_GENRE_TYPE : TV_GENRE_TYPE;
  for (const id of gids) {
    if (genreTypeMap[id]) { type = genreTypeMap[id]; break; }
  }
  const genres = gids.map(id => genreMap[id]).filter(Boolean).join(' / ');
  const title = pickRecTitle(item, isMovie);
  const overview = (item.overview || '').replace(/\s+/g, ' ').trim() || '暂无简介';
  const date = isMovie ? (item.release_date || '') : (item.first_air_date || '');
  const voteAvg = item.vote_average || 0;
  const voteCount = item.vote_count || 0;
  return {
    id: 'tmdb-rec-' + (isMovie ? 'movie' : 'tv') + '-' + item.id,
    date,
    type,
    title: `《${title}》`,
    summary: overview,
    source: 'TMDB',
    sourceLink: isMovie
      ? `https://www.themoviedb.org/movie/${item.id}`
      : `https://www.themoviedb.org/tv/${item.id}`,
    poster: item.poster_path ? IMG + item.poster_path : '',
    detail: {
      intro: overview,
      cast: genres || '暂无',
      platform: `TMDB ${voteAvg.toFixed(1)} 分（${voteCount} 人评价）`,
      ep: recCount > 1 ? `与 ${recCount} 部收藏相似` : '与收藏相似'
    },
    recCount
  };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const key = env.TMDB_API_KEY;
  if (!key) {
    return jsonResponse({ code: 500, message: '未配置 TMDB_API_KEY' }, 500);
  }

  try {
    const { ids } = await request.json();
    if (!Array.isArray(ids) || ids.length === 0) {
      return jsonResponse({ code: 0, data: [] });
    }

    // 解析 TMDB ID：tmdb-movie-123 / tmdb-tv-456 / tmdb-docmovie-789
    const tmdbItems = ids.map(id => {
      const m = String(id).match(/^tmdb-(movie|tv|docmovie)-(\d+)$/);
      if (!m) return null;
      const isMovie = m[1] === 'movie' || m[1] === 'docmovie';
      return { id: parseInt(m[2]), isMovie };
    }).filter(Boolean);

    if (tmdbItems.length === 0) {
      return jsonResponse({ code: 0, data: [] });
    }

    // 限制最多 8 部，避免 TMDB 速率限制
    const toFetch = tmdbItems.slice(0, 8);

    // 并行请求每部影片的推荐列表
    const results = await Promise.allSettled(
      toFetch.map(async ({ id, isMovie }) => {
        const path = isMovie ? `/movie/${id}/recommendations` : `/tv/${id}/recommendations`;
        const data = await tmdb(path, key, 'zh-CN');
        return (data.results || []).slice(0, 10).map(r => ({ ...r, _isMovie: isMovie }));
      })
    );

    // 汇总去重，统计推荐频次
    const freqMap = new Map();
    for (const result of results) {
      if (result.status !== 'fulfilled' || !result.value) continue;
      for (const item of result.value) {
        const k = (item._isMovie ? 'm' : 't') + '-' + item.id;
        if (freqMap.has(k)) {
          freqMap.get(k).count++;
        } else {
          freqMap.set(k, { item, isMovie: item._isMovie, count: 1 });
        }
      }
    }

    // 获取 genre 映射表（用于流派名称和类型分类）
    const [movieGenres, tvGenres] = await Promise.all([
      tmdb('/genre/movie/list', key, 'zh-CN').catch(() => ({ genres: [] })),
      tmdb('/genre/tv/list', key, 'zh-CN').catch(() => ({ genres: [] }))
    ]);
    const mg = Object.fromEntries((movieGenres.genres || []).map(g => [g.id, g.name]));
    const tg = Object.fromEntries((tvGenres.genres || []).map(g => [g.id, g.name]));

    // 转换为站点格式，按频次降序 -> 评分降序
    const recommendations = [...freqMap.values()]
      .map(({ item, isMovie, count }) => mapRec(item, isMovie, isMovie ? mg : tg, count))
      .filter(r => r && r.poster && r.summary !== '暂无简介')
      .sort((a, b) => {
        if (b.recCount !== a.recCount) return b.recCount - a.recCount;
        const va = parseFloat(a.detail.platform?.match(/[\d.]+/)?.[0] || 0);
        const vb = parseFloat(b.detail.platform?.match(/[\d.]+/)?.[0] || 0);
        return vb - va;
      })
      .slice(0, 20);

    return jsonResponse({ code: 0, total: recommendations.length, data: recommendations });
  } catch (e) {
    return jsonResponse({ code: 502, message: '推荐获取失败: ' + (e.message || String(e)) }, 502);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
