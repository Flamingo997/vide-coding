// Cloudflare Pages Function：猫眼专业版实时票房数据代理
// 代理 https://piaofang.maoyan.com/getBoxList 接口，添加必要的请求头
// GET /api/maoyan
// 海报补全：猫眼不返回海报，服务端按片名查 TMDB search/movie 取 poster_path（5s 超时，失败留空走前端兜底）

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const TMDB_POSTER_BASE = 'https://image.tmdb.org/t/p/w185';

// 清洗片名用于 TMDB 搜索：去掉全半角标点（八仙！→八仙、蜘蛛侠：崭新之日→蜘蛛侠崭新之日）
function cleanNameForSearch(name) {
  return String(name || '').replace(/[！!？?：:；;，,、《》""''（）()·\s]/g, '').trim();
}

// 按片名查 TMDB 海报：优先选近两年上映的同名结果（票房榜都是在映片），取第一张可用海报
async function fetchTmdbPoster(name, apiKey) {
  const q = cleanNameForSearch(name);
  if (!q || !apiKey) return '';
  try {
    const r = await fetch(
      `https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&language=zh-CN&query=${encodeURIComponent(q)}&include_adult=false&page=1`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!r.ok) return '';
    const j = await r.json();
    const results = (j.results || []).filter(x => x.poster_path);
    if (!results.length) return '';
    // 排序：有发布日期的优先，日期新的在前（在映片）
    const now = Date.now();
    results.sort((a, b) => {
      const ta = a.release_date ? new Date(a.release_date).getTime() : 0;
      const tb = b.release_date ? new Date(b.release_date).getTime() : 0;
      // 未来日期或太老（>3年）降权
      const score = t => (t > 0 && t <= now && now - t < 3 * 365 * 864e5) ? t : 0;
      return score(tb) - score(ta);
    });
    return TMDB_POSTER_BASE + results[0].poster_path;
  } catch (_) {
    return '';
  }
}

