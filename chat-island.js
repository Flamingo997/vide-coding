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
  const MAX_INPUT = 500;

  const textOf = m => (m.parts || []).filter(p => p.type === 'text').map(p => p.text).join('\n');

  function loadHistory(key) {
    try {
      const arr = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(arr) ? arr.filter(m => m && m.role && Array.isArray(m.parts)) : [];
    } catch (_) { return []; }
  }

  function saveHistory(key, msgs) {
    try {
      const slim = (msgs || []).slice(-20).map(m => ({
        id: m.id,
        role: m.role,
        parts: (m.parts || []).filter(p => p.type === 'text'),
      }));
      localStorage.setItem(key, JSON.stringify(slim));
    } catch (_) {}
  }

  // ===== 根组件：持锚文章 + 开合状态 + 待自动发送的引导问题，向 vanilla 页面暴露 bridge =====
  function ChatApp() {
    const [article, setArticle] = useState(null);
    const [open, setOpen] = useState(false);
    const [autoQuestion, setAutoQuestion] = useState('');

    useEffect(() => {
      window.__chatBridge = {
        open(a, q) {
          if (!a || !a.url) return;
          setArticle(a);
          setAutoQuestion(typeof q === 'string' ? q : '');
          setOpen(true);
        },
        close() { setOpen(false); },
      };
      // 消费 index.html 在 island 就绪前暂存的打开请求
      const pend = window.__pendingChatArticle;
      if (pend) {
        window.__pendingChatArticle = null;
        setArticle(pend.article);
        setAutoQuestion(typeof pend.question === 'string' ? pend.question : '');
        setOpen(true);
      }
    }, []);

    if (!open || !article) return null;
    return html`<${ChatDrawer} key=${article.url} article=${article} autoQuestion=${autoQuestion} onClose=${() => setOpen(false)} />`;
  }

  // ===== 抽屉：一个 url 一个实例（key 换文章即换会话）=====
  function ChatDrawer({ article, autoQuestion, onClose }) {
    const storageKey = 'newschat:' + article.url;
    const [initialMessages] = useState(() => loadHistory(storageKey));
    const [uiError, setUiError] = useState('');
    const [input, setInput] = useState('');
    const listRef = useRef(null);

    const transport = useMemo(() => new DefaultChatTransport({
      api: '/api/news-chat',
      body: { url: article.url, title: article.title, source: article.source, text: article.text },
    }), [article.url]);

    const persist = useCallback(msgs => saveHistory(storageKey, msgs), [storageKey]);

    const { messages, sendMessage, status, stop, regenerate, clearError } = useChat({
      id: article.url,
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

    // 引导性问题自动发送：从推文页「深挖一下」chip 点进来时执行一次
    useEffect(() => {
      if (autoQuestion) send(autoQuestion);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const onRetry = useCallback(() => {
      setUiError('');
      clearError();
      regenerate();
    }, [clearError, regenerate]);

    const lastMsg = messages[messages.length - 1];
    const showDots = busy && (!lastMsg || lastMsg.role === 'user' || !textOf(lastMsg));

    return html`
      <div class="chat-overlay" onMouseDown=${e => { if (e.target === e.currentTarget) onClose(); }}>
        <aside class="chat-drawer" role="dialog" aria-label="影视资讯聊天">
          <header class="chat-head">
            <div class="chat-head-info">
              <span class="chat-head-src">[${article.source || '影讯'}]</span>
              <a class="chat-head-title" href=${article.url} target="_blank" rel="noopener" title=${article.title}>${article.title}</a>
            </div>
            <button class="chat-close" onClick=${onClose} aria-label="关闭对谈">✕</button>
          </header>

          <div class="chat-list" ref=${listRef}>
            ${messages.length === 0 ? html`
              <div class="chat-welcome">就这一篇新闻随便聊——追问背景、聊观点、问细节都行，我只按原文说话。</div>
              <div class="chat-chips">
                ${QUICK_CHIPS.map(c => html`<button class="chat-chip" key=${c} onClick=${() => send(c)}>${c}</button>`)}
              </div>
            ` : null}

            ${messages.map(m => html`
              <div key=${m.id} class=${'chat-msg ' + (m.role === 'user' ? 'chat-msg-user' : 'chat-msg-ai')}>
                <div class="chat-bubble">${textOf(m)}</div>
              </div>
            `)}

            ${showDots ? html`<div class="chat-msg chat-msg-ai"><div class="chat-bubble chat-dots"><i></i><i></i><i></i></div></div>` : null}

            ${uiError ? html`
              <div class="chat-error">
                <span>⚠ ${uiError}</span>
                <button class="chat-error-retry" onClick=${onRetry}>重试</button>
              </div>
            ` : null}
          </div>

          <footer class="chat-input-bar">
            <textarea
              class="chat-input"
              rows="2"
              placeholder="就这条新闻说点什么…（Enter 发送 / Shift+Enter 换行）"
              value=${input}
              maxLength=${MAX_INPUT}
              onInput=${e => setInput(e.target.value)}
              onKeyDown=${e => {
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
              }}
            ></textarea>
            <button class=${'chat-send' + (busy ? ' chat-send-stop' : '')} onClick=${() => (busy ? stop() : send())}>
              ${busy ? '⏹ 停止' : '发送'}
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
