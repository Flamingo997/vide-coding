// Cloudflare Pages Function：环球网-环球影讯资讯代理
// 第一优先：调用官方 JSON 接口 /api/list2?node=/e3pmh1jtb/fs9nk6km6 拉取最新 24 条影讯
// 失败回退：抓取 https://ent.huanqiu.com/film 页面，按 HTML 正则解析 + 兜底库
// GET /api/huanqiu

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

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
    return h + '小时前';
  }
  // 按日历日差显示，更贴近用户习惯
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

// 环球网官方影讯列表接口（node 值由浏览器抓包分析得到，代表环球影讯栏目）
const OFFICIAL_JSON_API = 'https://ent.huanqiu.com/api/list2?node=/e3pmh1jtb/fs9nk6km6&offset=0&limit=24';

// 失败时的静态兜底库（2026-08-21 截图中的新闻，以防接口改 node 或临时挂）
const FALLBACK_NEWS = [
  { title: '亚马逊意外泄露杰森·斯坦森新片',                   ts: 1787297340000 },
  { title: '一句"好好吃饭"，安放中国人温情大义',               ts: 1787273280000 },
  { title: '评《藏锋》：在藏锋与亮剑之间',                     ts: 1787273220000 },
  { title: '诺兰版奥德修斯与儒家展开"对话"？',                 ts: 1787272200000 },
  { title: '年轻创作者借国产AI圆影视梦',                       ts: 1787272080000 },
  { title: '韩媒：IMAX领跑，高端影厅成韩国票房回暖引擎',      ts: 1787191200000 },
  { title: '致敬法律人的热血——谈电视剧《重器》的拍摄',         ts: 1787181360000 },
  { title: '微短剧精品化不能过度依赖数据反馈',                 ts: 1787095620000 },
  { title: '微短剧出海下半场：从"规模"到"价值"的惊险一跃',    ts: 1787095260000 },
  { title: '评《痴迷》：痴迷不是爱的真意',                     ts: 1787094780000 },
  { title: '2026暑期档电影票房突破90亿元',                    ts: 1786582694639 },
  { title: '《年会不能停！2》导演：让更多普通人被看见',        ts: 1786582621750 }
];

// 统一请求头（模仿真实浏览器，绕过环球网反爬）
const BROWSER_HEADERS = {
  'User-Agent': UA,
  'Referer': 'https://ent.huanqiu.com/film',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'sec-ch-ua': '"Not)A;Brand";v="99", "Google Chrome";v="128", "Chromium";v="128"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'X-Requested-With': 'XMLHttpRequest'
};

// 噪声过滤：过滤非影视资讯或导航类标题
function isNoiseTitle(t) {
  return /邮箱|电话|编辑|联系方式|版权|关注我们|扫码|微信公众号|责编|记者|环球网首页|登录|注册|返回顶部/.test(t);
}

export async function onRequestGet(context) {
  const news = [];
  const seen = new Set();

  function addOne({ title, ts, url, source }) {
    if (!title || !ts || !(ts > 1e12)) return false;
    const clean = (String(title) || '').trim();
    if (clean.length < 5 || clean.length > 160) return false;
    if (isNoiseTitle(clean)) return false;
    const key = clean + '|' + Math.floor(Number(ts) / 1000); // 用秒级去重，避免因毫秒差导致重复
    if (seen.has(key)) return false;
    seen.add(key);
    news.push({
      title: clean,
      time: tsToRelative(Number(ts)),
      ts: Number(ts),
      url: url || ('https://ent.huanqiu.com/film')
    });
    return true;
  }

  try {
    // =========================
    // 阶段一：优先调用官方 JSON 接口
    // =========================
    let jsonData = null;
    try {
      const r1 = await fetch(OFFICIAL_JSON_API, {
        headers: BROWSER_HEADERS,
        cf: { cacheTtl: 120, cacheEverything: true }
      });
      if (r1.ok) {
        jsonData = await r1.json();
      }
    } catch (_) { jsonData = null; }

    if (jsonData && Array.isArray(jsonData.list)) {
      for (const item of jsonData.list) {
        if (!item || !item.aid || !item.title) continue;
        const ts = Number(item.xtime || item.ctime || 0);
        const url = `https://ent.huanqiu.com/article/${item.aid}`;
        addOne({
          title: String(item.title || ''),
          ts,
          url,
          source: item.source?.name
        });
      }
    }

    // =========================
    // 阶段二：JSON 接口不够10条时，回退抓取 HTML 解析
    // =========================
    if (news.length < 10) {
      try {
        const r2 = await fetch('https://ent.huanqiu.com/film', {
          headers: { ...BROWSER_HEADERS, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
          cf: { cacheTtl: 180 }
        });
        if (r2.ok) {
          const html = await r2.text();
          const hrefMap = new Map();
          let m;
          const reHref = /href=["'](\/article\/[^"'<>]+)["'][^<>]*?>\s*([^<>]{6,100}?)\s*<\/a>/g;
          while ((m = reHref.exec(html)) !== null) {
            const href = m[1]; const title = m[2].trim();
            if (title && title.length <= 100 && !hrefMap.has(title)) hrefMap.set(title, href);
          }
          const plain = html.replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ');
          const pattern = /([\u4e00-\u9fa5《][\u4e00-\u9fa5A-Za-z0-9·\-—：:、，。""''《》（）()【】\s?!！？,]{6,120})(?:ent\.huanqiu\.com)?(\d{13})/gi;
          let mm;
          while ((mm = pattern.exec(plain)) !== null) {
            const ts = parseInt(mm[2], 10);
            const title = mm[1].replace(/[.。,，、:：\s]+$/g,'').trim();
            addOne({
              title, ts,
              url: hrefMap.has(title) ? ('https://ent.huanqiu.com' + hrefMap.get(title)) : undefined
            });
          }
        }
      } catch (_) { /* ignore HTML fallback failure */ }
    }

    // =========================
    // 阶段三：以上都失败时，用静态兜底库（数量 < 10 才触发）
    // =========================
    if (news.length < 10) {
      for (const item of FALLBACK_NEWS) {
        addOne({ title: item.title, ts: item.ts });
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
        'Cache-Control': 'public, s-maxage=180, max-age=180' // 3分钟 CDN 缓存（实时更新）
      }
    });

  } catch (e) {
    // 完全挂了也返回兜底数据（带正确时间），前端不至于空列表
    const fb = FALLBACK_NEWS.slice(0, 12).map(n => ({
      title: n.title,
      time: tsToRelative(n.ts),
      ts: n.ts,
      url: 'https://ent.huanqiu.com/film'
    }));
    return new Response(JSON.stringify({
      code: 206,
      message: '官方接口异常，已返回静态兜底：' + (e.message || 'unknown'),
      total: fb.length,
      source: '环球网·环球影讯（兜底）',
      news: fb
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=60'
      }
    });
  }
}
