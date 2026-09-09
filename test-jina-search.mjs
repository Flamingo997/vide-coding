// Jina 搜索 API 直连测试（s.jina.ai，不部署）
// 运行：node test-jina-search.mjs
// 本机注意：node fetch 不走系统代理，Jina 需要代理时用：
//   NODE_USE_ENV_PROXY=1 HTTP_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 node test-jina-search.mjs
// 覆盖：中/英文查询、chip风格长问句、特殊字符、site语法、错误鉴权、并发、延迟统计

import fs from 'node:fs';

const devVars = Object.fromEntries(
  fs.readFileSync('./.dev.vars', 'utf8').split('\n')
    .filter(l => l.includes('='))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
);
const KEY = devVars.JINA_API_KEY;

// 与线上 news-chat.js 的 jinaSearch() 完全一致的实现
async function jinaSearch(query, apiKey) {
  const t0 = Date.now();
  try {
    const r = await fetch('https://s.jina.ai/' + encodeURIComponent(query), {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'X-Respond-With': 'no-content',
        'Accept': 'text/plain',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return { ok: false, status: r.status, ms: Date.now() - t0 };
    const text = await r.text();
    const results = (text.match(/^\[\d+\] Title:/gm) || []).length;
    return { ok: true, status: r.status, ms: Date.now() - t0, len: text.length, results, head: text.split('\n').slice(0, 3).join(' | ').slice(0, 150) };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: String(e?.message || e).slice(0, 80) };
  }
}

const cases = [
  ['中文短词', '法国电视剧出口下跌'],
  ['英文查询', 'Live Nation Ticketmaster antitrust settlement'],
  ['chip风格长问句', '独立主办方敢实名对抗Live Nation，演唱会市场垄断有多严重？'],
  ['中文书名号+问号', '《007》邦德选角 2026？'],
  ['引号+site语法', 'qwen "function calling" cloudflare'],
];

console.log('=== Jina 搜索 API 直连测试 ===');
console.log('key:', KEY ? `${KEY.slice(0, 6)}***${KEY.slice(-4)} (${KEY.length} chars)` : '(missing!)');

let pass = 0, fail = 0;
for (const [name, q] of cases) {
  const r = await jinaSearch(q, KEY);
  const ok = r.ok && (r.results || 0) > 0;
  ok ? pass++ : fail++;
  console.log(`\n[${name}] ${ok ? 'PASS' : 'FAIL'} ${r.ms}ms status=${r.status} 结果数=${r.results || 0} 字节=${r.len || 0}`);
  if (r.head) console.log('  head:', r.head);
  if (r.error) console.log('  error:', r.error);
}

// 错误鉴权：坏 key 应被拒绝且不抛异常（护栏验证）
console.log('\n[坏key] 期望 4xx 拒绝、不抛异常:');
const r401 = await jinaSearch('test', 'invalid_key_123');
const pass401 = !r401.ok && r401.status >= 400;
pass401 ? pass++ : fail++;
console.log(`  ${pass401 ? 'PASS' : 'FAIL'} status=${r401.status} ${r401.ms}ms`);

// 并发 x2（验证同时两路搜索不互斥）
console.log('\n[并发 x2]:');
const t0 = Date.now();
const [c1, c2] = await Promise.all([jinaSearch('电影票房 2026', KEY), jinaSearch('netflix new series', KEY)]);
const passCc = c1.ok && c2.ok;
passCc ? pass++ : fail++;
console.log(`  ${passCc ? 'PASS' : 'FAIL'} 总耗时 ${Date.now() - t0}ms（[中文]${c1.ms}ms/${c1.results}条 [英文]${c2.ms}ms/${c2.results}条）`);

console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
