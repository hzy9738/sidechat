/**
 * 安能助手侧栏 UI → service worker → OpenAI-compatible Chat Completions.
 * 主路径：干净对话；设置 / 调试噪音默认收起。
 */
import { renderMarkdown, bindCopyButtons } from "./lib/markdown.js";
import { packBrowserContext, stripMentionTokens, localPathHintFromURL } from "./lib/context.js";
import { titleFromUserText } from "./lib/threads.js";
import { mapAssistantEventToUI } from "./lib/events.js";
import { isDebugQuestion } from "./lib/debug-capture.js";
import {
  PAGE_SCOPE_STORE_KEY,
  DEFAULT_THREAD_TITLE,
  derivePageScope,
  emptyScopeRecord,
  filterSessionsForScope,
  readScopeRecord,
  updateScopeRecord,
} from "./lib/page-scope.js";

const $ = (id) => document.getElementById(id);

const state = {
  sessionId: "",
  scopeKey: "",
  scopeRecord: emptyScopeRecord(),
  scopeEpoch: 0,
  windowId: null,
  drafts: new Map(),
  busy: false,
  requestId: "",
  lastPage: null,
  chips: /** @type {any[]} */ ([]),
  assistantEl: null,
  assistantRaw: "",
  thinkingEl: null,
  thinkingDetails: null,
  /** @type {Array<{id:string,title?:string,summary?:string,cwd?:string,updatedAt?:string,numMessages?:number}>} */
  sessions: [],
  sessionQuery: "",
  sessionLoading: false,
  sessionLoadToken: 0,
  lastHandoffAt: 0,
  followOutput: true,
  drawerReturnFocus: null,
  speakingButton: null,
  /** 本 turn 是否已通过 live 事件渲染过 thinking/assistant（用于 send_done 补渲染） */
  liveThinkingChars: 0,
  liveAssistantChars: 0,
  /** @type {chrome.runtime.Port|null} */
  port: null,
  mediaRecorder: null,
  mediaStream: null,
  recordingChunks: [],
};

function hideEmpty() {
  const el = $("empty-state");
  if (el) el.hidden = true;
}

/** 空态用蓝白字标，不用官网按钮 Logo。 */
function emptyStateHTML() {
  return `<div class="empty-mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="8" fill="#2161D7"/><path d="M8 12.5A2.5 2.5 0 0 1 10.5 10h11A2.5 2.5 0 0 1 24 12.5v7a2.5 2.5 0 0 1-2.5 2.5H16l-3.2 2.4a.8.8 0 0 1-1.3-.6V22H10.5A2.5 2.5 0 0 1 8 19.5v-7Z" fill="#fff"/><circle cx="24.5" cy="8.5" r="3.2" fill="#61C7F2"/></svg></div><p>你好，我是安能助手</p><p class="hint">可以提问，也可以录音、识图或读取 PDF</p>`;
}

function setBusy(busy) {
  state.busy = busy;
  if (!busy) finishThinking();
  $("btn-send").hidden = busy;
  $("btn-cancel").disabled = !busy;
  $("btn-cancel").hidden = !busy;
  $("turn-status").hidden = !busy;
  $("turn-status").textContent = busy ? "正在生成" : "";
  $("log").setAttribute("aria-busy", String(busy));
  updateSendAvailability();
}

function updateSendAvailability() {
  $("btn-send").disabled = state.busy || !$("input").value.trim();
}

function isLogNearBottom() {
  const log = $("log");
  return log.scrollHeight - log.scrollTop - log.clientHeight < 72;
}

function updateScrollAffordance() {
  $("btn-scroll-bottom").hidden = state.followOutput || !$("empty-state")?.hidden;
}

function scrollLog(force = false) {
  const log = $("log");
  if (force) state.followOutput = true;
  if (state.followOutput) log.scrollTop = log.scrollHeight;
  updateScrollAffordance();
}

function autosizeInput() {
  const ta = $("input");
  ta.style.height = "auto";
  ta.style.height = `${Math.min(160, Math.max(24, ta.scrollHeight))}px`;
  updateSendAvailability();
}

function renderChips() {
  const root = $("context-chips");
  root.innerHTML = "";
  if (!state.chips.length) {
    root.hidden = true;
    return;
  }
  root.hidden = false;
  for (const chip of state.chips) {
    const el = document.createElement("span");
    el.className = "chip";
    let label = `@${chip.kind}`;
    if (chip.kind === "tab") label = chip.title || chip.url || "@tab";
    else if (chip.kind === "selection") label = `选区 ${(chip.text || "").slice(0, 20)}`;
    else if (chip.kind === "page") label = chip.title || "当前页";
    else if (chip.kind === "pageText") label = "正文";
    else if (chip.kind === "image") label = chip.alt || chip.title || "选中图片";
    else if (chip.kind === "document") label = chip.title || "PDF 文档";
    else if (chip.kind === "debug") label = chip.title || "Network / Console 快照";
    el.appendChild(document.createTextNode(label));
    const x = document.createElement("button");
    x.type = "button";
    x.className = "x";
    x.textContent = "×";
    x.title = `移除${label}`;
    x.setAttribute("aria-label", `移除${label}`);
    x.addEventListener("click", () => {
      state.chips = state.chips.filter((c) => c !== chip);
      renderChips();
    });
    el.appendChild(x);
    root.appendChild(el);
  }
}

function appendUserBubble(text) {
  hideEmpty();
  const log = $("log");
  const wrap = document.createElement("div");
  wrap.className = "msg user";
  const bubble = document.createElement("div");
  bubble.className = "bubble-user";
  bubble.textContent = text;
  wrap.appendChild(bubble);
  log.appendChild(wrap);
  scrollLog(true);
}

function finishThinking() {
  if (!state.thinkingDetails) return;
  state.thinkingDetails.open = false;
  const summary = state.thinkingDetails.querySelector("summary");
  if (summary) summary.textContent = "思考完成";
  state.thinkingEl = null;
  state.thinkingDetails = null;
}

