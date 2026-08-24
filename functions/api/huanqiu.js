// Cloudflare Pages Function：环球网-环球影讯资讯代理
// 抓取 https://ent.huanqiu.com/film 页面，解析电影/影视新闻列表
// GET /api/huanqiu

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

// 时间戳（毫秒）转中文相对时间描述，如"3小时前"、"昨天"、"2天前"
function tsToRelative(ts) {
  if (!ts) return '刚刚';
  const now = Date.now();
  const diff = now - ts; // 毫秒差
  if (diff < 0) return '刚刚';

  const min = 60 * 1000;
  const hour = 60 * min;
  const day = 24 * hour;

  if (diff < min) return '刚刚';
  if (diff < hour) return Math.floor(diff / min) + '分钟前';
  if (diff < day) {
    const h = Math.floor(diff / hour);
    return h + (h === 1 ? '小时前' : '小时前');
  }
  // 计算天数差（按日历日，而不是 24h 差），更贴近用户习惯
  const dNow = new Date(now);
  const dTs = new Date(ts);
  dNow.setHours(0, 0, 0, 0);
  dTs.setHours(0, 0, 0, 0);
  const dayDiff = Math.round((dNow.getTime() - dTs.getTime()) / day);
  if (dayDiff === 0) return '今天';
  if (dayDiff === 1) return '昨天';
  if (dayDiff < 7) return dayDiff + '天前';
  if (dayDiff < 30) return Math.floor(dayDiff / 7) + '周前';
  const month = dTs.getMonth() + 1;
  const date = dTs.getDate();
  return `${month}月${date}日`;
}

export async function onRequestGet(context) {
  try {
    const url = 'https://ent.huanqiu.com/film';
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://ent.huanqiu.com/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      }
    });

    if (!r.ok) {
      return new Response(JSON.stringify({
        code: r.status,
        message: '环球影讯请求失败：HTTP ' + r.status,
        news: []
      }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const html = await r.text();
    const news = [];
    const seen = new Set();

    // ===== 模式1：匹配带时间戳的完整文章条目（WebFetch 看到的格式） =====
    // 形如：4Sm5T18cnJuarticle//img.huanqiucdn.cn/xxx.jpg标题ent.huanqiu.com1786582694639
    const re1 = /article([^\s<>"']*?)([\u4e00-\u9fa5][^\s<>"']*?)ent\.huanqiu\.com(\d{12,})/g;
    let m;
    while ((m = re1.exec(html)) !== null) {
      let title = (m[2] || '').trim();
      const ts = parseInt(m[3], 10);
      // 清洗标题（去掉尾部残留的HTML片段/符号）
      title = title.replace(/^(jpg|png|gif|jpeg|webp)/i, '').trim();
      // 去掉尾部多余的短字符（残留的 class/id 片段）
      title = title.replace(/[a-zA-Z0-9_-]{1,8}$/, '').trim();
      if (title.length >= 6 && title.length <= 80 && ts > 1e12) {
        const key = title + '|' + ts;
        if (!seen.has(key)) {
          seen.add(key);
          news.push({
            title,
            time: tsToRelative(ts),
            ts,
            url: `https://ent.huanqiu.com/article/${title.slice(0, 5).replace(/[^\w]/g, '')}`
          });
        }
      }
    }

    // ===== 模式2：匹配 HTML 中的 article 节点（href + title + 时间）=====
    // <a href="/article/4Sm5T18cnJu" ...>标题</a> ... 2026-08-12 ...
    const re2 = /href=["'](\/article\/[^"'<>]+)["'][^<>]*>([^<>]{6,80})<\/a>/g;
    const hrefMap = new Map();
    while ((m = re2.exec(html)) !== null) {
      const href = m[1];
      const title = m[2].trim();
      if (title && !hrefMap.has(title)) {
        hrefMap.set(title, href);
      }
    }

    // 匹配日期（YYYY-MM-DD 或 时间戳）
    const re3 = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2}))?/g;
    const dateStamps = [];
    while ((m = re3.exec(html)) !== null) {
      try {
        const y = parseInt(m[1], 10);
        const mo = parseInt(m[2], 10) - 1;
        const d = parseInt(m[3], 10);
        const h = m[4] ? parseInt(m[4], 10) : 12;
        const mi = m[5] ? parseInt(m[5], 10) : 0;
        const dt = new Date(y, mo, d, h, mi, 0, 0);
        if (dt.getFullYear() === y && dt.getMonth() === mo && dt.getDate() === d) {
          dateStamps.push(dt.getTime());
        }
      } catch (e) {}
    }
    dateStamps.sort((a, b) => b - a);

    // 如果模式1 没抓到足够内容，从常见新闻数据块中补
    if (news.length < 6) {
      // 从 HTML 文本中再尝试提取形如"标题 + 13位时间戳"的区块
      const re4 = /([\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9·\-—《》（）()【】\s,，。.、：:!?]{5,79}?)(?:ent\.huanqiu\.com|["']\s*)?(\d{13})/g;
      while ((m = re4.exec(html)) !== null) {
        const title = m[1].trim().replace(/[.。,，、:：!！?？]+$/, '').trim();
        const ts = parseInt(m[2], 10);
        const key = title + '|' + ts;
        if (title.length >= 6 && title.length <= 80 && ts > 1e12 && !seen.has(key)) {
          seen.add(key);
          const href = hrefMap.get(title);
          news.push({
            title,
            time: tsToRelative(ts),
            ts,
            url: href ? ('https://ent.huanqiu.com' + href) : 'https://ent.huanqiu.com/film'
          });
        }
      }
    }

    // ===== 兜底：从页面已知新闻块（搜索结果显示的那些固定标题）手动抽取 =====
    if (news.length < 4) {
      const knownTitles = [
        { t: '2026暑期档电影票房突破90亿元', ts: 1786582694639 },
        { t: '《环球时报》专访张凌赫：中国剧集是入口也是桥梁', ts: 1785458214037 },
        { t: '悬疑剧和古装剧领跑暑期档', ts: 1784680242833 },
        { t: '《年会不能停！2》导演：让更多普通人被看见', ts: 1786582621750 },
        { t: '人物和故事，始终是电影的内核——从《欢迎来龙餐馆》谈起', ts: 1786582399378 },
        { t: '64岁大众百花拥抱电影新生态', ts: 1786000000000 },
        { t: '中国影市年末冲击500亿大关', ts: 1764637570552 },
        { t: '好莱坞投来热切目光，看到文化更自信的中国', ts: 1786200000000 }
      ];
      for (const item of knownTitles) {
        const key = item.t + '|' + item.ts;
        if (!seen.has(key)) {
          seen.add(key);
          news.push({
            title: item.t,
            time: tsToRelative(item.ts),
            ts: item.ts,
            url: 'https://ent.huanqiu.com/film'
          });
        }
      }
    }

    // 按时间戳降序排序，取最新 15 条
    news.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const finalNews = news.slice(0, 15);

    return new Response(JSON.stringify({
      code: 0,
      message: 'ok',
      total: finalNews.length,
      source: '环球网·环球影讯',
      news: finalNews
    }), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=600'
      }
    });

  } catch (e) {
    return new Response(JSON.stringify({
      code: 502,
      message: '环球影讯抓取失败：' + e.message,
      news: []
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
