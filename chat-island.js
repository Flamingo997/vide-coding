// 影视资讯聊天助手 · React island（无构建，CDN 动态加载）
// 由 index.html 的 window.openChat() 首次点击「聊这条」时动态 import('./chat-island.js')
// 协议：POST /api/news-chat（UIMessage SSE），useChat 直接消费
// 版本锁定：react@19.2.8 / @ai-sdk/react@4.0.96 / ai@7.0.85（与后端函数包同版本线）

const CDNS = [
  {
    // 主栈：esm.sh，?deps= 锁定内部依赖到同一 URL，保证 React/ai 单实例
    name: 'esm.sh',
    react: 'https://esm.sh/react@19.2.8',
    dom: 'https://esm.sh/react-dom@19.2.8/client?deps=react@19.2.8',
    ai: 'https://esm.sh/ai@7.0.85',
    aiReact: 'https://esm.sh/@ai-sdk/react@4.0.96?deps=react@19.2.8,ai@7.0.85',
    htm: 'https://esm.sh/htm@3.1.1',
  },
  {
    // 备栈：jsdelivr（国内偶发 esm.sh 不稳时兜底；ai 版本对齐 @ai-sdk/react@4.0.96 的内置依赖 7.0.93）
    name: 'jsdelivr',
    react: 'https://cdn.jsdelivr.net/npm/react@19.2.8/+esm',
    dom: 'https://cdn.jsdelivr.net/npm/react-dom@19.2.8/+esm',
    ai: 'https://cdn.jsdelivr.net/npm/ai@7.0.93/+esm',
    aiReact: 'https://cdn.jsdelivr.net/npm/@ai-sdk/react@4.0.96/+esm',
    htm: 'https://cdn.jsdelivr.net/npm/htm@3.1.1/+esm',
  },
];

let stack = null;
async function loadStack() {
  if (stack) return stack;
  let lastErr = null;
  for (const c of CDNS) {
    try {
      const [reactMod, domMod, aiMod, aiReactMod, htmMod] = await Promise.all([
        import(c.react),
        import(c.dom),
        import(c.ai),
        import(c.aiReact),
        import(c.htm),
      ]);
      const React = reactMod.default ?? reactMod;
      if (!React || typeof React.createElement !== 'function' || typeof aiReactMod.useChat !== 'function') {
        throw new Error('模块结构异常');
      }
      stack = {
        React,
        hooks: React,
        createRoot: domMod.createRoot,
        DefaultChatTransport: aiMod.DefaultChatTransport,
        useChat: aiReactMod.useChat,
        htm: htmMod.default ?? htmMod,
      };
      console.info('[chat] CDN 栈加载成功:', c.name);
      return stack;
    } catch (e) {
      lastErr = e;
      console.warn('[chat] CDN 栈失败:', c.name, e?.message || e);
    }
  }
  throw lastErr || new Error('全部 CDN 失败');
}

