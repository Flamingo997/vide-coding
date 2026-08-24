// Cloudflare Pages Function：猫眼专业版实时票房数据代理
// 代理 https://piaofang.maoyan.com/getBoxList 接口，添加必要的请求头
// GET /api/maoyan

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

export async function onRequestGet(context) {
  try {
    // 猫眼实时票房列表接口
    const url = 'https://piaofang.maoyan.com/getBoxList?date=1&isSplit=true';
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://piaofang.maoyan.com/dashboard/movie',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      }
    });

    if (!r.ok) {
      return new Response(JSON.stringify({ code: r.status, message: '猫眼接口请求失败' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    const j = await r.json();

    // 提取票房列表
    const rawList = j?.data?.list || [];

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
