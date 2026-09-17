(() => {
  const BRAND_BLUE = "#1E50E6";
  const SITE_KEY = (() => {
    try {
      return location.origin;
    } catch {
      return "";
    }
  })();

  const state = {
    context: null,
    messages: [],
    sessionId: "",
    requestId: "",
    busy: false,
    assistantIndex: -1,
    liveChars: 0,
    selectionText: "",
    chipEnabled: true,
    disabledSites: [],
    port: null,
  };

  let root = null;
  let shadow = null;
  let chip = null;
  let actionMenu = null;
  let card = null;
  let contextEl = null;
  let quickActions = null;
  let log = null;
  let status = null;
  let input = null;
  let sendButton = null;
  let stopButton = null;

  function markSvg(className = "") {
    return `<svg class="${className}" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="32" height="32" rx="8" fill="${BRAND_BLUE}"/><path d="M8 12.5A2.5 2.5 0 0 1 10.5 10h11A2.5 2.5 0 0 1 24 12.5v7a2.5 2.5 0 0 1-2.5 2.5H16l-3.2 2.4a.8.8 0 0 1-1.3-.6V22H10.5A2.5 2.5 0 0 1 8 19.5v-7Z" fill="#fff"/><circle cx="24.5" cy="8.5" r="3.2" fill="#50C8FF"/></svg>`;
  }

  function ensureUi() {
    if (root) return;
    root = document.createElement("div");
    root.id = "chint-sidechat-root";
    shadow = root.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; color-scheme: light; }
        *, *::before, *::after { box-sizing: border-box; }
        button, textarea { font: inherit; }
        button { cursor: pointer; }
        .hidden { display: none !important; }
        .chip, .action-menu, .card {
          position: fixed;
          z-index: 2147483646;
          font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif;
          color: #172033;
        }
        .chip {
          display: none;
          align-items: center;
          gap: 6px;
          min-height: 36px;
          padding: 7px 12px 7px 8px;
          border: 1px solid ${BRAND_BLUE};
          border-radius: 999px;
          background: #fff;
          color: ${BRAND_BLUE};
          box-shadow: 0 7px 22px rgba(30, 80, 230, .2);
          font-size: 13px;
          font-weight: 650;
          line-height: 1;
        }
        .chip:hover, .chip:focus-visible { background: #edf3ff; }
        .chip svg { width: 19px; height: 19px; }
        .action-menu {
          display: none;
          width: 220px;
          padding: 6px;
          border: 1px solid #dbe4f5;
          border-radius: 14px;
          background: #fff;
          box-shadow: 0 16px 42px rgba(24, 45, 88, .2);
        }
        .action-menu button {
          width: 100%;
          min-height: 42px;
          padding: 9px 11px;
          border: 0;
          border-radius: 9px;
          background: transparent;
          color: #172033;
          text-align: left;
          font-size: 13px;
        }
        .action-menu button:hover, .action-menu button:focus-visible { background: #edf3ff; color: ${BRAND_BLUE}; }
        .card {
          right: 18px;
          bottom: 18px;
          display: none;
          width: min(390px, calc(100vw - 24px));
          max-height: min(640px, calc(100vh - 28px));
          overflow: hidden;
          border: 1px solid #d9e2f2;
          border-radius: 18px;
          background: #fff;
          box-shadow: 0 24px 70px rgba(18, 35, 72, .24);
        }
        .card.open { display: flex; flex-direction: column; animation: card-in .18s ease-out; }
        .head {
          display: flex;
          align-items: center;
          gap: 9px;
          min-height: 54px;
          padding: 8px 9px 8px 14px;
          border-bottom: 1px solid #edf0f5;
        }
        .head-mark { width: 24px; height: 24px; flex: 0 0 auto; }
        .title { flex: 1; font-size: 14px; font-weight: 700; }
        .head button {
          min-width: 40px;
          min-height: 40px;
          border: 0;
          border-radius: 10px;
          background: transparent;
          color: #5e6a7e;
          font-size: 13px;
        }
        .head button:hover, .head button:focus-visible { background: #edf3ff; color: ${BRAND_BLUE}; }
        .reference {
          display: none;
          margin: 10px 12px 0;
          padding: 10px;
          border: 1px solid #dce6f8;
          border-radius: 12px;
          background: #f7faff;
        }
        .reference.visible { display: flex; align-items: flex-start; gap: 9px; }
        .reference img { width: 54px; height: 54px; border-radius: 8px; object-fit: cover; background: #e8eef8; }
        .reference-copy { min-width: 0; flex: 1; }
        .reference-label { margin-bottom: 3px; color: #60708a; font-size: 11px; font-weight: 650; }
        .reference-text { max-height: 48px; overflow: hidden; color: #344054; font-size: 12px; line-height: 1.45; word-break: break-word; }
        .reference-remove {
          width: 30px;
          height: 30px;
          flex: 0 0 auto;
          border: 0;
          border-radius: 8px;
          background: transparent;
          color: #667085;
        }
        .reference-remove:hover, .reference-remove:focus-visible { background: #e8eefb; color: ${BRAND_BLUE}; }
        .quick-actions { display: flex; flex-wrap: wrap; gap: 7px; padding: 10px 12px 0; }
        .quick-actions:empty { display: none; }
        .quick-actions button, .copy-answer {
          min-height: 36px;
          padding: 7px 11px;
          border: 1px solid #d7e1f2;
          border-radius: 999px;
          background: #fff;
          color: #31415e;
          font-size: 12px;
          font-weight: 600;
        }
        .quick-actions button:hover, .quick-actions button:focus-visible,
        .copy-answer:hover, .copy-answer:focus-visible { border-color: #9bb6ee; background: #edf3ff; color: ${BRAND_BLUE}; }
        .log {
          min-height: 0;
          max-height: 330px;
          overflow: auto;
          padding: 11px 12px;
          overscroll-behavior: contain;
        }
        .log:empty { display: none; }
        .message { display: flex; margin: 8px 0; }
        .message.user { justify-content: flex-end; }
        .bubble { max-width: 88%; padding: 9px 11px; border-radius: 13px; font-size: 13px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
        .user .bubble { border-bottom-right-radius: 4px; background: ${BRAND_BLUE}; color: #fff; }
        .assistant .bubble { border-bottom-left-radius: 4px; background: #f1f5fb; color: #172033; }
        .answer-tools { display: flex; margin: 2px 0 6px; }
        .status { min-height: 22px; padding: 0 14px; color: #667085; font-size: 12px; line-height: 22px; }
        .status.busy::before { content: ""; display: inline-block; width: 7px; height: 7px; margin-right: 7px; border-radius: 50%; background: ${BRAND_BLUE}; animation: pulse 1.1s infinite; }
        .composer { margin: 0 10px 10px; border: 1px solid #cad7ec; border-radius: 14px; background: #fff; }
        textarea {
          display: block;
          width: 100%;
          min-height: 52px;
          max-height: 120px;
          resize: none;
          padding: 11px 12px 4px;
          border: 0;
          outline: 0;
          background: transparent;
          color: #172033;
          font-size: 14px;
          line-height: 1.45;
        }
        textarea::placeholder { color: #8792a5; }
        .composer:focus-within { border-color: #799ce7; box-shadow: 0 0 0 3px rgba(30, 80, 230, .1); }
        .composer-bar { display: flex; justify-content: flex-end; align-items: center; gap: 7px; padding: 5px 7px 7px; }
        .round {
          width: 40px;
          height: 40px;
          border: 0;
          border-radius: 50%;
          background: ${BRAND_BLUE};
          color: #fff;
          font-size: 18px;
          font-weight: 700;
        }
        .round:hover, .round:focus-visible { background: #1744c4; }
        .round:disabled { cursor: default; opacity: .35; }
        .round.stop { background: #eef2f8; color: #40506a; font-size: 14px; }
        button:focus-visible, textarea:focus-visible { outline: 2px solid #668ee8; outline-offset: 2px; }
        @keyframes card-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse { 0%, 100% { opacity: .3; transform: scale(.8); } 50% { opacity: 1; transform: scale(1); } }
        @media (max-width: 520px) { .card { right: 12px; bottom: 12px; } }
        @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; } }
      </style>
      <button type="button" class="chip" aria-label="询问安能助手">${markSvg()}<span>询问</span></button>
      <div class="action-menu" role="menu" aria-label="选中文字的快捷操作">
        <button type="button" role="menuitem" data-action="explain">解释</button>
        <button type="button" role="menuitem" data-action="translate">翻译</button>
        <button type="button" role="menuitem" data-action="custom">自定义提问</button>
      </div>
      <section class="card" role="dialog" aria-label="安能助手快捷卡片" aria-modal="false">
        <header class="head">
          ${markSvg("head-mark")}
          <span class="title">安能助手</span>
          <button type="button" data-card-action="expand" aria-label="在侧栏展开">展开</button>
          <button type="button" data-card-action="close" aria-label="关闭快捷卡片">✕</button>
        </header>
        <div class="reference">
          <div class="reference-copy"><div class="reference-label"></div><div class="reference-text"></div></div>
          <button type="button" class="reference-remove" aria-label="移除引用">✕</button>
        </div>
        <div class="quick-actions" aria-label="快捷操作"></div>
        <div class="log" role="log" aria-live="polite"></div>
        <div class="status" role="status" aria-live="polite"></div>
        <div class="composer">
          <textarea rows="1" aria-label="快捷提问" placeholder="继续问，或输入新的问题…"></textarea>
          <div class="composer-bar">
            <button type="button" class="round stop hidden" aria-label="停止生成">■</button>
            <button type="button" class="round send" aria-label="发送" disabled>↑</button>
          </div>
        </div>
      </section>
    `;
    document.documentElement.appendChild(root);

    chip = shadow.querySelector(".chip");
    actionMenu = shadow.querySelector(".action-menu");
    card = shadow.querySelector(".card");
    contextEl = shadow.querySelector(".reference");
    quickActions = shadow.querySelector(".quick-actions");
    log = shadow.querySelector(".log");
    status = shadow.querySelector(".status");
    input = shadow.querySelector("textarea");
    sendButton = shadow.querySelector(".send");
    stopButton = shadow.querySelector(".stop");

    chip.addEventListener("mousedown", (event) => event.preventDefault());
    chip.addEventListener("click", openSelectionActions);
    actionMenu.addEventListener("mousedown", (event) => event.preventDefault());
    actionMenu.addEventListener("click", handleSelectionAction);
    shadow.querySelector('[data-card-action="close"]').addEventListener("click", closeCard);
    shadow.querySelector('[data-card-action="expand"]').addEventListener("click", expandCard);
    shadow.querySelector(".reference-remove").addEventListener("click", () => {
      state.context = null;
      renderContext();
      renderQuickActions();
      input.focus();
    });
    quickActions.addEventListener("click", handleQuickAction);
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(120, Math.max(52, input.scrollHeight))}px`;
      updateControls();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        sendCurrent();
      }
    });
    sendButton.addEventListener("click", sendCurrent);
    stopButton.addEventListener("click", stopCurrent);
  }

  function isEditable(element) {
    if (!element || !(element instanceof Element)) return false;
    return ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) || element.isContentEditable;
  }

  function currentSelection() {
    try {
      const selection = window.getSelection?.();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
      const text = String(selection.toString() || "").trim();
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (text.length < 2 || !rect || (!rect.width && !rect.height)) return null;
      return { text, rect };
    } catch {
      return null;
    }
  }

  function pageSnapshot() {
    const pageRoot = document.querySelector("article") || document.querySelector("main") || document.body;
    return {
      kind: "page",
      title: document.title || "当前页",
      url: location.href,
      pageText: String(pageRoot?.innerText || pageRoot?.textContent || "").trim().slice(0, 20000),
    };
  }

  function selectionChipAllowed() {
    return state.chipEnabled && (!SITE_KEY || !state.disabledSites.includes(SITE_KEY));
  }

  function showChip(rect, text) {
    ensureUi();
    state.selectionText = text;
    chip.style.top = `${Math.max(8, rect.top - 42)}px`;
    chip.style.left = `${Math.max(8, Math.min(window.innerWidth - 100, rect.left + rect.width / 2 - 42))}px`;
    chip.style.display = "inline-flex";
  }

  function hideChip() {
    if (chip) chip.style.display = "none";
  }

  function hideActionMenu() {
    if (actionMenu) actionMenu.style.display = "none";
  }

  function openSelectionActions() {
    if (!state.selectionText) return;
    hideChip();
    actionMenu.style.top = chip.style.top;
    actionMenu.style.left = chip.style.left;
    actionMenu.style.display = "block";
    actionMenu.querySelector("button")?.focus();
  }

  function resetConversation(context) {
    if (state.busy && state.requestId) {
      chrome.runtime.sendMessage({ type: "host-cancel", requestId: state.requestId }).catch(() => {});
    }
    state.context = context || null;
    state.messages = [];
    state.sessionId = "";
    state.requestId = "";
    state.busy = false;
    state.assistantIndex = -1;
    state.liveChars = 0;
    if (input) input.value = "";
  }

  function openCard(context, options = {}) {
    ensureUi();
    hideChip();
    hideActionMenu();
    if (options.reset) resetConversation(context);
    else if (context) state.context = context;
    card.classList.add("open");
    renderAll();
    requestAnimationFrame(() => input.focus());
  }

  function closeCard() {
    if (state.busy) stopCurrent();
    card?.classList.remove("open");
  }

  function contextLabel(context) {
    if (context?.kind === "selection") return "引用文字";
    if (context?.kind === "image") return "引用图片";
    if (context?.kind === "link") return "引用链接";
    if (context?.kind === "page") return "引用当前页";
    return "引用";
  }

  function renderContext() {
    if (!contextEl) return;
    contextEl.querySelector("img")?.remove();
    if (!state.context) {
      contextEl.classList.remove("visible");
      return;
    }
    contextEl.classList.add("visible");
    contextEl.querySelector(".reference-label").textContent = contextLabel(state.context);
    const copy = contextEl.querySelector(".reference-copy");
    if (state.context.kind === "image" && state.context.image?.src) {
      const image = document.createElement("img");
      image.src = state.context.image.src;
      image.alt = state.context.image.alt || "选中的网页图片";
      contextEl.insertBefore(image, copy);
      contextEl.querySelector(".reference-text").textContent = state.context.image.alt || "网页图片";
    } else {
      contextEl.querySelector(".reference-text").textContent =
        state.context.text || state.context.title || state.context.url || "当前页";
    }
  }

  function addQuickButton(action, label) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = action;
    button.textContent = label;
    quickActions.appendChild(button);
  }

  function renderQuickActions() {
    quickActions.innerHTML = "";
    if (state.messages.length || state.busy) return;
    if (state.context?.kind === "selection") {
      addQuickButton("explain", "解释");
      addQuickButton("translate", "翻译");
    } else if (state.context?.kind === "image") {
      addQuickButton("describe", "描述图片");
      addQuickButton("ocr", "提取文字");
    } else if (!state.context) {
      addQuickButton("attach-page", "＋ 附带当前页");
    }
  }

  function renderMessages() {
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 50;
    log.innerHTML = "";
    for (const message of state.messages) {
      const row = document.createElement("div");
      row.className = `message ${message.role}`;
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = message.text || (message.role === "assistant" && state.busy ? "…" : "");
      row.appendChild(bubble);
      log.appendChild(row);
    }
    const last = state.messages.at(-1);
    if (last?.role === "assistant" && last.text && !state.busy) {
      const tools = document.createElement("div");
      tools.className = "answer-tools";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "copy-answer";
      copy.textContent = "复制答案";
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(last.text);
          copy.textContent = "已复制";
        } catch {
          copy.textContent = "复制失败";
        }
        setTimeout(() => (copy.textContent = "复制答案"), 1200);
      });
      tools.appendChild(copy);
      log.appendChild(tools);
    }
    if (nearBottom || state.busy) log.scrollTop = log.scrollHeight;
  }

  function updateControls() {
    if (!input) return;
    sendButton.disabled = state.busy || !input.value.trim();
    sendButton.classList.toggle("hidden", state.busy);
    stopButton.classList.toggle("hidden", !state.busy);
    status.classList.toggle("busy", state.busy);
    if (!state.busy && status.textContent === "正在生成…") status.textContent = "";
  }

  function renderAll() {
    renderContext();
    renderQuickActions();
    renderMessages();
    updateControls();
  }

  function handleSelectionAction(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const text = state.selectionText;
    if (!text) return;
    openCard({ kind: "selection", text }, { reset: true });
    if (button.dataset.action === "explain") sendPreset("请解释这段内容。");
    else if (button.dataset.action === "translate") sendPreset("请把这段内容翻译成中文；如果原文是中文，则翻译成英文。");
  }

  function handleQuickAction(event) {
    const action = event.target.closest("button[data-action]")?.dataset.action;
    if (!action) return;
    if (action === "explain") sendPreset("请解释这段内容。");
    else if (action === "translate") sendPreset("请把这段内容翻译成中文；如果原文是中文，则翻译成英文。");
    else if (action === "describe") sendPreset("请描述这张图片的主要内容。");
    else if (action === "ocr") sendPreset("请提取这张图片中的全部文字，尽量保持原有顺序和结构。");
    else if (action === "attach-page") {
      state.context = pageSnapshot();
      renderContext();
      renderQuickActions();
      input.focus();
    }
  }

  function sendPreset(prompt) {
    input.value = prompt;
    updateControls();
    sendCurrent();
  }

  function ensureAssistantMessage() {
    if (state.assistantIndex >= 0 && state.messages[state.assistantIndex]?.role === "assistant") {
      return state.messages[state.assistantIndex];
    }
    state.messages.push({ role: "assistant", text: "" });
    state.assistantIndex = state.messages.length - 1;
    return state.messages[state.assistantIndex];
  }

  function appendAssistant(text) {
    if (!text) return;
    const message = ensureAssistantMessage();
    message.text += text;
    state.liveChars += text.length;
    renderMessages();
  }

  function eventText(event) {
    if (!event || typeof event !== "object") return "";
    if (event.type === "text") return event.text || "";
    if (event.type === "partial" && !/thinking|host\.argv|stderr/i.test(String(event.rawType || ""))) {
      return event.text || "";
    }
    return "";
  }

  function handleHostEvent(event, sessionId) {
    if (sessionId) state.sessionId = sessionId;
    if (event?.type === "session" && event.sessionId) state.sessionId = event.sessionId;
    if (event?.type === "thinking" || /thinking/i.test(String(event?.rawType || ""))) {
      status.textContent = "正在思考…";
      return;
    }
    if (event?.type === "error") {
      appendAssistant(`请求失败：${event.text || "未知错误"}`);
      return;
    }
    appendAssistant(eventText(event));
  }

  function replayIfNeeded(events) {
    if (state.liveChars || !Array.isArray(events)) return;
    for (const event of events) appendAssistant(eventText(event));
  }

  async function sendCurrent() {
    const text = String(input?.value || "").trim();
    if (!text || state.busy) return;
    const requestId = `card-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    state.requestId = requestId;
    state.busy = true;
    state.assistantIndex = -1;
    state.liveChars = 0;
    state.messages.push({ role: "user", text });
    input.value = "";
    input.style.height = "52px";
    status.textContent = "正在生成…";
    renderAll();

    try {
      const result = await chrome.runtime.sendMessage({
        type: "quick-card-send",
        requestId,
        sessionId: state.sessionId,
        text,
        context: state.sessionId ? null : state.context,
      });
      if (state.requestId !== requestId) return;
      if (result?.sessionId) state.sessionId = result.sessionId;
      replayIfNeeded(result?.events);
      if (result?.error) appendAssistant(`请求失败：${result.error}`);
    } catch (error) {
      if (state.requestId === requestId) appendAssistant(`请求失败：${String(error)}`);
    } finally {
      if (state.requestId === requestId) {
        state.busy = false;
        state.requestId = "";
        status.textContent = "";
        renderAll();
        input.focus();
      }
    }
  }

  async function stopCurrent() {
    if (!state.busy || !state.requestId) return;
    const requestId = state.requestId;
    status.textContent = "正在停止…";
    try {
      await chrome.runtime.sendMessage({ type: "host-cancel", requestId });
    } catch {
      // The host disconnect path will also release the UI through the send promise.
    }
  }

  async function expandCard() {
    const handoff = {
      sessionId: state.sessionId,
      requestId: state.requestId,
      busy: state.busy,
      context: state.context,
      messages: state.messages.map((message) => ({ ...message })),
      draft: input.value,
    };
    const result = await chrome.runtime.sendMessage({ type: "expand-quick-card", handoff }).catch(
      (error) => ({ ok: false, error: String(error) })
    );
    if (result?.ok) card.classList.remove("open");
    else status.textContent = result?.error || "无法打开侧栏";
  }

  function onBackgroundMessage(message) {
    if (!message || typeof message !== "object") return;
    if (
      message.type === "conversation-turn" &&
      state.sessionId &&
      message.sessionId === state.sessionId &&
      message.requestId !== state.requestId
    ) {
      state.requestId = message.requestId;
      state.busy = true;
      state.assistantIndex = -1;
      state.liveChars = 0;
      state.messages.push({ role: "user", text: String(message.text || "") });
      status.textContent = "正在生成…";
      renderAll();
      return;
    }
    if (message.type === "host-event" && message.requestId === state.requestId) {
      handleHostEvent(message.event, message.sessionId);
      return;
    }
    if (message.type === "host-done" && message.requestId === state.requestId) {
      if (message.sessionId) state.sessionId = message.sessionId;
      replayIfNeeded(message.events);
      state.busy = false;
      state.requestId = "";
      status.textContent = message.error ? `请求失败：${message.error}` : "";
      renderAll();
      return;
    }
    if (message.type === "host-cancelled" && message.requestId === state.requestId) {
      state.busy = false;
      state.requestId = "";
      status.textContent = "已停止";
      renderAll();
    }
  }

  function connectPort() {
    try {
      state.port = chrome.runtime.connect({ name: "quick-card" });
      state.port.onMessage.addListener(onBackgroundMessage);
      state.port.onDisconnect.addListener(() => {
        state.port = null;
        setTimeout(connectPort, 500);
      });
    } catch {
      setTimeout(connectPort, 900);
    }
  }

  document.addEventListener("mouseup", (event) => {
    if (root?.contains(event.target) || event.button !== 0) return;
    if (!selectionChipAllowed() || isEditable(event.target) || isEditable(document.activeElement)) {
      hideChip();
      return;
    }
    const selection = currentSelection();
    if (!selection) {
      hideChip();
      return;
    }
    showChip(selection.rect, selection.text);
  });

  document.addEventListener("mousedown", (event) => {
    if (root?.contains(event.target)) return;
    hideActionMenu();
  });

  document.addEventListener("scroll", () => {
    hideChip();
    hideActionMenu();
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideChip();
      hideActionMenu();
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "open-quick-card") return false;
    const selection = currentSelection();
    let context = message.context || { kind: "prompt" };
    if (context.kind === "prompt" && selection?.text) {
      context = { kind: "selection", text: selection.text };
    }
    openCard(context.kind === "prompt" ? null : context, {
      reset: context.kind !== "prompt" || state.messages.length === 0,
    });
    sendResponse({ ok: true });
    return true;
  });

  chrome.storage.local.get(["selectionChipEnabled", "selectionChipDisabledSites"]).then((data) => {
    state.chipEnabled = data.selectionChipEnabled !== false;
    state.disabledSites = Array.isArray(data.selectionChipDisabledSites)
      ? data.selectionChipDisabledSites
      : [];
  });
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.selectionChipEnabled) {
      state.chipEnabled = changes.selectionChipEnabled.newValue !== false;
    }
    if (changes.selectionChipDisabledSites) {
      state.disabledSites = Array.isArray(changes.selectionChipDisabledSites.newValue)
        ? changes.selectionChipDisabledSites.newValue
        : [];
    }
    if (!selectionChipAllowed()) hideChip();
  });

  connectPort();
})();