function ensureAssistantBubble() {
  if (state.assistantEl) return state.assistantEl;
  finishThinking();
  hideEmpty();
  const log = $("log");
  const wrap = document.createElement("div");
  wrap.className = "msg assistant";
  const bubble = document.createElement("div");
  bubble.className = "bubble-assistant";
  const md = document.createElement("div");
  md.className = "md";
  bubble.appendChild(md);
  const actions = document.createElement("div");
  actions.className = "msg-actions";
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "btn-copy-msg";
  copyBtn.textContent = "复制";
  copyBtn.title = "复制回复";
  copyBtn.setAttribute("aria-label", "复制回复");
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(state.assistantRaw || md.innerText || "");
      copyBtn.textContent = "已复制";
      setTimeout(() => (copyBtn.textContent = "复制"), 1000);
    } catch {
      copyBtn.textContent = "复制失败";
      setTimeout(() => (copyBtn.textContent = "复制"), 1400);
    }
  });
  actions.appendChild(copyBtn);
  const speakBtn = document.createElement("button");
  speakBtn.type = "button";
  speakBtn.className = "btn-copy-msg";
  speakBtn.textContent = "朗读";
  speakBtn.title = "朗读回复";
  speakBtn.setAttribute("aria-label", "朗读回复");
  speakBtn.setAttribute("aria-pressed", "false");
  speakBtn.addEventListener("click", () => {
    const text = (md.innerText || state.assistantRaw || "").trim();
    if (!text || !window.speechSynthesis) return;
    if (state.speakingButton === speakBtn) {
      window.speechSynthesis.cancel();
      state.speakingButton = null;
      speakBtn.textContent = "朗读";
      speakBtn.setAttribute("aria-pressed", "false");
      return;
    }
    if (state.speakingButton) {
      state.speakingButton.textContent = "朗读";
      state.speakingButton.setAttribute("aria-pressed", "false");
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    const resetSpeakButton = () => {
      if (state.speakingButton !== speakBtn) return;
      state.speakingButton = null;
      speakBtn.textContent = "朗读";
      speakBtn.setAttribute("aria-pressed", "false");
    };
    utterance.addEventListener("end", resetSpeakButton, { once: true });
    utterance.addEventListener("error", resetSpeakButton, { once: true });
    state.speakingButton = speakBtn;
    speakBtn.textContent = "停止朗读";
    speakBtn.setAttribute("aria-pressed", "true");
    window.speechSynthesis.speak(utterance);
  });
  actions.appendChild(speakBtn);
  wrap.appendChild(bubble);
  wrap.appendChild(actions);
  log.appendChild(wrap);
  state.assistantEl = wrap;
  state.assistantRaw = "";
  scrollLog();
  return wrap;
}

function updateAssistantMarkdown(text, append) {
  const el = ensureAssistantBubble();
  const md = el.querySelector(".md");
  if (append) state.assistantRaw += text;
  else state.assistantRaw = text;
  md.innerHTML = renderMarkdown(state.assistantRaw);
  bindCopyButtons(md);
  scrollLog();
}

function appendThinking(text) {
  hideEmpty();
  const log = $("log");
  if (!state.thinkingEl) {
    const details = document.createElement("details");
    details.className = "thinking";
    // 默认展开，方便看到思考过程（可点标题折叠）
    details.open = true;
    const summary = document.createElement("summary");
    summary.textContent = "正在思考…";
    const body = document.createElement("div");
    body.className = "thinking-body";
    details.appendChild(summary);
    details.appendChild(body);
    log.appendChild(details);
    state.thinkingEl = body;
    state.thinkingDetails = details;
  }
  state.thinkingEl.textContent = (state.thinkingEl.textContent || "") + text;
  // 流式思考时保持展开并滚到底部
  if (state.thinkingDetails) state.thinkingDetails.open = true;
  state.thinkingEl.scrollTop = state.thinkingEl.scrollHeight;
  scrollLog();
}

function appendError(text) {
  text = String(text || "请求失败");
  hideEmpty();
  const log = $("log");
  const last = log.lastElementChild;
  if (last?.classList?.contains("err-banner") && last.textContent === text) {
    scrollLog();
    return;
  }
  const div = document.createElement("div");
  div.className = "err-banner";
  div.textContent = text;
  log.appendChild(div);
  scrollLog();
}

async function collectPage(tabId) {
  const res = await chrome.runtime.sendMessage({
    type: "get-page-context",
    tabId,
    windowId: state.windowId,
    includeTabs: true,
  });
  if (!res?.ok) {
    // 不弹大红条打断闲聊；仅当用户明确 @ 时再提示
    return null;
  }
  const browser = res.browser || {};
  browser.localPathHint = localPathHintFromURL(browser.url || "");
  state.lastPage = browser;
  return browser;
}

let scopePersistQueue = Promise.resolve();

function persistScopePatch(patch, expectedScope = state.scopeKey) {
  if (!expectedScope) return Promise.resolve();
  const localStore = updateScopeRecord(
    { [expectedScope]: state.scopeRecord },
    expectedScope,
    patch
  );
  if (state.scopeKey === expectedScope) {
    state.scopeRecord = readScopeRecord(localStore, expectedScope);
  }
  scopePersistQueue = scopePersistQueue.catch(() => {}).then(async () => {
    const data = await chrome.storage.session.get(PAGE_SCOPE_STORE_KEY);
    const nextStore = updateScopeRecord(data[PAGE_SCOPE_STORE_KEY], expectedScope, patch);
    await chrome.storage.session.set({ [PAGE_SCOPE_STORE_KEY]: nextStore });
    if (state.scopeKey === expectedScope) {
      state.scopeRecord = readScopeRecord(nextStore, expectedScope);
    }
  });
  return scopePersistQueue;
}

function closePopovers() {
  $("settings-panel").hidden = true;
  $("attach-menu").hidden = true;
  setMentionPopupOpen(false);
  $("btn-settings").setAttribute("aria-expanded", "false");
  $("btn-attach").setAttribute("aria-expanded", "false");
}

function isDrySessionId(id) {
  return /^dry-session/i.test(String(id || ""));
}

function applySessionId(id, expectedScope = state.scopeKey) {
  if (!id) return;
  if (!expectedScope || state.scopeKey !== expectedScope) return;
  // dry-run 的 session 不写入真实续聊
  if (isDrySessionId(id) && !$("dry-run").checked) return;
  if (isDrySessionId(id)) {
    $("session-id").textContent = "dry-run";
    return;
  }
  state.sessionId = id;
  $("session-id").textContent = state.sessionId;
  persistScopePatch({ activeSessionId: state.sessionId }, expectedScope).catch(() => {});
  renderSessionList();
}

function handleAssistantEvent(event) {
  const cmds = mapAssistantEventToUI(event);
  for (const cmd of cmds) {
    switch (cmd.kind) {
      case "hidden":
        break;
      case "thinking":
        appendThinking(cmd.text || "");
        state.liveThinkingChars += (cmd.text || "").length;
        break;
      case "assistant":
        // 新 assistant 段前关闭 thinking 句柄，避免串
        updateAssistantMarkdown(cmd.text || "", !!cmd.streaming);
        state.liveAssistantChars += (cmd.text || "").length;
        break;
      case "error":
        appendError(cmd.text || "error");
        break;
      case "session":
        applySessionId(cmd.sessionId);
        break;
      default:
        break;
    }
  }
}

