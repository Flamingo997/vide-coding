// Cloudflare Pages Function：每日影讯简报生成
// 接收前端筛选好的当日条目 + 用户画像，调用 DeepSeek 生成三平台推文
// POST /api/daily-brief
// body: {
//   items: [{ title, summary, type, date, event }],  // 筛选后的 Top 条目
//   boxOffice: { total, topMovie, topBox },           // 票房大盘（可选）
//   news: ["热点标题1", ...],                          // 今日热点影讯（可选）
//   profile: "用户偏好描述"                             // 画像摘要（可选）
// }
// -> { code: 0, data: { x, weibo, xiaohongshu } }

import OpenAI from 'openai';
import { DAILY_BRIEF_PROMPT } from '../_lib/prompts.js';

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

  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return jsonResponse({ code: 500, message: '未配置 DEEPSEEK_API_KEY' }, 500);
  }

  try {
    const { items, boxOffice, news, profile } = await request.json();
    if (!Array.isArray(items) || items.length === 0) {
      return jsonResponse({ code: 400, message: '缺少 items 参数' }, 400);
    }

    // 组装用户输入
    const parts = [];
    if (profile) parts.push(`【用户偏好】${profile}`);
    parts.push('【今日精选条目】');
    items.slice(0, 6).forEach((it, i) => {
      parts.push(`${i + 1}. ${it.title}（${it.eventName || it.event || ''}，${it.date || ''}）${it.summary || ''}`);
    });
    if (boxOffice && boxOffice.total) {
      let boxLine = `【票房大盘】今日大盘 ${boxOffice.total}`;
      if (Array.isArray(boxOffice.top) && boxOffice.top.length > 0) {
        const tops = boxOffice.top.map(m => `${m.name} ${m.box || ''}`).filter(Boolean).join('、');
        boxLine += `，票房前三：${tops}`;
      }
      parts.push(boxLine);
    }
    if (Array.isArray(news) && news.length > 0) {
      parts.push('【今日热点影讯】');
      news.slice(0, 3).forEach(n => parts.push(`- ${n}`));
    }

    const userInput = parts.join('\n');

    const openai = new OpenAI({
      baseURL: 'https://api.deepseek.com',
      apiKey: apiKey,
    });

    const completion = await openai.chat.completions.create({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: DAILY_BRIEF_PROMPT },
        { role: 'user', content: userInput },
      ],
      stream: false,
      temperature: 0.85,
    });

    const raw = completion.choices?.[0]?.message?.content?.trim() || '';

    // 解析三段格式 ===X=== / ===WEIBO=== / ===XHS===
    const data = { x: '', weibo: '', xiaohongshu: '' };
    const xMatch = raw.match(/===X===\s*([\s\S]*?)(?====WEIBO===|$)/);
    const weiboMatch = raw.match(/===WEIBO===\s*([\s\S]*?)(?====XHS===|$)/);
    const xhsMatch = raw.match(/===XHS===\s*([\s\S]*?)$/);
    if (xMatch) data.x = xMatch[1].trim();
    if (weiboMatch) data.weibo = weiboMatch[1].trim();
    if (xhsMatch) data.xiaohongshu = xhsMatch[1].trim();

    // 容错：解析失败则整段放入 X
    if (!data.x && !data.weibo && !data.xiaohongshu) data.x = raw;

    return jsonResponse({ code: 0, data });
  } catch (e) {
    return jsonResponse({ code: 502, message: '简报生成失败: ' + (e.message || String(e)) }, 502);
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
