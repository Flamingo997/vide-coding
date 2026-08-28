// Cloudflare Pages Function：英文 -> 中文翻译代理
// 使用 OpenAI SDK 调用 DeepSeek API（OpenAI 兼容接口）
// Key 存于 Pages 环境变量 DEEPSEEK_API_KEY
// POST /api/translate  body: { "text": "English text" }  ->  { "code": 0, "text": "中文翻译" }

import OpenAI from 'openai';

const SYSTEM_PROMPT = `你是一个专业的影视翻译引擎。请将用户输入的英文文本翻译成简体中文。
规则：
1. 影视作品名使用通行中文译名
2. 专业名词、人名、片名在翻译后需用括号备注英文原文，例如"奥本海默(Oppenheimer)"、"死侍与金刚狼(Deadpool & Wolverine)"
3. 多段文本以"---"分隔，请保持相同的分隔格式返回
4. 只返回翻译结果，不加任何解释、引号或前缀`;

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
    const { text } = await request.json();
    if (!text || typeof text !== 'string') {
      return jsonResponse({ code: 400, message: '缺少 text 参数' }, 400);
    }

    const openai = new OpenAI({
      baseURL: 'https://api.deepseek.com',
      apiKey: apiKey,
    });

    const completion = await openai.chat.completions.create({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      stream: false,
      temperature: 0.1,
    });

    const translated = completion.choices?.[0]?.message?.content?.trim() || text;

    return jsonResponse({ code: 0, text: translated });
  } catch (e) {
    return jsonResponse({ code: 502, message: '翻译失败: ' + (e.message || String(e)) }, 502);
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