/** 统一处理 background → sidepanel 消息（Port 与 runtime 双通道）。 */
function onBackgroundMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "assistant-event") {
    // 只接收当前页面当前 turn 的事件，避免切页后旧流继续写入新页面。
    if (!state.requestId || msg.requestId !== state.requestId) return;
    if (msg.sessionId) applySessionId(msg.sessionId);
    if (msg.event) handleAssistantEvent(msg.event);
    return;
  }
  if (msg.type === "assistant-done") {
    if (!state.requestId || msg.requestId !== state.requestId) return;
    if (msg.sessionId) applySessionId(msg.sessionId);
    replayEventsIfNeeded(msg.events || []);
    if (msg.error) appendError(msg.error);
    state.requestId = "";
    setBusy(false);
    state.assistantEl = null;
    return;
  }
  if (msg.type === "assistant-cancelled") {
    if (!state.requestId || msg.requestId !== state.requestId) return;
    state.requestId = "";
    setBusy(false);
    state.assistantEl = null;
    return;
  }
  if (msg.type === "active-page-changed" && msg.page) {
    if (state.windowId != null && msg.page.windowId !== state.windowId) return;
    queuePageActivation(msg.page).catch(() => {});
    return;
  }
  if (msg.type === "page-tab-removed") {
    const prefix = `v1|tab:${Number(msg.tabId)}|`;
    for (const key of state.drafts.keys()) {
      if (key.startsWith(prefix)) state.drafts.delete(key);
    }
    return;
  }
  if (msg.type === "prefill-selection" && msg.selection) {
    applyPendingAsk({
      kind: "selection",
      text: msg.selection,
      tabId: msg.tabId,
    }).catch(() => {});
  }
  if (msg.type === "pending-ask" && msg.ask) {
    applyPendingAsk(msg.ask).catch(() => {});
  }
}

/** 消费右键 / 划词带来的待问内容。 */
async function applyPendingAsk(ask) {
  if (!ask || typeof ask !== "object") return;
  if (ask.kind === "card-handoff") {
    await applyCardHandoff(ask);
    return;
  }
  const page = await collectPage(ask.tabId);
  if (state.windowId != null && page?.windowId != null && page.windowId !== state.windowId) return;
  if (page) await queuePageActivation(page);
  const input = $("input");
  if (ask.kind === "image") {
    addChip({
      kind: "image",
      src: ask.image?.src || "",
      dataUrl: ask.image?.dataUrl || "",
      alt: ask.image?.alt || "选中图片",
      title: "选中图片",
    });
    if (input && !input.value.trim()) {
      input.value = ask.text || "这张图是什么？请结合当前页说明。";
    }
  } else if (ask.kind === "page") {
    addChip({ kind: "page", title: page?.title || "", url: ask.pageUrl || page?.url || "" });
    if (input) input.value = ask.text || "请总结当前页要点。";
  } else if (ask.kind === "link") {
    addChip({ kind: "page", title: ask.text || "链接", url: ask.pageUrl || ask.text || "" });
    if (input) input.value = `请介绍这个链接：${ask.pageUrl || ask.text || ""}`;
  } else {
    const text = ask.text || ask.selection || "";
    if (text) addChip({ kind: "selection", text });
    if (input) input.value = text ? `请解释这段内容：\n${text}` : input.value;
  }
  autosizeInput();
  input?.focus();
}

function contextToChip(context) {
  if (!context || typeof context !== "object") return null;
  if (context.kind === "selection" && context.text) {
    return { kind: "selection", text: context.text };
  }
  if (context.kind === "image" && context.image) {
    return {
      kind: "image",
      src: context.image.src || "",
      dataUrl: context.image.dataUrl || "",
      alt: context.image.alt || "选中图片",
      title: "选中图片",
    };
  }
  if (context.kind === "page") {
    return context.pageText
      ? { kind: "pageText", text: context.pageText, title: context.title || "当前页" }
      : { kind: "page", title: context.title || "当前页", url: context.url || "" };
  }
  if (context.kind === "link" && context.url) {
    return { kind: "page", title: "链接", url: context.url };
  }
  return null;
}

function assistantTextFromEvents(events) {
  let text = "";
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === "text") text += event.text || "";
    else if (
      event?.type === "partial" &&
      !/thinking|stderr/i.test(String(event.rawType || ""))
    ) {
      text += event.text || "";
    }
  }
  return text;
}

/** Hydrate the side panel from the same quick-card turn without resending it. */
async function applyCardHandoff(ask) {
  if (ask.createdAt && ask.createdAt <= state.lastHandoffAt) return;
  state.lastHandoffAt = Number(ask.createdAt || Date.now());
  const page = await collectPage(ask.tabId);
  if (state.windowId != null && page?.windowId != null && page.windowId !== state.windowId) return;
  if (page) await queuePageActivation(page);

  const messages = Array.isArray(ask.messages)
    ? ask.messages.map((message) => ({
        role: message?.role === "assistant" ? "assistant" : "user",
        text: String(message?.text || ""),
      }))
    : [];
  const eventText = assistantTextFromEvents(ask.events);
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (eventText && (!lastAssistant || eventText.length > lastAssistant.text.length)) {
    if (lastAssistant) lastAssistant.text = eventText;
    else messages.push({ role: "assistant", text: eventText });
  }

  const log = $("log");
  log.innerHTML = messages.length ? "" : `<div id="empty-state" class="empty">${emptyStateHTML()}</div>`;
  state.assistantEl = null;
  state.assistantRaw = "";
  state.thinkingEl = null;
  state.thinkingDetails = null;
  state.liveThinkingChars = 0;
  state.liveAssistantChars = 0;
  for (const message of messages) {
    if (message.role === "user") {
      appendUserBubble(message.text);
      state.assistantEl = null;
      state.assistantRaw = "";
    } else {
      state.assistantEl = null;
      state.assistantRaw = "";
      updateAssistantMarkdown(message.text, false);
      state.liveAssistantChars = message.text.length;
    }
  }

  const chip = contextToChip(ask.context);
  state.chips = chip ? [chip] : [];
  renderChips();
  if (ask.sessionId) applySessionId(ask.sessionId);
  const input = $("input");
  input.value = String(ask.draft || "");
  autosizeInput();

  state.requestId = ask.busy && ask.requestId ? String(ask.requestId) : "";
  setBusy(!!state.requestId);
  if (!state.requestId) state.assistantEl = null;
  scrollLog(true);
  input.focus();
}

chrome.runtime.onMessage.addListener((msg) => {
  onBackgroundMessage(msg);
});

