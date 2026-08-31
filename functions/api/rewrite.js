// Cloudflare Pages Function：AI 简介改写代理
// 使用 OpenAI SDK 调用 DeepSeek API（OpenAI 兼容接口）
// Key 存于 Pages 环境变量 DEEPSEEK_API_KEY
// POST /api/rewrite  body: { "text": "简介文本", "style": "humorous" }  ->  { "code": 0, "text": "改写后文本" }

import OpenAI from 'openai';
import { REWRITE_PROMPTS } from '../_lib/prompts.js';

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
    const { text, style } = await request.json();
    if (!text || typeof text !== 'string') {
      return jsonResponse({ code: 400, message: '缺少 text 参数' }, 400);
    }

    const prompt = REWRITE_PROMPTS[style] || REWRITE_PROMPTS.concise;

    const openai = new OpenAI({
      baseURL: 'https://api.deepseek.com',
      apiKey: apiKey,
    });

    const completion = await openai.chat.completions.create({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: text },
      ],
      stream: false,
      temperature: 0.8,
    });

    const rewritten = completion.choices?.[0]?.message?.content?.trim() || text;

    return jsonResponse({ code: 0, text: rewritten });
  } catch (e) {
    return jsonResponse({ code: 502, message: '改写失败: ' + (e.message || String(e)) }, 502);
  }
}

// 处理 OPTIONS 预检请求
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
