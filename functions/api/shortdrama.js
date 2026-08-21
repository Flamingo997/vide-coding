// Cloudflare Pages Function：短剧数据接口（来源 kuleu.com，无需key，免费）
// 因 kuleu 仅支持关键词搜索，采用多题材词轮询聚合出「短剧上新清单」。
// GET /api/shortdrama?limit=12

// 常见短剧题材关键词，用于轮询搜索聚合
const KEYWORDS = [
  '恋爱', '穿越', '复仇', '战神', '逆袭',
  '闪婚', '总裁', '甜宠', '千金', '豪门'
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

async function search(keyword) {
  const url = 'https://api.kuleu.com/api/action?text=' + encodeURIComponent(keyword);
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Referer': 'https://www.kuleu.com/' }
  });
  if (!r.ok) return [];
  const j = await r.json();
  if (j && j.code === 200 && Array.isArray(j.data)) return j.data;
  return [];
}

// 由短剧名提取纯剧名（去掉编号/集数/标签后缀），如 "8527-机场爱情故事（100集）" → "机场爱情故事"
function cleanName(raw) {
  let name = raw.replace(/^\s*\d+[-.\s]*/, '').trim();          // 去掉开头编号
  name = name.replace(/（\d+集）.*$/g, '');                       // 去掉（XX集）及后续
  name = name.replace(/[（(]\d+集[)）].*$/, '');
  name = name.replace(/[-–—].*$/, '').trim();
  return name;
}

function fmtDate(addtime) {
  const m = (addtime || '').match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : new Date().toISOString().slice(0, 10);
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '12', 10) || 12, 30);

  try {
    // 批量并发搜索并聚合
    const batches = await Promise.all(KEYWORDS.map(search));
    const flat = batches.flat();
    const seen = new Set();
    const items = [];
    for (const d of flat) {
      const name = cleanName(d.name || '');
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const ep = (d.name || '').match(/(\d+)\s*集/) ? '' : '';
      items.push({
        date: fmtDate(d.addtime),
        type: 'duan',
        event: 'online',
        status: 'released',
        title: `《${name}》短剧上新`,
        summary: (d.name || name) + '，海量短剧持续上新。',
        source: 'kuleu',
        sourceLink: d.viewlink || '#',
        poster: '',
        detail: {
          intro: (d.name || name) + '，点击查看资源链接。',
          cast: '短剧',
          platform: 'kuleu 短剧库 · ' + (ep || '全网短剧'),
          ep: (d.name || '').match(/(\d+)\s*集/) ? '共 ' + RegExp.$1 + ' 集' : '集数见详情'
        }
      });
      if (items.length >= limit) break;
    }

    return new Response(JSON.stringify({
      code: 0,
      message: 'ok',
      total: items.length,
      attribution: '数据来源 kuleu.com（短剧库）',
      data: items
    }), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=600'
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ code: 502, message: '短剧数据获取失败：' + e.message }), {
      status: 502, headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }
}