/** 长连接 Port：流式 thinking/text 可靠送达（sendMessage 在侧栏 await 时可能丢）。 */
function connectSidepanelPort() {
  try {
    if (state.port) {
      try {
        state.port.disconnect();
      } catch {
        /* ignore */
      }
    }
    state.port = chrome.runtime.connect({ name: "sidepanel" });
    state.port.onMessage.addListener(onBackgroundMessage);
    state.port.onDisconnect.addListener(() => {
      state.port = null;
      // service worker 休眠后重连
      setTimeout(connectSidepanelPort, 400);
    });
  } catch {
    setTimeout(connectSidepanelPort, 800);
  }
}
connectSidepanelPort();

/**
 * 完成事件后仅当 live 完全没收到对应内容时，用 batch events 补一次。
 * 有任何 live 字符就不再 replay，避免与 Port 流叠成「TheThe user user」。
 * @param {any[]} events
 */
function replayEventsIfNeeded(events) {
  if (!Array.isArray(events) || !events.length) return;
  const needThinking = state.liveThinkingChars === 0;
  const needAssistant = state.liveAssistantChars === 0;
  if (!needThinking && !needAssistant) return;

  let think = "";
  let text = "";
  for (const ev of events) {
    if (!ev) continue;
    if (ev.type === "thinking") think += ev.text || "";
    else if (ev.type === "partial" && /thinking/i.test(String(ev.rawType || ""))) think += ev.text || "";
    else if (ev.type === "text") text += ev.text || "";
    else if (
      ev.type === "partial" &&
      ev.rawType !== "stderr" &&
      !/thinking/i.test(String(ev.rawType || ""))
    ) {
      text += ev.text || "";
    }
  }
  if (needThinking && think.trim()) {
    state.thinkingEl = null;
    state.thinkingDetails = null;
    appendThinking(think);
    state.liveThinkingChars = think.length;
  }
  if (needAssistant && text.trim()) {
    state.assistantEl = null;
    state.assistantRaw = "";
    updateAssistantMarkdown(text, false);
    state.liveAssistantChars = text.length;
  }
}

/** 强制解锁 busy（切换会话 / 取消后）。 */
async function forceUnlock(reason) {
  if (state.requestId) {
    try {
      await chrome.runtime.sendMessage({ type: "assistant-cancel", requestId: state.requestId });
    } catch {
      /* ignore */
    }
  }
  state.busy = false;
  setBusy(false);
  state.requestId = "";
  if (reason) {
    // 不刷错误条，避免切换会话吵；仅 console
    console.debug("[sidepanel] unlock:", reason);
  }
}

function addChip(chip) {
  if (chip.kind !== "tab") {
    state.chips = state.chips.filter((c) => c.kind !== chip.kind);
  }
  state.chips.push(chip);
  renderChips();
}

function setMediaStatus(text) {
  const el = $("media-status");
  if (el) el.textContent = text || "";
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

let pdfModulePromise = null;

async function extractPdfText(file) {
  if (!pdfModulePromise) pdfModulePromise = import("./vendor/pdf.mjs");
  const pdfjs = await pdfModulePromise;
  pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.mjs");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const document = await pdfjs.getDocument({ data: bytes }).promise;
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => String(item?.str || ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) pages.push(`第 ${pageNumber} 页\n${text}`);
    }
  } finally {
    await document.destroy();
  }
  const text = pages.join("\n\n").slice(0, 120_000).trim();
  if (!text) throw new Error("未从 PDF 中提取到文字；扫描件请先使用识图功能。");
  return text;
}

async function stopRecording() {
  const recorder = state.mediaRecorder;
  if (recorder && recorder.state !== "inactive") recorder.stop();
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    appendError("当前浏览器不支持录音。");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(
      (type) => MediaRecorder.isTypeSupported(type)
    );
    const recorder = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream);
    state.mediaStream = stream;
    state.mediaRecorder = recorder;
    state.recordingChunks = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size) state.recordingChunks.push(event.data);
    });
    recorder.addEventListener("stop", async () => {
      $("btn-voice")?.classList.remove("recording");
      state.mediaStream?.getTracks?.().forEach((track) => track.stop());
      const chunks = state.recordingChunks.slice();
      const type = recorder.mimeType || chunks[0]?.type || "audio/webm";
      state.mediaRecorder = null;
      state.mediaStream = null;
      state.recordingChunks = [];
      if (!chunks.length) {
        setMediaStatus("");
        return;
      }
      try {
        setMediaStatus("正在转写…");
        const mediaData = await fileToDataURL(new Blob(chunks, { type }));
        const response = await chrome.runtime.sendMessage({
          type: "transcribe-audio",
          mediaData,
          mimeType: type,
          fileName: type.includes("mp4") ? "recording.m4a" : "recording.webm",
          apiBase: $("api-base")?.value.trim() || "",
          apiKey: $("api-key")?.value.trim() || "",
        });
        if (!response?.ok) throw new Error(response?.error || "语音转写失败");
        const input = $("input");
        input.value = [input.value.trim(), response.text.trim()].filter(Boolean).join("\n");
        autosizeInput();
        input.focus();
        setMediaStatus("已转成文字");
      } catch (error) {
        setMediaStatus("");
        appendError(String(error?.message || error));
      }
    });
    recorder.start(500);
    $("btn-voice")?.classList.add("recording");
    setMediaStatus("录音中，再点一次结束");
  } catch (error) {
    setMediaStatus("");
    appendError(`无法使用麦克风：${String(error?.message || error)}`);
  }
}

$("btn-voice")?.addEventListener("click", () => {
  if (state.mediaRecorder?.state === "recording") stopRecording();
  else startRecording();
});

$("btn-ocr")?.addEventListener("click", () => $("ocr-file")?.click());
$("ocr-file")?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (file.size > 6 * 1024 * 1024) {
    appendError("图片不能超过 6 MB。");
    return;
  }
  try {
    setMediaStatus("正在读取图片…");
    const dataUrl = await fileToDataURL(file);
    addChip({ kind: "image", dataUrl, alt: file.name, title: file.name });
    const input = $("input");
    if (!input.value.trim()) input.value = "请识别图片中的文字，并按原有结构整理。";
    autosizeInput();
    input.focus();
    setMediaStatus("图片已附加");
  } catch (error) {
    setMediaStatus("");
    appendError(String(error?.message || error));
  }
});

$("btn-pdf")?.addEventListener("click", () => $("pdf-file")?.click());
$("pdf-file")?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) {
    appendError("PDF 不能超过 20 MB。");
    return;
  }
  try {
    setMediaStatus("正在读取 PDF…");
    const text = await extractPdfText(file);
    addChip({ kind: "document", title: file.name, text });
    const input = $("input");
    if (!input.value.trim()) input.value = "请总结这份 PDF，并列出关键信息。";
    autosizeInput();
    input.focus();
    setMediaStatus("PDF 已附加");
  } catch (error) {
    setMediaStatus("");
    appendError(String(error?.message || error));
  }
});