async function boot() {
  const { React, createRoot, DefaultChatTransport, useChat, htm } = await loadStack();
  const html = htm.bind(React.createElement);
  const { useState, useEffect, useMemo, useRef, useCallback } = React;

  const QUICK_CHIPS = ['这篇的重点帮我划一下', '这条新闻对行业意味着什么', '有什么值得吐槽的点'];
  // 全站模式快捷问题：三个不同方向——推荐影片 / 影片简介 / 影讯（对应 /api/assistant 的 searchItems 工具与站内资讯时间线）
  const STATION_CHIPS = ['推荐几部近期值得看的影片', '挑一部新片，讲讲它的简介', '最近有哪些影视资讯？'];
  const MAX_INPUT = 500;

  // 取消息纯文本（dedupeTextParts 统一处理多 text part）：
  // 多步工具调用时 AI SDK 会给只调工具的 step 留空 text part（气泡顶部空行），需丢空段；
  // 模型偶发「先写完整答案→调工具→把答案原样重发一遍」，需丢弃逐字重复段
  function dedupeTextParts(parts) {
    const seen = [];
    const out = [];
    for (const p of parts || []) {
      if (p.type !== 'text') { out.push(p); continue; }
      const t = String(p.text || '').trim();
      if (!t) continue;
      if (seen.includes(t)) continue;
      seen.push(t);
      out.push({ ...p, text: t });
    }
    return out;
  }

  // 同名片名段落折叠：模型偶发把同一部作品的简介轻微换词写两遍（实测两段仅差一个「一位」、
  // 标点不同，严格相等去重拦不住，用户看到的就是「同一部片重复一遍」）；还会出现「先答查不到、
  // 重试成功又给出完整简介」的矛盾两段（一短一长、字面不相似，相似度规则也拦不住）。
  // 做法：按《片名》锚点切段，同片名多段时——① 若存在「实质简介段」，「暂无简介声明段」整段丢弃；
  // ② 后段与已保留段「日期一致 + 字符二元组高相似」则整段丢弃；
  // ③ 日期不同或内容明显不同的同名作品不折叠（那种由服务端输入层剥离处理）。
  function collapseSameTitleBlocks(input) {
    const text = String(input || '');
    const anchors = [];
    const re = /《([^《》]{1,30})》/g;
    let mm;
    while ((mm = re.exec(text))) anchors.push({ title: mm[1], start: mm.index, end: re.lastIndex });
    const counts = new Map();
    for (const a of anchors) counts.set(a.title, (counts.get(a.title) || 0) + 1);
    if (![...counts.values()].some(c => c >= 2)) return text;
    const bigrams = str => {
      const n = String(str).replace(/[\s\p{P}\p{S}]/gu, '');
      const set = new Set();
      for (let i = 0; i < n.length - 1; i++) set.add(n.slice(i, i + 2));
      return set;
    };
    const jaccard = (a, b) => {
      const A = bigrams(a), B = bigrams(b);
      if (!A.size || !B.size) return 0;
      let inter = 0;
      for (const g of A) if (B.has(g)) inter++;
      return inter / (A.size + B.size - inter);
    };
    const dateKey = str => {
      const d = String(str).match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
      return d ? d[1] + '-' + d[2].padStart(2, '0') + '-' + d[3].padStart(2, '0') : '';
    };
    // 「暂无简介」声明段：查不到话术、引导搜索框/过阵子再来，且不含实质剧情
    const emptyClaim = s => /暂无|还没有[^。]{0,14}(简介|详细|资料|剧情|文案|评分)|没有[^。]{0,10}(简介|详细资料|剧情简介|详细介绍)|资料[^。]{0,10}(没|未|以后|之后再)|过阵|过段时间|过些时候|稍后再|以后再|搜索框找|先来看看/.test(s);
    // 实质简介段：够长且含叙事标志
    const substantive = s => s.replace(/\s/g, '').length >= 50
      && /讲述|简介是|剧情|故事|记录|聚焦|围绕|改编|述说|讲的是|主角|主人公/.test(s);
    // 段体 = 锚点（含书名号）到下一锚点前的全部文本
    const segs = anchors.map((a, i) => ({
      title: a.title,
      body: text.slice(a.start, i + 1 < anchors.length ? anchors[i + 1].start : text.length),
    }));
    const hasReal = title => segs.some(s => s.title === title && substantive(s.body));
    const keptByTitle = new Map();
    const keptSegs = [];
    for (const s of segs) {
      if ((counts.get(s.title) || 0) < 2) { keptSegs.push(s.body); continue; }
      // ① 同片名下已有/将有实质简介段 → 空声明段丢弃（先答查不到、后给简介的矛盾段）
      if (emptyClaim(s.body) && !substantive(s.body) && hasReal(s.title)) continue;
      // ② 同日期 + 高相似的换词重写段丢弃
      const dk = dateKey(s.body);
      const prior = keptByTitle.get(s.title) || [];
      const dup = prior.some(p => (!dk || !p.dk || dk === p.dk) && jaccard(s.body, p.body) >= 0.5);
      if (dup) continue;
      prior.push({ dk, body: s.body });
      keptByTitle.set(s.title, prior);
      keptSegs.push(s.body);
    }
    const preamble = anchors.length ? text.slice(0, anchors[0].start) : '';
    return preamble + keptSegs.join('');
  }

  // 收尾推荐句排版：单片简介时，模型习惯在「适合……观众」前空一行；用户要求与剧情同段衔接。
  // 只合并全文结尾处的最后一个空行+末段（末段须以推荐/总结语开头、不含书名号、长度短），
  // 绝不触碰多片推荐列表（那种末段含《片名》或是另一部片的介绍）。
  // 开头词兼容旧历史句式：除「适合/偏好…」外，旧版还有「讲的是…，喜欢这类的可以留意」。
  function tightenClosing(input) {
    return String(input || '').replace(
      /。[ \t]*\n{2,}((?:适合|偏好|关注|喜欢|想看|推荐给|讲的是|影片整体|整体偏|题材偏)[^《》\n]{1,80}?[。！]?)\s*$/,
      '。$1'
    );
  }

  const textOf = m => tightenClosing(collapseSameTitleBlocks(
    dedupeTextParts((m.parts || []).filter(p => p.type === 'text'))
      .map(p => p.text)
      .join('\n')
      .trim()
  ));

  // 从 assistant 消息的 tool parts 提取参考条目（searchItems/getFavorites 列表 + getItemById 单条），
  // 用于渲染「参考了哪些条目」chips（AI SDK 7：type='tool-<name>'，state='output-available' 时有 output）
  function refItemsOf(m) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.parts)) return [];
    const out = [];
    for (const p of m.parts) {
      if (typeof p.type !== 'string' || !p.type.startsWith('tool-')) continue;
      if (p.state !== 'output-available' || !p.output || p.output == null) continue;
      const o = p.output;
      if (p.type === 'tool-searchItems' && Array.isArray(o.items)) {
        out.push(...o.items.filter(x => x && x.title));
      } else if (p.type === 'tool-getFavorites' && o.loggedIn && Array.isArray(o.favorites)) {
        out.push(...o.favorites.filter(x => x && x.title));
      } else if (p.type === 'tool-getItemById' && o.title) {
        out.push(o);
      }
    }
    return out;
  }

  // 会话级参考条目：聚合所有 assistant 消息的工具结果（searchItems/getFavorites/getItemById），
  // 按片名去重。模型某一轮复用上文条目、本轮没调工具时，气泡里的《片名》依然可以点击传送
  function sessionRefItems(msgs) {
    const norm = s => String(s || '').replace(/\s+/g, '');
    const map = new Map();
    for (const m of msgs || []) {
      for (const it of refItemsOf(m)) {
        const k = norm(it.title);
        if (k && !map.has(k)) map.set(k, it);
      }
    }
    return [...map.values()];
  }

  // 文本内《片名》链接化：片名出现在会话内任一工具结果（站内真实条目）里才可点击，
  // 点击传送到该影片的站内位置（/?q= 落地到时间线检索）；不在站内的提及保持纯文本。
  // 《》由站内助手系统提示词强制；refs 在工具 output-available 后才有，流式过程中《》暂为纯文本，
  // 工具结果落定后自动变为可点击。
  function linkify(txt, refs, openRef) {
    if (!txt || !refs || !refs.length) return txt;
    const norm = s => String(s || '').replace(/\s+/g, '');
    const refMap = new Map(refs.filter(r => r && r.title && r.url).map(r => [norm(r.title), r]));
    const linked = new Set(); // 同一部影片只保留首次出现的传送链接，后续提及退化为纯文本
    const parts = [];
    const re = /《([^《》]{1,60})》/g;
    let last = 0, m;
    while ((m = re.exec(txt)) !== null) {
      if (m.index > last) parts.push(txt.slice(last, m.index));
      const inner = m[1];
      const key = norm(inner);
      const hit = refMap.get(key);
      if (hit && !linked.has(key)) {
        linked.add(key);
        parts.push(html`<span class="chat-title-link" role="link" tabindex="0" title=${'点击前往：' + hit.title} onClick=${() => openRef(hit)}>《${inner}》</span>`);
      } else {
        parts.push('《' + inner + '》');
      }
      last = re.lastIndex;
    }
    if (!parts.length) return txt;
    if (last < txt.length) parts.push(txt.slice(last));
    return parts;
  }

  function loadHistory(key) {
    try {
      const arr = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(arr) ? arr.filter(m => m && m.role && Array.isArray(m.parts)) : [];
    } catch (_) { return []; }
  }

  function saveHistory(key, msgs) {
    try {
      // 保留文本 + 已完成的 tool parts（刷新后参考条目 chips 和服务端追问上下文都依赖它）
      const slim = (msgs || []).slice(-20).map(m => {
        const toolParts = dedupeTextParts(m.parts || []).filter(p =>
          typeof p.type === 'string' && p.type.startsWith('tool-') && p.state === 'output-available' && p.toolCallId
        ).map(p => ({
          type: p.type,
          toolCallId: p.toolCallId,
          state: 'output-available',
          input: p.input,
          output: p.output,
        }));
        // 文本段先逐字去重→拼接→同名段落折叠，存成单段，避免换词重复段被持久化后反复污染上下文
        const mergedText = textOf(m);
        const textParts = mergedText ? [{ type: 'text', text: mergedText }] : [];
        // assistant 保持「工具段在前、文本在后」的时序（工具关联靠 toolCallId，顺序仅为还原原始结构）
        const parts = m.role === 'assistant' ? [...toolParts, ...textParts] : [...textParts, ...toolParts];
        return { id: m.id, role: m.role, parts };
      });
      localStorage.setItem(key, JSON.stringify(slim));
    } catch (_) {}
  }

  // ===== 根组件：文章对谈 / 全站助手 两种模式 + 开合状态，向 vanilla 页面暴露 bridge =====
  function ChatApp() {
    const [article, setArticle] = useState(null);
    const [open, setOpen] = useState(false);
    const [autoQuestion, setAutoQuestion] = useState('');
    const [station, setStation] = useState(false);

    useEffect(() => {
      window.__chatBridge = {
        open(a, q) {
          if (!a || !a.url) return;
          setStation(false);
          setArticle(a);
          setAutoQuestion(typeof q === 'string' ? q : '');
          setOpen(true);
        },
        // 全站助手：右下角圆形按钮入口，无文章上下文，调 /api/assistant
        openStation() {
          setStation(true);
          setOpen(true);
        },
        close() { setOpen(false); },
      };
      // 消费 index.html 在 island 就绪前暂存的打开请求
      const pend = window.__pendingChatArticle;
      if (pend) {
        window.__pendingChatArticle = null;
        setStation(false);
        setArticle(pend.article);
        setAutoQuestion(typeof pend.question === 'string' ? pend.question : '');
        setOpen(true);
      }
      if (window.__pendingStation) {
        window.__pendingStation = null;
        setStation(true);
        setOpen(true);
      }
    }, []);

    if (!open) return null;
    // 全站模式：固定单实例（历史持久化到 stationchat:v2）
    if (station) return html`<${ChatDrawer} key="station" station=${true} onClose=${() => setOpen(false)} />`;
    if (!article) return null;
    return html`<${ChatDrawer} key=${article.url} article=${article} autoQuestion=${autoQuestion} onClose=${() => setOpen(false)} />`;
  }

  // ===== 抽屉：station=true 全站助手（/api/assistant + searchItems 工具）；否则单篇文章对谈（/api/news-chat）=====
  function ChatDrawer({ article, autoQuestion, station, onClose }) {
    // v2：早期片库抖动期留下的「空检索结果」历史会让模型复读「没搜到」而不重新调用工具，
    // 服务端虽已强制重检，但旧上下文本身也是噪音，直接换键清空（仅全站助手）
    const storageKey = station ? 'stationchat:v2' : ('newschat:' + article.url);
    const [initialMessages] = useState(() => loadHistory(storageKey));
    const [uiError, setUiError] = useState('');
    const [input, setInput] = useState('');
    const listRef = useRef(null);

    // 全站模式：策略A——每次「发送时」才实时采集当前页条目（getStationItems 为 async，会等待票房数据）。
    // 不能用 transport 构造时的 body 快照：票房请求可能晚于抽屉挂载到达，快照里缺片会导致
    // 首页边栏明明在映的片，助手整轮会话都「看不见」。
    // 文章模式：autoQuestion（深挖chip）标记 search=true，后端首条直接联网搜索
    const transport = useMemo(() => new DefaultChatTransport({
      api: station ? '/api/assistant' : '/api/news-chat',
      body: station
        ? {}
        : { url: article.url, title: article.title, source: article.source, text: article.text, search: !!autoQuestion },
      prepareSendMessagesRequest: async ({ messages, body: base }) => {
        // AI SDK v7：钩子一旦返回 body 就会整体替换默认请求体（默认的 messages 不再自动合并），
        // 所以两个分支都必须把 messages 自己放回去
        if (!station) return { body: { ...(base || {}), messages } };
        let items = [];
        try {
          if (typeof window !== 'undefined' && window.getStationItems) items = await window.getStationItems();
        } catch (_) { items = []; }
        return { body: { ...(base || {}), messages, items: Array.isArray(items) ? items : [] } };
      },
    }), [station, article ? article.url : null, autoQuestion]);

    const persist = useCallback(msgs => saveHistory(storageKey, msgs), [storageKey]);

    const { messages, sendMessage, status, stop, regenerate, clearError } = useChat({
      id: station ? 'station' : article.url,
      messages: initialMessages,
      transport,
      onFinish: ({ messages: msgs }) => persist(msgs),
      onError: e => {
        let msg = e?.message || '生成失败';
        try { const j = JSON.parse(msg); if (j && j.error) msg = j.error; } catch (_) {}
        setUiError(msg);
      },
    });

    // 状态回到 ready 时兜底落盘（覆盖 stop/中断场景）
    useEffect(() => {
      if (status === 'ready' && messages.length) persist(messages);
    }, [status]);

    // Esc 关闭
    useEffect(() => {
      const h = e => { if (e.key === 'Escape') onClose(); };
      window.addEventListener('keydown', h);
      return () => window.removeEventListener('keydown', h);
    }, [onClose]);

    // 自动滚到底
    useEffect(() => {
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }, [messages, status]);

    const busy = status === 'submitted' || status === 'streaming';

    const send = useCallback(text => {
      const t = String(text ?? input).trim().slice(0, MAX_INPUT);
      if (!t || busy) return;
      setInput('');
      setUiError('');
      clearError();
      sendMessage({ text: t });
    }, [input, busy, sendMessage, clearError]);

    // 引导性问题自动发送：从推文页「深挖一下」chip 点进来时执行一次（仅文章模式）
    useEffect(() => {
      if (!station && autoQuestion) send(autoQuestion);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const onRetry = useCallback(() => {
      setUiError('');
      clearError();
      regenerate();
    }, [clearError, regenerate]);

    const lastMsg = messages[messages.length - 1];
    const showDots = busy && (!lastMsg || lastMsg.role === 'user' || !textOf(lastMsg));

    // 参考条目 chip 点击：外链（资讯原文）新窗口打开，站内链接（/?q=）当前页跳转
    const openRef = useCallback(r => {
      const u = String((r && r.url) || '');
      if (u.startsWith('http')) window.open(u, '_blank', 'noopener');
      else if (u) location.href = u;
    }, []);

    const chips = station ? STATION_CHIPS : QUICK_CHIPS;

    return html`
      <div class="chat-overlay" onMouseDown=${e => { if (e.target === e.currentTarget) onClose(); }}>
        <aside class="chat-drawer" role="dialog" aria-label=${station ? '全站 AI 助手' : '影视资讯聊天'}>
          <header class="chat-head">
            <div class="chat-head-info">
              ${station ? html`
                <span class="chat-head-title" title="AI 影视助手">AI 影视助手</span>
              ` : html`
                <span class="chat-head-src">[${article.source || '影讯'}]</span>
                <a class="chat-head-title" href=${article.url} target="_blank" rel="noopener" title=${article.title}>${article.title}</a>
              `}
            </div>
            <button class="chat-close" onClick=${onClose} aria-label="关闭对谈">✕</button>
          </header>

          <div class="chat-list" ref=${listRef}>
            ${messages.length === 0 ? html`
              ${station ? html`
                <div class="chat-msg chat-msg-ai"><div class="chat-bubble">你好！我是 AI 影视助手，可以回答影视问题、推荐影视作品、生成资讯摘要。</div></div>
              ` : null}
              <div class="chat-welcome">${station
                ? '想找什么片直接问——片名、类型、演员都行，我只推荐站里真实有的。'
                : '就这一篇新闻随便聊——追问背景、聊观点、问细节都行，我只按原文说话。'}</div>
            ` : null}

            ${messages.map(m => {
              const refs = m.role === 'assistant' ? sessionRefItems(messages) : [];
              const txt = textOf(m);
              const bubble = m.role === 'assistant' ? linkify(txt, refs, openRef) : txt;
              return html`
              <div key=${m.id} class=${'chat-msg ' + (m.role === 'user' ? 'chat-msg-user' : 'chat-msg-ai')}>
                ${txt ? html`<div class="chat-bubble">${bubble}</div>` : null}
              </div>
            `;
            })}

            ${showDots ? html`<div class="chat-msg chat-msg-ai"><div class="chat-bubble chat-dots"><i></i><i></i><i></i></div></div>` : null}

            ${uiError ? html`
              <div class="chat-error">
                <span>⚠ ${uiError}</span>
                <button class="chat-error-retry" onClick=${onRetry}>重试</button>
              </div>
            ` : null}
          </div>

          ${!busy && !input.trim() ? html`
            <div class="chat-chips">
              ${chips.map(c => html`<button class="chat-chip" key=${c} onClick=${() => send(c)}>${c}</button>`)}
            </div>
          ` : null}
          <footer class="chat-input-bar">
            <textarea
              class="chat-input"
              rows="2"
              placeholder=${station ? '想找什么片？片名、类型都行…（Enter 发送 / Shift+Enter 换行）' : '就这条新闻说点什么…（Enter 发送 / Shift+Enter 换行）'}
              value=${input}
              maxLength=${MAX_INPUT}
              onInput=${e => setInput(e.target.value)}
              onKeyDown=${e => {
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
              }}
            ></textarea>
            <button class=${'chat-send' + (busy ? ' chat-send-stop' : '')} onClick=${() => (busy ? stop() : send())} aria-label=${busy ? '停止生成' : '发送'} title=${busy ? '停止生成' : '发送'}>
              ${busy
                ? html`<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>`
                : html`<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.4 20.4l17.45-7.48a1 1 0 000-1.84L3.4 3.6a.993.993 0 00-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z"></path></svg>`}
            </button>
          </footer>
        </aside>
      </div>
    `;
  }

  const el = document.getElementById('chatRoot');
  if (!el) { console.error('[chat] 缺少 #chatRoot 挂载点'); return; }
  createRoot(el).render(html`<${ChatApp} />`);
  console.info('[chat] island 已挂载');
}

boot().catch(err => {
  console.error('[chat] island 启动失败', err);
  const el = document.getElementById('chatRoot');
  if (el) {
    el.innerHTML = '<div class="chat-overlay" onclick="this.remove()"><aside class="chat-drawer"><div class="chat-boot-msg">聊天组件加载失败（CDN 不可达），请刷新页面重试。<br><br>点此关闭</div></aside></div>';
  }
  window.__chatIslandLoading = null;
});
