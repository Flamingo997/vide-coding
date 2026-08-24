// Cloudflare Pages Function：猫眼专业版实时票房数据代理
// 代理 https://piaofang.maoyan.com/getBoxList 接口，添加必要的请求头
// GET /api/maoyan

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

export async function onRequestGet(context) {
  try {
    // 尝试多个猫眼接口端点
    const endpoints = [
      'https://piaofang.maoyan.com/getBoxList?date=1&isSplit=true',
      'https://piaofang.maoyan.com/dashboard-ajax/movie'
    ];

    let j = null;
    let rawList = [];

    for (const url of endpoints) {
      try {
        const r = await fetch(url, {
          headers: {
            'User-Agent': UA,
            'Referer': 'https://piaofang.maoyan.com/dashboard/movie',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'zh-CN,zh;q=0.9'
          }
        });
        if (!r.ok) continue;
        j = await r.json();
        // 尝试多种返回格式
        rawList = (j?.data?.list) || (j?.movieList?.list) || (j?.data?.movieList?.list) || [];
        if (rawList.length > 0) break;
      } catch (e) {
        continue;
      }
    }

    // 如果仍为空，返回原始响应以便调试
    if (rawList.length === 0) {
      return new Response(JSON.stringify({
        code: 0,
        message: '猫眼返回数据为空或格式不匹配',
        debug: { keys: j ? Object.keys(j) : [], sample: j ? JSON.stringify(j).slice(0, 500) : null },
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
      const boxDesc = item.boxDesc || '';           // 当日票房（如 "2205.9万"）
      const sumBoxDesc = item.sumBoxDesc || '';      // 累计票房（如 "4.73亿"）
      const boxRate = item.boxRate || '';            // 票房占比（如 "30.5%"）
      const showCount = item.showCount || 0;         // 排片场次
      const showRate = item.showRate || '';          // 排片占比
      const releaseInfo = item.releaseInfo || info.releaseInfo || ''; // 上映天数
      const movieName = info.movieName || '';

      // 解析当日票房数值（万）
      let boxWan = 0;
      const m = boxDesc.match(/([\d.]+)\s*万/);
      if (m) boxWan = parseFloat(m[1]);
      else {
        const m2 = boxDesc.match(/([\d.]+)\s*亿/);
        if (m2) boxWan = parseFloat(m2[1]) * 10000;
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

    // 计算实时大盘（所有电影当日票房之和）
    const totalBoxWan = movies.reduce((s, m) => s + m.boxWan, 0);
    const totalBoxYi = (totalBoxWan / 10000).toFixed(2);

    // 当前时间
    const now = new Date();
    const timeStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;

    return new Response(JSON.stringify({
      code: 0,
      message: 'ok',
      updateTime: timeStr,
      totalBoxWan,
      totalBoxYi,
      totalBoxDesc: totalBoxYi + ' 亿',
      movies: movies.slice(0, 10),
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
