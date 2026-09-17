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

  // 取消息纯文本：多步工具调用时 AI SDK 会给每个只调工具的 step 留一个空 text part
  // （SSE 先 text-start 再走工具、本步无 text-delta），不过滤会在气泡顶部拼出成片空行，
  // 故丢弃 trim 后为空的文本段，并去掉整体首尾空白
  const textOf = m => (m.parts || [])
    .filter(p => p.type === 'text')
    .map(p => String(p.text || ''))
    .filter(t => t.trim())
    .join('\n')
    .trim();

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
      const slim = (msgs || []).slice(-20).map(m => ({
        id: m.id,
        role: m.role,
        parts: (m.parts || []).filter(p =>
          // 空文本段（工具步留下的占位 text part）不持久化，避免历史膨胀且刷新后气泡顶部带空行
          (p.type === 'text' && String(p.text || '').trim()) ||
          (typeof p.type === 'string' && p.type.startsWith('tool-') && p.state === 'output-available' && p.toolCallId)
        ).map(p => p.type === 'text'
          ? { type: 'text', text: String(p.text).trim() }
          : {
          type: p.type,
          toolCallId: p.toolCallId,
          state: 'output-available',
          input: p.input,
          output: p.output,
        }),
      }));
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