async function addChipFromKind(kind) {
  const page = (await collectPage()) || {};
  if (kind === "page") addChip({ kind: "page", title: page.title || "", url: page.url || "" });
  else if (kind === "selection") addChip({ kind: "selection", text: page.selection || "(无选区)" });
  else if (kind === "tabs") {
    for (const t of page.tabs || []) {
      addChip({ kind: "tab", title: t.title || "", url: t.url || "", tabId: t.id });
    }
  } else if (kind === "pageText") {
    addChip({ kind: "pageText", text: (page.pageText || "").slice(0, 500) });
  }
}

// Attach / settings — floating popovers, never stay in document flow
$("btn-attach").addEventListener("click", (e) => {
  e.stopPropagation();
  const willOpen = $("attach-menu").hidden;
  $("settings-panel").hidden = true;
  $("btn-settings").setAttribute("aria-expanded", "false");
  $("attach-menu").hidden = !willOpen;
  $("btn-attach").setAttribute("aria-expanded", String(willOpen));
  if (willOpen) requestAnimationFrame(() => $("attach-menu").querySelector("button")?.focus());
});
document.querySelectorAll("[data-add-chip]").forEach((btn) => {
  btn.addEventListener("click", () => {
    addChipFromKind(btn.getAttribute("data-add-chip"));
    $("attach-menu").hidden = true;
    $("btn-attach").setAttribute("aria-expanded", "false");
    $("input").focus();
  });
});

$("btn-settings").addEventListener("click", (e) => {
  e.stopPropagation();
  const willOpen = $("settings-panel").hidden;
  $("attach-menu").hidden = true;
  $("btn-attach").setAttribute("aria-expanded", "false");
  $("settings-panel").hidden = !willOpen;
  $("btn-settings").setAttribute("aria-expanded", String(willOpen));
  if (willOpen) {
    refreshSelectionSiteButton().catch(() => {});
    requestAnimationFrame(() => $("api-base")?.focus());
  }
});
$("btn-close-settings")?.addEventListener("click", (e) => {
  e.stopPropagation();
  $("settings-panel").hidden = true;
  $("btn-settings").setAttribute("aria-expanded", "false");
  $("btn-settings").focus();
});

// 点页面任意处关闭浮层（浮层内部 stopPropagation）
document.addEventListener("click", () => closePopovers());
$("settings-panel").addEventListener("click", (e) => e.stopPropagation());
$("attach-menu").addEventListener("click", (e) => e.stopPropagation());
$("composer-box")?.addEventListener?.("click", (e) => {
  // 点输入区不关，但点 ⋯/@ 由各自 handler 处理
  if (e.target.closest("#btn-settings") || e.target.closest("#btn-attach")) return;
});
// composer-box 不存在 id — 用 class
document.querySelector(".composer-box")?.addEventListener("click", (e) => {
  e.stopPropagation();
});

// @ mention popup
const MENTION_ITEMS = [
  { kind: "page", label: "当前页", desc: "标题与 URL" },
  { kind: "selection", label: "选中文本", desc: "页面选区" },
  { kind: "tabs", label: "标签页", desc: "当前窗口" },
  { kind: "pageText", label: "页面正文", desc: "摘录" },
];

function setMentionPopupOpen(open) {
  $("mention-popup").hidden = !open;
  $("input").setAttribute("aria-expanded", String(open));
  if (!open) $("input").removeAttribute("aria-activedescendant");
}

function updateMentionPopup() {
  const input = $("input");
  const popup = $("mention-popup");
  const val = input.value;
  const caret = input.selectionStart || 0;
  const before = val.slice(0, caret);
  const at = before.match(/(?:^|\s)@([\w-]*)$/);
  if (!at) {
    setMentionPopupOpen(false);
    popup.innerHTML = "";
    return;
  }
  const q = (at[1] || "").toLowerCase();
  const items = MENTION_ITEMS.filter(
    (i) => !q || i.kind.startsWith(q) || i.label.includes(q)
  );
  if (!items.length) {
    setMentionPopupOpen(false);
    return;
  }
  popup.innerHTML = "";
  items.forEach((item, idx) => {
    const b = document.createElement("button");
    b.type = "button";
    b.id = `mention-option-${idx}`;
    b.className = `mention-item${idx === 0 ? " active" : ""}`;
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", String(idx === 0));
    b.innerHTML = `<strong>${item.label}</strong><div class="muted">${item.desc}</div>`;
    b.addEventListener("click", () => applyMention(item.kind));
    popup.appendChild(b);
  });
  setMentionPopupOpen(true);
  $("input").setAttribute("aria-activedescendant", "mention-option-0");
}

function moveMentionSelection(delta) {
  const items = [...$("mention-popup").querySelectorAll(".mention-item")];
  if (!items.length) return;
  const current = Math.max(0, items.findIndex((item) => item.classList.contains("active")));
  const next = (current + delta + items.length) % items.length;
  items.forEach((item, index) => {
    const active = index === next;
    item.classList.toggle("active", active);
    item.setAttribute("aria-selected", String(active));
  });
  $("input").setAttribute("aria-activedescendant", items[next].id);
  items[next].scrollIntoView({ block: "nearest" });
}

function applyMention(kind) {
  const input = $("input");
  const val = input.value;
  const caret = input.selectionStart || 0;
  const before = val.slice(0, caret);
  const after = val.slice(caret);
  const replaced = before.replace(/(?:^|\s)@([\w-]*)$/, (m) => {
    const lead = m.startsWith(" ") || m.startsWith("\n") ? m[0] : "";
    const token = kind === "pageText" ? "@body" : `@${kind === "tabs" ? "tabs" : kind}`;
    return `${lead}${token} `;
  });
  input.value = replaced + after;
  setMentionPopupOpen(false);
  addChipFromKind(kind === "pageText" ? "pageText" : kind);
  input.focus();
  autosizeInput();
}