export async function onRequestGet(context) {
  try {
    // 端点1优先：getBoxList 返回纯数字 boxDesc，无需字体解码
    // 端点2备用：dashboard-ajax 返回加密字符，作为兜底
    const url1 = 'https://piaofang.maoyan.com/getBoxList?date=1&isSplit=true';

    let j = null;
    let rawList = [];
    let nationalBox = null;
    let updateInfo = null;
    let apiSource = 'none';

    const headers = {
      'User-Agent': UA,
      'Referer': 'https://piaofang.maoyan.com/dashboard/movie',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    };

    // ========== 尝试端点1：getBoxList（推荐，返回纯数字） ==========
    try {
      const r1 = await fetch(url1, { headers });
      if (r1.ok) {
        const j1 = await r1.json();
        // getBoxList 返回结构：{ status:true, boxOffice:{ data:{ list:[], nationalBox:{num,unit}, updateInfo:{} } } }
        const list1 = j1?.boxOffice?.data?.list || [];
        if (list1.length > 0) {
          j = j1;
          rawList = list1;
          nationalBox = j1?.boxOffice?.data?.nationalBox || null;
          updateInfo = j1?.boxOffice?.data?.updateInfo || null;
          apiSource = 'getBoxList';
        }
      }
    } catch (e) {
      // 忽略，继续尝试备用
    }

    // ========== 尝试端点2：dashboard-ajax/movie（兜底，需字体解码） ==========
    if (rawList.length === 0) {
      try {
        const url2 = 'https://piaofang.maoyan.com/dashboard-ajax/movie';
        const r2 = await fetch(url2, { headers });
        if (r2.ok) {
          const j2 = await r2.json();
          const list2 = j2?.movieList?.list || j2?.data?.movieList?.list || [];
          if (list2.length > 0) {
            j = j2;
            rawList = list2;
            apiSource = 'dashboard-ajax';
          }
        }
      } catch (e) {
        // 忽略
      }
    }

    // 如果仍为空，返回原始响应以便调试
    if (rawList.length === 0) {
      return new Response(JSON.stringify({
        code: 0,
        message: '猫眼返回数据为空或格式不匹配',
        debug: {
          keys: j ? Object.keys(j) : [],
          boxOfficeKeys: j?.boxOffice?.data ? Object.keys(j.boxOffice.data) : [],
          sample: j ? JSON.stringify(j).slice(0, 800) : null
        },
        movies: [],
        source: '猫眼专业版'
      }), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // 解析每部电影的票房数据
    const movies = rawList.map((item, idx) => {
      const info = item.movieInfo || {};
      let boxDesc = item.boxDesc || '';          // getBoxList: 纯数字如 "2326.67"（万）
      const sumBoxDesc = item.sumBoxDesc || '';   // 累计票房（如 "16.02亿"）
      const boxRate = item.boxRate || item.boxSplitRate || ''; // 票房占比
      const showCount = item.showCount || 0;      // 排片场次
      const showRate = item.showCountRate || item.showRate || ''; // 排片占比
      const releaseInfo = info.releaseInfo || item.releaseInfo || ''; // 上映天数
      const movieName = info.movieName || '';

      // getBoxList 的 boxDesc 是纯数字（万），需要自己加单位
      let boxWan = 0;
      if (apiSource === 'getBoxList') {
        boxWan = parseFloat(boxDesc) || 0;
        // 超过 10000 万 = 1 亿，格式化为亿，否则万
        if (boxWan >= 10000) {
          boxDesc = (boxWan / 10000).toFixed(2) + '亿';
        } else {
          // 保留一位或两位小数
          boxDesc = boxWan.toFixed(boxWan >= 100 ? 1 : 2).replace(/\.0$/, '') + '万';
        }
      } else {
        // dashboard-ajax: 尝试匹配字符串
        const m = String(boxDesc).match(/([\d.]+)\s*万/);
        if (m) boxWan = parseFloat(m[1]);
        else {
          const m2 = String(boxDesc).match(/([\d.]+)\s*亿/);
          if (m2) boxWan = parseFloat(m2[1]) * 10000;
        }
      }

      return {
        rank: idx + 1,
        name: movieName,
        boxDesc,
        boxWan,
        sumBoxDesc,
        boxRate,
        showCount,
        showRate,
        releaseInfo
      };
    });

    // 计算实时大盘
    let totalBoxWan = 0;
    let totalBoxYi = '0.00';
    let totalBoxDesc = '0.00 亿';

    // 如果 getBoxList 返回了 nationalBox，优先使用
    if (nationalBox?.num && nationalBox?.unit) {
      const n = parseFloat(nationalBox.num);
      if (nationalBox.unit === '万') {
        totalBoxWan = n;
        totalBoxYi = (n / 10000).toFixed(2);
        totalBoxDesc = totalBoxYi + ' 亿';
      } else if (nationalBox.unit === '亿') {
        totalBoxWan = n * 10000;
        totalBoxYi = n.toFixed(2);
        totalBoxDesc = totalBoxYi + ' 亿';
      }
    } else {
      // 否则累加各电影票房
      totalBoxWan = movies.reduce((s, m) => s + m.boxWan, 0);
      totalBoxYi = (totalBoxWan / 10000).toFixed(2);
      totalBoxDesc = totalBoxYi + ' 亿';
    }

    // 更新时间
    let timeStr;
    if (updateInfo?.time) {
      timeStr = updateInfo.time; // 猫眼返回如 "15:33:08"
    } else {
      const now = new Date();
      timeStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
    }

    // 海报补全：猫眼不返回海报，按片名并发查 TMDB（失败留空，前端兜底本地匹配/默认海报）
    const topMovies = movies.slice(0, 10);
    if (context.env?.TMDB_API_KEY) {
      const posters = await Promise.all(topMovies.map(m => fetchTmdbPoster(m.name, context.env.TMDB_API_KEY)));
      topMovies.forEach((m, i) => { m.poster = posters[i] || ''; });
    }

    return new Response(JSON.stringify({
      code: 0,
      message: 'ok',
      apiSource,
      updateTime: timeStr,
      totalBoxWan: Math.round(totalBoxWan * 100) / 100,
      totalBoxYi,
      totalBoxDesc,
      movies: topMovies,
      source: '猫眼专业版'
    }), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300'
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ code: 502, message: '猫眼数据获取失败：' + e.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }
}