$("input").addEventListener("focus", () => {
  closePopovers();
});
$("input").addEventListener("input", () => {
  updateMentionPopup();
  autosizeInput();
});
$("input").addEventListener("keydown", (e) => {
  if (!$("mention-popup").hidden && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    moveMentionSelection(e.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (!$("mention-popup").hidden && e.key === "Escape") {
    e.preventDefault();
    setMentionPopupOpen(false);
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!$("mention-popup").hidden) {
      const active = $("mention-popup").querySelector(".mention-item.active");
      if (active) {
        active.click();
        return;
      }
    }
    $("btn-send").click();
  }
});

// ---------- 历史会话（列表 / 搜索 / 选中续聊） ----------

function escapeText(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function clearFeed() {
  const log = $("log");
  log.innerHTML = "";
  const empty = document.createElement("div");
  empty.id = "empty-state";
  empty.className = "empty";
  empty.innerHTML = emptyStateHTML();
  log.appendChild(empty);
  state.assistantEl = null;
  state.thinkingEl = null;
  state.thinkingDetails = null;
  state.assistantRaw = "";
  state.followOutput = true;
  updateScrollAffordance();
}

let scopeActivationQueue = Promise.resolve();

function queuePageActivation(page) {
  scopeActivationQueue = scopeActivationQueue
    .then(() => activatePageScope(page))
    .catch((error) => console.debug("[sidepanel] page scope activation failed:", error));
  return scopeActivationQueue;
}

async function activatePageScope(page) {
  const nextScope = derivePageScope(page?.tabId, page?.url || "");
  if (!nextScope) return false;
  state.lastPage = page;
  if (nextScope === state.scopeKey) return false;

  const input = $("input");
  if (state.scopeKey) {
    state.drafts.set(state.scopeKey, {
      text: input?.value || "",
      chips: state.chips.slice(),
    });
  }
  if (state.busy) await forceUnlock("page-scope-changed");

  const epoch = ++state.scopeEpoch;
  state.scopeKey = nextScope;
  state.sessionId = "";
  state.scopeRecord = emptyScopeRecord();
  state.sessions = [];
  state.requestId = "";
  $("session-id").textContent = "新";
  $("thread-title").textContent = DEFAULT_THREAD_TITLE;
  closeDrawer();
  clearFeed();

  const draft = state.drafts.get(nextScope);
  if (input) input.value = draft?.text || "";
  state.chips = Array.isArray(draft?.chips) ? draft.chips.slice() : [];
  renderChips();
  autosizeInput();

  await scopePersistQueue.catch(() => {});
  const data = await chrome.storage.session.get(PAGE_SCOPE_STORE_KEY);
  if (state.scopeKey !== nextScope || state.scopeEpoch !== epoch) return true;
  state.scopeRecord = readScopeRecord(data[PAGE_SCOPE_STORE_KEY], nextScope);
  state.sessionId = state.scopeRecord.activeSessionId;
  $("session-id").textContent = state.sessionId || "新";
  $("thread-title").textContent = state.scopeRecord.title || DEFAULT_THREAD_TITLE;
  if (state.sessionId) {
    await selectSession(state.sessionId, {
      expectedScope: nextScope,
      closeAfter: false,
    });
  }
  return true;
}

function formatSessionTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function shortCwd(cwd) {
  if (!cwd) return "";
  const home = ""; // browser side can't expand ~
  const s = String(cwd);
  if (s.length <= 36) return s;
  return "…" + s.slice(-34);
}

async function loadSessions(query) {
  const loadToken = ++state.sessionLoadToken;
  state.sessionLoading = true;
  const status = $("session-list-status");
  if (status) status.textContent = "加载会话…";
  try {
    const res = await chrome.runtime.sendMessage({
      type: "list-sessions",
      query: query || "",
      limit: 200,
    });
    if (loadToken !== state.sessionLoadToken) return;
    if (!res?.ok) {
      state.sessions = [];
      if (status) status.textContent = res?.error || "无法加载会话";
      renderSessionList();
      return;
    }
    state.sessions = filterSessionsForScope(res.sessions, state.scopeRecord);
    if (status) {
      status.textContent = state.sessions.length
        ? `${state.sessions.length} 个本页会话`
        : "当前标签页暂无会话";
    }
    renderSessionList();
  } catch (e) {
    if (loadToken !== state.sessionLoadToken) return;
    state.sessions = [];
    if (status) status.textContent = String(e?.message || e);
    renderSessionList();
  } finally {
    if (loadToken === state.sessionLoadToken) state.sessionLoading = false;
  }
}

function renderSessionList() {
  const ul = $("thread-list");
  if (!ul) return;
  ul.innerHTML = "";
  for (const s of state.sessions) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    const active = s.id && s.id === state.sessionId;
    btn.className = `thread-item${active ? " active" : ""}`;
    if (active) btn.setAttribute("aria-current", "page");
    const title = s.title || s.summary || "（无标题）";
    const time = formatSessionTime(s.updatedAt);
    const cwd = shortCwd(s.cwd);
    btn.innerHTML =
      `<span class="title">${escapeText(title)}</span>` +
      (cwd ? `<span class="preview">${escapeText(cwd)}</span>` : "") +
      `<span class="meta">${escapeText(time)}${s.numMessages ? " · " + s.numMessages + " 条" : ""}</span>`;
    btn.addEventListener("click", () => selectSession(s.id));
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

/**
 * 选中历史会话：加载 transcript 并续聊。
 */
async function selectSession(sessionId, options = {}) {
  if (!sessionId) return;
  const expectedScope = options.expectedScope || state.scopeKey;
  if (!expectedScope || state.scopeKey !== expectedScope) return;
  if (!state.scopeRecord.sessionIds.includes(sessionId)) {
    appendError("已阻止打开其他网页绑定的会话。");
    return;
  }
  // 切换会话时必须打断当前 turn，否则 busy 卡住导致「发送了但输入框不空」
  if (state.busy) await forceUnlock("switch-session");
  const status = $("session-list-status");
  if (status) status.textContent = "打开会话…";
  try {
    const res = await chrome.runtime.sendMessage({
      type: "get-session",
      sessionId,
      limit: 60,
    });
    if (!res?.ok) {
      appendError(res?.error || "无法打开会话");
      return;
    }
    if (state.scopeKey !== expectedScope) return;
    state.sessionId = res.sessionId || sessionId;
    const title = res.session?.title || res.session?.summary || "会话";
    $("session-id").textContent = state.sessionId;
    $("thread-title").textContent = title;
    await persistScopePatch(
      { activeSessionId: state.sessionId, title },
      expectedScope
    ).catch(() => {});
    if (state.scopeKey !== expectedScope) return;

    clearFeed();
    hideEmpty();
    const msgs = Array.isArray(res.messages) ? res.messages : [];
    if (!msgs.length) {
      const log = $("log");
      const tip = document.createElement("div");
      tip.className = "tool-row";
      tip.innerHTML = `<strong>已选中历史会话</strong><div class="tool-preview">暂无本地 transcript 预览，发送消息将 --resume 续聊</div>`;
      log.appendChild(tip);
    } else {
      for (const m of msgs) {
        if (m.role === "user") appendUserBubble(m.text || "");
        else if (m.role === "thinking") appendThinking(m.text || "");
        else if (m.role === "assistant") {
          state.assistantEl = null;
          state.assistantRaw = "";
          updateAssistantMarkdown(m.text || "", false);
          state.assistantEl = null;
          state.assistantRaw = "";
        }
      }
    }
    renderSessionList();
    if (options.closeAfter !== false) {
      closeDrawer();
      $("input").focus();
    }
  } catch (e) {
    if (state.scopeKey === expectedScope) appendError(String(e));
  }
}

function persistActiveThread(patch) {
  // 续聊时更新标题展示；历史列表仍以本机会话库为准
  if (patch?.title) $("thread-title").textContent = patch.title;
  if (patch?.sessionId) {
    state.sessionId = patch.sessionId;
    $("session-id").textContent = state.sessionId;
    persistScopePatch({ activeSessionId: state.sessionId }).catch(() => {});
  }
}

function newThread() {
  if (state.busy) forceUnlock("new-thread");
  state.sessionId = "";
  $("session-id").textContent = "新";
  $("thread-title").textContent = DEFAULT_THREAD_TITLE;
  persistScopePatch({ activeSessionId: "", title: DEFAULT_THREAD_TITLE }).catch(() => {});
  clearFeed();
  renderSessionList();
  closeDrawer();
  $("input").focus();
}

function openDrawer() {
  state.drawerReturnFocus = document.activeElement;
  document.querySelector(".shell").inert = true;
  $("thread-drawer").hidden = false;
  $("drawer-scrim").hidden = false;
  $("btn-threads").setAttribute("aria-expanded", "true");
  loadSessions(state.sessionQuery || $("session-search")?.value || "");
  requestAnimationFrame(() => {
    $("session-search")?.focus();
    $("session-search")?.select();
  });
}
function closeDrawer(restoreFocus = false) {
  $("thread-drawer").hidden = true;
  $("drawer-scrim").hidden = true;
  document.querySelector(".shell").inert = false;
  $("btn-threads").setAttribute("aria-expanded", "false");
  if (restoreFocus) {
    const target = state.drawerReturnFocus;
    requestAnimationFrame(() => {
      if (target instanceof HTMLElement && target.isConnected) target.focus();
      else $("btn-threads").focus();
    });
  }
  state.drawerReturnFocus = null;
}

async function initializePageScope() {
  try {
    const currentWindow = await chrome.windows.getCurrent();
    state.windowId = currentWindow?.id ?? null;
  } catch {
    state.windowId = null;
  }
  const page = await collectPage();
  if (page?.windowId != null) state.windowId = page.windowId;
  if (page) await queuePageActivation(page);
  // 旧版全局键会造成跨网页续聊；升级后不再读取，并主动清除。
  chrome.storage.local.remove(["lastSessionId", "lastSessionTitle"]).catch(() => {});
}

$("btn-new").addEventListener("click", newThread);
$("btn-new-thread-drawer").addEventListener("click", newThread);
$("btn-threads").addEventListener("click", () => {
  if ($("thread-drawer").hidden) openDrawer();
  else closeDrawer(true);
});
$("btn-close-threads").addEventListener("click", () => closeDrawer(true));
$("drawer-scrim").addEventListener("click", () => closeDrawer(true));
$("log").addEventListener("scroll", () => {
  state.followOutput = isLogNearBottom();
  updateScrollAffordance();
}, { passive: true });
$("btn-scroll-bottom").addEventListener("click", () => scrollLog(true));

document.addEventListener("keydown", (event) => {
  const drawer = $("thread-drawer");
  if (event.key === "Escape") {
    if (!drawer.hidden) {
      event.preventDefault();
      closeDrawer(true);
      return;
    }
    if (!$("settings-panel").hidden) {
      event.preventDefault();
      closePopovers();
      $("btn-settings").focus();
      return;
    }
    if (!$("attach-menu").hidden) {
      event.preventDefault();
      closePopovers();
      $("btn-attach").focus();
    }
    return;
  }
  if (event.key !== "Tab" || drawer.hidden) return;
  const focusable = [...drawer.querySelectorAll("button:not(:disabled), input:not(:disabled)")];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!drawer.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
// 历史搜索（防抖）
let searchTimer = 0;
$("session-search")?.addEventListener("input", () => {
  const q = $("session-search").value.trim();
  state.sessionQuery = q;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadSessions(q), 220);
});

$("btn-cancel").addEventListener("click", async () => {
  $("btn-cancel").disabled = true;
  $("turn-status").textContent = "正在停止…";
  try {
    await chrome.runtime.sendMessage({ type: "assistant-cancel", requestId: state.requestId });
  } catch (e) {
    appendError(String(e));
    if (state.busy) {
      $("btn-cancel").disabled = false;
      $("turn-status").textContent = "正在生成";
    }
  }
});

$("btn-send").addEventListener("click", async () => {
  const inputEl = $("input");
  const raw = (inputEl?.value || "").trim();
  if (!raw) return;

  // 若上一 turn 卡 busy，先取消再发，避免「输入框文字发不出去」
  if (state.busy) {
    await forceUnlock("re-send");
  }

  let page;
  try {
    page = await collectPage();
    if (!page) throw new Error("无法读取当前标签页");
    await queuePageActivation(page);
    await scopePersistQueue.catch(() => {});
  } catch (e) {
    appendError(String(e));
    return;
  }

  let autoDebugChip = null;
  const hasDebugChip = state.chips.some((chip) => chip.kind === "debug");
  if (isDebugQuestion(raw) && !hasDebugChip) {
    try {
      setMediaStatus("正在自动读取 Network / Console…");
      const prepared = await chrome.runtime.sendMessage({
        type: "debug-capture-prepare",
        tabId: page.tabId,
      });
      if (!prepared?.ok) throw new Error(prepared?.error || "读取调试信息失败");
      autoDebugChip = {
        kind: "debug",
        title: `自动调试快照 ${prepared.status?.networkCount || 0}/${prepared.status?.consoleCount || 0}`,
        text: prepared.snapshot || "",
      };
      if (prepared.reloaded) {
        page = await collectPage(page.tabId);
        if (!page) throw new Error("刷新后无法读取当前标签页");
        await queuePageActivation(page);
        await scopePersistQueue.catch(() => {});
      }
      setMediaStatus("调试信息已读取");
    } catch (error) {
      setMediaStatus("");
      appendError(String(error?.message || error));
      return;
    }
  }

  const turnScope = state.scopeKey;
  if (!turnScope) {
    appendError("当前页面没有可用的隔离作用域。");
    return;
  }

  // 页面作用域确认后再快照 session/chip，禁止沿用上一网页的状态。
  const displayText = stripMentionTokens(raw) || raw;
  const chipsSnapshot = autoDebugChip ? [...state.chips, autoDebugChip] : state.chips.slice();
  const cwd = $("cwd").value.trim();
  const dryRun = !!$("dry-run").checked;
  const attachBody = $("attach-body")?.checked !== false;
  const sessionIdSnapshot =
    dryRun || isDrySessionId(state.sessionId) ? "" : state.sessionId || "";

  closePopovers();
  // 双保险清空
  if (inputEl) {
    inputEl.value = "";
    inputEl.textContent = "";
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  }
  autosizeInput();
  state.chips = [];
  renderChips();
  state.drafts.set(turnScope, { text: "", chips: [] });

  setBusy(true);
  state.assistantEl = null;
  state.thinkingEl = null;
  state.thinkingDetails = null;
  state.assistantRaw = "";
  state.liveThinkingChars = 0;
  state.liveAssistantChars = 0;

  const requestId = `ui-${Date.now()}`;
  state.requestId = requestId;

  // 安全阀：防止请求无响应导致永远卡在「停止」
  const busyWatchdog = setTimeout(() => {
    if (state.busy && state.requestId === requestId) {
      setBusy(false);
      state.requestId = "";
      appendError("响应超时，已解除锁定。可点停止或重试。");
    }
  }, 180000);

  appendUserBubble(displayText);

  // 标题：用用户首句，不依赖已删除的 state.threads
  const titleEl = $("thread-title");
  if (
    titleEl &&
    (!titleEl.textContent ||
      titleEl.textContent === DEFAULT_THREAD_TITLE ||
      titleEl.textContent === "新聊天")
  ) {
    const title = titleFromUserText(displayText);
    titleEl.textContent = title;
    persistScopePatch({ title }, turnScope).catch(() => {});
  }

  // 让浏览器先画出「输入已清空 + 用户气泡」
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  inputEl?.focus();

  // 确保 Port 连着
  if (!state.port) connectSidepanelPort();

  try {
    const browser = packBrowserContext({
      page,
      inputText: raw,
      chips: chipsSnapshot,
      defaultPageText: attachBody,
      includePageText:
        chipsSnapshot.some((c) => c.kind === "pageText") || /@body|@pageText/i.test(raw)
          ? true
          : undefined,
    });

    const payload = {
      requestId,
      pageScope: turnScope,
      sessionId: sessionIdSnapshot,
      cwd,
      apiBase: $("api-base")?.value.trim() || "",
      apiKey: $("api-key")?.value.trim() || "",
      model: $("api-model")?.value.trim() || "",
      text: displayText,
      browser,
      reasoningEffort: "high",
      dryRun,
    };

    const result = await chrome.runtime.sendMessage({ type: "assistant-send", payload });
    if (state.scopeKey !== turnScope || state.requestId !== requestId) return;
    if (result?.sessionId) applySessionId(result.sessionId, turnScope);
    if (result?.error) appendError(result.error);
    else if (result?.ok === false && !result?.error) appendError("请求失败");

    // live 丢事件时，用 batch events 补 thinking/text
    replayEventsIfNeeded(result?.events || []);
  } catch (e) {
    if (state.scopeKey === turnScope && state.requestId === requestId) {
      appendError(String(e?.message || e));
    }
  } finally {
    clearTimeout(busyWatchdog);
    if (autoDebugChip) setMediaStatus("");
    if (state.requestId === requestId) {
      state.requestId = "";
      setBusy(false);
      // 再清一次输入，防止异常路径回写
      if (inputEl && inputEl.value === raw) inputEl.value = "";
      autosizeInput();
      state.assistantEl = null;
      // 保留 thinkingEl 以便用户仍能看到本 turn 思考块；下次 send 会重置
    }
  }
});

// Prefs — 附带正文默认开；dry-run 默认关。迁移时关闭旧版浏览器工具开关。
chrome.storage.local.get([
  "cwd",
  "attachBody",
  "dryRun",
  "apiBase",
  "apiKey",
  "apiModel",
  "selectionChipEnabled",
]).then((data) => {
  if (data.cwd) $("cwd").value = data.cwd;
  if (data.apiBase) $("api-base").value = data.apiBase;
  if (data.apiKey) $("api-key").value = data.apiKey;
  if (data.apiModel) $("api-model").value = data.apiModel;
  $("dry-run").checked = data.dryRun === true;
  if (typeof data.attachBody === "boolean") {
    $("attach-body").checked = data.attachBody;
  } else {
    $("attach-body").checked = false;
  }
  $("selection-chip-enabled").checked = data.selectionChipEnabled !== false;
  chrome.storage.local.set({ browserControl: false }).catch(() => {});
});
function persistPrefs() {
  chrome.storage.local.set({
    cwd: $("cwd").value,
    apiBase: $("api-base")?.value || "",
    apiKey: $("api-key")?.value || "",
    apiModel: $("api-model")?.value || "",
    attachBody: $("attach-body").checked,
    selectionChipEnabled: $("selection-chip-enabled").checked,
    dryRun: $("dry-run").checked,
  });
}
[
  "cwd",
  "dry-run",
  "attach-body",
  "selection-chip-enabled",
  "api-base",
  "api-key",
  "api-model",
].forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener("change", persistPrefs);
});

function currentSiteOrigin() {
  try {
    return new URL(state.lastPage?.url || "").origin;
  } catch {
    return "";
  }
}

async function refreshSelectionSiteButton() {
  const button = $("btn-toggle-selection-site");
  const origin = currentSiteOrigin();
  if (!origin || !/^https?:/i.test(origin)) {
    button.disabled = true;
    button.textContent = "当前页面不支持网站级设置";
    return;
  }
  const data = await chrome.storage.local.get("selectionChipDisabledSites");
  const sites = Array.isArray(data.selectionChipDisabledSites) ? data.selectionChipDisabledSites : [];
  const disabled = sites.includes(origin);
  button.disabled = false;
  button.textContent = disabled ? "在此网站启用划词胶囊" : "在此网站停用划词胶囊";
  button.setAttribute("aria-pressed", String(disabled));
}

$("btn-toggle-selection-site").addEventListener("click", async () => {
  const origin = currentSiteOrigin();
  if (!origin) return;
  const data = await chrome.storage.local.get("selectionChipDisabledSites");
  const sites = new Set(
    Array.isArray(data.selectionChipDisabledSites) ? data.selectionChipDisabledSites : []
  );
  if (sites.has(origin)) sites.delete(origin);
  else sites.add(origin);
  await chrome.storage.local.set({ selectionChipDisabledSites: [...sites] });
  await refreshSelectionSiteButton();
});

// Init
renderChips();
initializePageScope().catch((error) => appendError(String(error)));
autosizeInput();
chrome.runtime
  .sendMessage({ type: "consume-pending-ask" })
  .then((r) => {
    if (r?.ask) return applyPendingAsk(r.ask);
  })
  .catch(() => {});
