/**
 * Background service worker: side panel, page context, and native host bridge.
 * Chat path: native messaging → local host → OpenAI-compatible Chat Completions.
 */

import { localPathHintFromURL } from "./lib/context.js";
import { normalizeHostPingResult } from "./lib/host-bridge.js";
import {
  DEBUG_CONSOLE_LIMIT,
  DEBUG_NETWORK_LIMIT,
  DEBUG_RESPONSE_FETCH_LIMIT,
  consoleArgumentText,
  formatDebugSnapshot,
  isDebugQuestion,
  pushBounded,
  sanitizeText,
  sanitizeUrl,
} from "./lib/debug-capture.js";
import {
  PAGE_SCOPE_STORE_KEY,
  derivePageScope,
  readScopeRecord,
  removeScopesForTab,
  updateScopeRecord,
} from "./lib/page-scope.js";

const NATIVE_HOST = "com.hzy9738.sidechat";
const DEFAULT_MODEL = "";

const PENDING_ASK_KEY = "pendingAsk";
const DEBUG_PROTOCOL_VERSION = "1.3";

/** @type {Map<number, {tabId:number,url:string,startedAt:number,network:any[],console:any[],requests:Map<string, any>}>} */
const debugCaptures = new Map();
const debugStatusTimers = new Map();

function debugTarget(tabId) {
  return { tabId: Number(tabId) };
}

function debugCaptureStatus(tabId) {
  const capture = debugCaptures.get(Number(tabId));
  return {
    active: !!capture,
    tabId: Number(tabId) || null,
    startedAt: capture?.startedAt || null,
    networkCount: capture?.network.length || 0,
    consoleCount: capture?.console.length || 0,
  };
}

function broadcastDebugStatus(tabId) {
  broadcastToSidepanels({
    type: "debug-capture-status",
    status: debugCaptureStatus(tabId),
  }, Number(tabId));
}

function scheduleDebugStatus(tabId) {
  const id = Number(tabId);
  if (debugStatusTimers.has(id)) return;
  debugStatusTimers.set(id, setTimeout(() => {
    debugStatusTimers.delete(id);
    broadcastDebugStatus(id);
  }, 250));
}

function assertDebuggableTab(tab) {
  const url = String(tab?.url || "");
  if (!tab?.id || !/^https?:\/\//i.test(url)) {
    throw new Error("调试采集仅支持 http/https 网页，Chrome 内置页和扩展页无法采集。");
  }
}

async function startDebugCapture(tabId) {
  if (!chrome.debugger) throw new Error("当前浏览器不支持调试采集。");
  const tab = await chrome.tabs.get(Number(tabId));
  assertDebuggableTab(tab);
  if (debugCaptures.has(tab.id)) return { ok: true, status: debugCaptureStatus(tab.id) };

  const target = debugTarget(tab.id);
  await chrome.debugger.attach(target, DEBUG_PROTOCOL_VERSION);
  try {
    await chrome.debugger.sendCommand(target, "Network.enable", {
      maxTotalBufferSize: DEBUG_RESPONSE_FETCH_LIMIT * 2,
      maxResourceBufferSize: DEBUG_RESPONSE_FETCH_LIMIT,
    });
    await chrome.debugger.sendCommand(target, "Runtime.enable");
    await chrome.debugger.sendCommand(target, "Log.enable");
  } catch (error) {
    await chrome.debugger.detach(target).catch(() => {});
    throw error;
  }

  debugCaptures.set(tab.id, {
    tabId: tab.id,
    url: tab.url || "",
    startedAt: Date.now(),
    network: [],
    console: [],
    requests: new Map(),
  });
  broadcastDebugStatus(tab.id);
  return { ok: true, status: debugCaptureStatus(tab.id) };
}

async function stopDebugCapture(tabId) {
  const id = Number(tabId);
  debugCaptures.delete(id);
  const timer = debugStatusTimers.get(id);
  if (timer) clearTimeout(timer);
  debugStatusTimers.delete(id);
  if (chrome.debugger) await chrome.debugger.detach(debugTarget(id)).catch(() => {});
  broadcastDebugStatus(id);
  return { ok: true, status: debugCaptureStatus(id) };
}

function addNetworkEntry(capture, params) {
  const entry = {
    requestId: String(params.requestId || ""),
    method: String(params.request?.method || "GET"),
    url: sanitizeUrl(params.request?.url || ""),
    type: String(params.type || ""),
    requestBody: sanitizeText(params.request?.postData || ""),
    startedAt: Date.now(),
  };
  const removed = capture.network.length >= DEBUG_NETWORK_LIMIT ? capture.network[0] : null;
  pushBounded(capture.network, entry, DEBUG_NETWORK_LIMIT);
  if (removed && capture.requests.get(removed.requestId) === removed) {
    capture.requests.delete(removed.requestId);
  }
  capture.requests.set(entry.requestId, entry);
  return entry;
}

async function captureResponseBody(tabId, capture, entry, encodedDataLength) {
  if (!entry || !/^(xhr|fetch)$/i.test(entry.type || "")) return;
  if (!/(?:json|text|javascript|xml|graphql|form)/i.test(entry.mimeType || "")) return;
  if (Number(encodedDataLength || 0) > DEBUG_RESPONSE_FETCH_LIMIT) {
    entry.bodyNote = `[omitted: response exceeds ${DEBUG_RESPONSE_FETCH_LIMIT / 1024} KB]`;
    return;
  }
  try {
    const result = await chrome.debugger.sendCommand(
      debugTarget(tabId),
      "Network.getResponseBody",
      { requestId: entry.requestId }
    );
    if (result?.base64Encoded) entry.bodyNote = "[omitted: binary/base64 response]";
    else entry.responseBody = sanitizeText(result?.body || "");
  } catch (error) {
    entry.bodyNote = `[body unavailable: ${sanitizeText(error?.message || error, 300)}]`;
  }
  scheduleDebugStatus(tabId);
}

function addConsoleEntry(capture, entry) {
  pushBounded(capture.console, entry, DEBUG_CONSOLE_LIMIT);
}

chrome.debugger?.onEvent?.addListener((source, method, params = {}) => {
  const tabId = Number(source?.tabId);
  const capture = debugCaptures.get(tabId);
  if (!capture) return;

  if (method === "Network.requestWillBeSent") {
    addNetworkEntry(capture, params);
  } else if (method === "Network.responseReceived") {
    const entry = capture.requests.get(String(params.requestId || ""));
    if (entry) {
      entry.status = params.response?.status;
      entry.mimeType = String(params.response?.mimeType || "");
      entry.url = sanitizeUrl(params.response?.url || entry.url);
      entry.type = String(params.type || entry.type || "");
    }
  } else if (method === "Network.loadingFailed") {
    const entry = capture.requests.get(String(params.requestId || ""));
    if (entry) entry.error = sanitizeText(params.errorText || "Request failed", 1_000);
  } else if (method === "Network.loadingFinished") {
    const entry = capture.requests.get(String(params.requestId || ""));
    captureResponseBody(tabId, capture, entry, params.encodedDataLength).catch(() => {});
  } else if (method === "Runtime.consoleAPICalled") {
    addConsoleEntry(capture, {
      level: String(params.type || "log"),
      text: (params.args || []).map(consoleArgumentText).filter(Boolean).join(" "),
      url: params.stackTrace?.callFrames?.[0]?.url || "",
      line: Number(params.stackTrace?.callFrames?.[0]?.lineNumber || 0) + 1,
    });
  } else if (method === "Runtime.exceptionThrown") {
    const details = params.exceptionDetails || {};
    addConsoleEntry(capture, {
      level: "exception",
      text: [details.text, consoleArgumentText(details.exception)].filter(Boolean).join(": "),
      url: details.url || details.stackTrace?.callFrames?.[0]?.url || "",
      line: Number(details.lineNumber || 0) + 1,
    });
  } else if (method === "Log.entryAdded") {
    const entry = params.entry || {};
    addConsoleEntry(capture, {
      level: String(entry.level || "log"),
      text: sanitizeText(entry.text || "", 4_000),
      url: entry.url || "",
      line: Number(entry.lineNumber || 0),
    });
  } else {
    return;
  }
  scheduleDebugStatus(tabId);
});

chrome.debugger?.onDetach?.addListener((source) => {
  const tabId = Number(source?.tabId);
  if (!debugCaptures.has(tabId)) return;
  debugCaptures.delete(tabId);
  broadcastDebugStatus(tabId);
});

function installContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "chint-ask-selection",
      title: "询问选中文字",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: "chint-ask-image",
      title: "询问这张图片",
      contexts: ["image"],
    });
    chrome.contextMenus.create({
      id: "chint-ask-link",
      title: "询问此链接",
      contexts: ["link"],
    });
    chrome.contextMenus.create({
      id: "chint-ask-page",
      title: "询问此页",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: "chint-open-panel",
      title: "打开侧栏",
      contexts: ["all"],
    });
  });
}

// 0.6.3 之前的版本可能保存过旧网关配置，升级时清理一次；此后保留用户设置。
const LEGACY_CONFIG_VERSION = "0.6.3";

function versionBefore(version, boundary) {
  const parse = (v) =>
    String(v || "0")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const a = parse(version);
  const b = parse(boundary);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff < 0;
  }
  return false;
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "update" && versionBefore(details.previousVersion, LEGACY_CONFIG_VERSION)) {
    chrome.storage.local.remove(["apiBase", "apiKey", "apiModel"]).catch(() => {});
  }
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  installContextMenus();
});
chrome.runtime.onStartup?.addListener?.(installContextMenus);

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "open-side-panel") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const opened = await openQuickCard(tab, { kind: "prompt" });
  if (!opened && tab.windowId != null) {
    await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const id = String(info.menuItemId || "");
  if (id === "chint-open-panel") {
    if (tab?.windowId != null) {
      await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
    }
    return;
  }
  if (id === "chint-ask-selection") {
    const context = {
      kind: "selection",
      text: info.selectionText || "",
    };
    if (!(await openQuickCard(tab, context))) {
      await queueAsk({
        ...context,
        tabId: tab?.id,
        windowId: tab?.windowId,
        pageUrl: info.pageUrl || tab?.url || "",
      });
    }
    return;
  }
  if (id === "chint-ask-page") {
    await queueAsk({
      kind: "page",
      text: `请总结并回答关于当前页的问题：${info.pageUrl || tab?.url || ""}`,
      tabId: tab?.id,
      windowId: tab?.windowId,
      pageUrl: info.pageUrl || tab?.url || "",
    });
    return;
  }
  if (id === "chint-ask-link") {
    const context = {
      kind: "link",
      text: info.linkUrl || info.selectionText || "",
      url: info.linkUrl || "",
    };
    if (!(await openQuickCard(tab, context))) {
      await queueAsk({
        ...context,
        tabId: tab?.id,
        windowId: tab?.windowId,
        pageUrl: info.linkUrl || "",
      });
    }
    return;
  }
  if (id === "chint-ask-image") {
    const src = info.srcUrl || "";
    const context = {
      kind: "image",
      image: { src, alt: "" },
    };
    if (!(await openQuickCard(tab, context))) {
      const dataUrl = await fetchImageDataUrl(src).catch(() => "");
      await queueAsk({
        ...context,
        text: "请描述这张图片的主要内容。",
        tabId: tab?.id,
        windowId: tab?.windowId,
        pageUrl: info.pageUrl || tab?.url || "",
        image: { src, dataUrl, alt: "" },
      });
    }
  }
});

async function openQuickCard(tab, context) {
  if (!tab?.id) return false;
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: "open-quick-card",
      context: context || { kind: "prompt" },
    });
    return true;
  } catch {
    return false;
  }
}

/** 先写入 session，再开侧栏，避免面板还没连上就丢消息。 */
async function queueAsk(ask) {
  const payload = { ...ask, createdAt: Date.now() };
  await chrome.storage.session.set({ [PENDING_ASK_KEY]: payload }).catch(() => {});
  if (ask.windowId != null) {
    await chrome.sidePanel.open({ windowId: ask.windowId }).catch(() => {});
  }
  broadcastToSidepanels({ type: "pending-ask", ask: payload });
}

/** 把网页图片转成 data URL，供私有化视觉模型使用；失败则只带原地址。 */
async function fetchImageDataUrl(src) {
  const url = String(src || "").trim();
  if (!url) return "";
  if (url.startsWith("data:image/")) return url;
  if (!/^https?:\/\//i.test(url) && !url.startsWith("blob:")) return "";
  const resp = await fetch(url);
  if (!resp.ok) return "";
  const blob = await resp.blob();
  if (!blob || blob.size < 8 || blob.size > 6 * 1024 * 1024) return "";
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    bin += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  const mime = blob.type && blob.type.startsWith("image/") ? blob.type : "image/png";
  return `data:${mime};base64,${btoa(bin)}`;
}

function pageIdentity(tab) {
  return {
    tabId: tab?.id,
    windowId: tab?.windowId,
    title: tab?.title || "",
    url: tab?.url || "",
  };
}

function notifyActivePage(tab) {
  broadcastToSidepanels({ type: "active-page-changed", page: pageIdentity(tab) });
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  for (const capturedTabId of [...debugCaptures.keys()]) {
    if (capturedTabId !== Number(tabId)) stopDebugCapture(capturedTabId).catch(() => {});
  }
  chrome.tabs.get(tabId).then(notifyActivePage).catch(() => {});
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (tab?.active && changeInfo.url) notifyActivePage(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  debugCaptures.delete(Number(tabId));
  broadcastToSidepanels({ type: "page-tab-removed", tabId });
  chrome.storage.session
    .get(PAGE_SCOPE_STORE_KEY)
    .then((data) =>
      chrome.storage.session.set({
        [PAGE_SCOPE_STORE_KEY]: removeScopesForTab(data[PAGE_SCOPE_STORE_KEY], tabId),
      })
    )
    .catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "list-tabs") {
    chrome.tabs.query({ currentWindow: true }).then((tabs) => {
      sendResponse({
        tabs: tabs.map((t) => ({
          id: t.id,
          title: t.title || "",
          url: t.url || "",
          active: !!t.active,
        })),
      });
    });
    return true;
  }

  if (msg?.type === "get-page-context") {
    collectPageContext(msg.tabId, msg.includeTabs !== false, msg.windowId)
      .then((ctx) => sendResponse({ ok: true, browser: ctx }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg?.type === "debug-capture-status") {
    sendResponse({ ok: true, status: debugCaptureStatus(msg.tabId) });
    return false;
  }

  if (msg?.type === "debug-capture-start") {
    startDebugCapture(msg.tabId)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === "debug-capture-stop") {
    stopDebugCapture(msg.tabId)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === "debug-capture-snapshot") {
    const capture = debugCaptures.get(Number(msg.tabId));
    if (!capture) {
      sendResponse({ ok: false, error: "当前页尚未开始调试采集。" });
    } else {
      sendResponse({
        ok: true,
        status: debugCaptureStatus(msg.tabId),
        snapshot: formatDebugSnapshot(capture),
      });
    }
    return false;
  }

  if (msg?.type === "host-send") {
    const payload = msg.payload || {};
    if (payload.sessionId && payload.requestId) {
      broadcastToSidepanels({
        type: "conversation-turn",
        requestId: payload.requestId,
        sessionId: payload.sessionId,
        text: payload.text || "",
      }, payload.browser?.tabId);
    }
    hostSend(payload)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg?.type === "quick-card-send") {
    sendQuickCardTurn(msg, sender)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg?.type === "expand-quick-card") {
    expandQuickCard(msg, sender)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg?.type === "host-cancel") {
    hostCancel(msg.requestId)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg?.type === "host-ping") {
    hostPing()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg?.type === "transcribe-audio") {
    hostRpc(
      "transcribe_audio",
      {
        mediaData: msg.mediaData || "",
        mimeType: msg.mimeType || "audio/webm",
        fileName: msg.fileName || "recording.webm",
        apiBase: msg.apiBase || "",
        apiKey: msg.apiKey || "",
      },
      120000
    )
      .then((result) => sendResponse({ ok: true, text: result.text || "" }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg?.type === "extract-pdf") {
    hostRpc("extract_pdf", { mediaData: msg.mediaData || "" }, 30000)
      .then((result) => sendResponse({ ok: true, text: result.text || "" }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg?.type === "list-sessions") {
    hostListSessions(msg.query || "", msg.limit || 40)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err), sessions: [] }));
    return true;
  }

  if (msg?.type === "open-panel") {
    const windowId = sender.tab?.windowId;
    if (windowId != null) {
      chrome.sidePanel.open({ windowId }).then(() => sendResponse({ ok: true })).catch((err) => {
        sendResponse({ ok: false, error: String(err) });
      });
    } else {
      sendResponse({ ok: false, error: "no window" });
    }
    return true;
  }

  if (msg?.type === "ask-from-page") {
    Promise.resolve()
      .then(async () => {
        let tabInfo = sender.tab || null;
        if (msg.tabId != null) {
          tabInfo = await chrome.tabs.get(msg.tabId).catch(() => tabInfo);
        }
        if (!tabInfo) {
          const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
          tabInfo = active;
        }
        const kind = msg.kind || "selection";
        if (kind === "open") {
          if (tabInfo?.windowId != null) {
            await chrome.sidePanel.open({ windowId: tabInfo.windowId }).catch(() => {});
          }
          sendResponse({ ok: true });
          return;
        }
        let image = msg.image || null;
        if (kind === "image") {
          const src = image?.src || msg.imageSrc || "";
          const dataUrl = image?.dataUrl || (await fetchImageDataUrl(src).catch(() => ""));
          image = { src, dataUrl, alt: image?.alt || "" };
        }
        let text = msg.text || "";
        if (kind === "page" && !text) {
          text = `请总结并回答关于当前页的问题：${msg.pageUrl || tabInfo?.url || ""}`;
        }
        if (kind === "image" && !text) {
          text = "这张图是什么？请结合当前页说明。";
        }
        await queueAsk({
          kind,
          text,
          tabId: tabInfo?.id,
          windowId: tabInfo?.windowId,
          pageUrl: msg.pageUrl || tabInfo?.url || "",
          image,
        });
        sendResponse({ ok: true });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg?.type === "consume-pending-ask") {
    chrome.storage.session
      .get(PENDING_ASK_KEY)
      .then((data) => {
        const ask = data[PENDING_ASK_KEY] || null;
        if (ask?.kind === "card-handoff" && ask.requestId && pending.has(ask.requestId)) {
          ask.events = pending.get(ask.requestId).events.slice();
          ask.busy = true;
        }
        if (ask) chrome.storage.session.remove(PENDING_ASK_KEY).catch(() => {});
        sendResponse({ ok: true, ask });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err), ask: null }));
    return true;
  }

  if (msg?.type === "get-session") {
    hostGetSession(msg.sessionId || "", msg.limit || 80)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err), messages: [] }));
    return true;
  }

  return false;
});

async function sendQuickCardTurn(msg, sender) {
  const tab = sender.tab;
  if (!tab?.id || tab.windowId == null) throw new Error("无法识别当前网页");
  const text = String(msg.text || "").trim();
  if (!text) throw new Error("请输入问题");

  const context = msg.context && typeof msg.context === "object" ? msg.context : null;
  let image = context?.kind === "image" ? context.image || null : null;
  if (image?.src && !image.dataUrl) {
    image = { ...image, dataUrl: await fetchImageDataUrl(image.src).catch(() => "") };
  }

  const pageScope = derivePageScope(tab.id, tab.url || "");
  const browser = {
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title || "",
    url: tab.url || "",
    selection: context?.kind === "selection" ? String(context.text || "") : "",
    pageText: "",
    includeTabs: false,
    tabs: [],
    mentions: [],
    images: [],
    localPathHint: localPathHintFromURL(tab.url || ""),
  };
  if (context?.kind === "selection" && context.text) {
    browser.mentions.push({ kind: "selection", text: String(context.text) });
  } else if (context?.kind === "image" && image) {
    browser.mentions.push({ kind: "image", alt: String(image.alt || "选中图片") });
    browser.images.push({
      src: String(image.src || ""),
      dataUrl: String(image.dataUrl || ""),
      alt: String(image.alt || ""),
    });
  } else if (context?.kind === "link" && context.url) {
    browser.mentions.push({ kind: "page", title: "链接", url: String(context.url) });
  } else if (context?.kind === "page") {
    browser.mentions.push({ kind: "page", title: tab.title || "当前页", url: tab.url || "" });
    if (context.pageText) {
      browser.pageText = String(context.pageText).slice(0, 20000);
      browser.mentions.push({ kind: "pageText", text: browser.pageText });
    }
  }

  const prefs = await chrome.storage.local.get(["cwd", "apiBase", "apiKey", "apiModel"]);
  const requestId = String(msg.requestId || `card-${Date.now()}`);
  const payload = {
    requestId,
    pageScope,
    sessionId: String(msg.sessionId || ""),
    cwd: prefs.cwd || "",
    apiBase: prefs.apiBase || "",
    apiKey: prefs.apiKey || "",
    model: prefs.apiModel || "",
    text,
    browser,
    reasoningEffort: "high",
    dryRun: false,
  };
  const result = await hostSend(payload);
  if (result?.sessionId) await bindSessionToScope(pageScope, result.sessionId);
  return result;
}

async function bindSessionToScope(scopeKey, sessionId) {
  if (!scopeKey || !sessionId) return;
  const data = await chrome.storage.session.get(PAGE_SCOPE_STORE_KEY);
  const next = updateScopeRecord(data[PAGE_SCOPE_STORE_KEY], scopeKey, {
    activeSessionId: sessionId,
  });
  await chrome.storage.session.set({ [PAGE_SCOPE_STORE_KEY]: next });
}

async function expandQuickCard(msg, sender) {
  const tab = sender.tab;
  if (!tab?.id || tab.windowId == null) throw new Error("无法打开侧栏");
  const handoff = {
    ...(msg.handoff && typeof msg.handoff === "object" ? msg.handoff : {}),
    kind: "card-handoff",
    tabId: tab.id,
    windowId: tab.windowId,
    pageUrl: tab.url || "",
    createdAt: Date.now(),
  };
  await chrome.storage.session.set({ [PENDING_ASK_KEY]: handoff });
  await chrome.sidePanel.open({ windowId: tab.windowId });
  broadcastToSidepanels({ type: "pending-ask", ask: handoff });
  return { ok: true };
}

async function collectPageContext(tabId, includeTabs, windowId) {
  let tab;
  if (tabId != null) {
    tab = await chrome.tabs.get(tabId);
  } else {
    const query = windowId != null ? { active: true, windowId } : { active: true, currentWindow: true };
    const [active] = await chrome.tabs.query(query);
    tab = active;
  }

  const browser = {
    tabId: tab?.id,
    windowId: tab?.windowId,
    title: tab?.title || "",
    url: tab?.url || "",
    selection: "",
    pageText: "",
    includeTabs: !!includeTabs,
    tabs: [],
    localPathHint: localPathHintFromURL(tab?.url || ""),
  };

  if (includeTabs) {
    const tabs = await chrome.tabs.query(
      tab?.windowId != null ? { windowId: tab.windowId } : { currentWindow: true }
    );
    browser.tabs = tabs.map((t) => ({
      id: t.id,
      title: t.title || "",
      url: t.url || "",
    }));
  }

  if (tab?.id != null) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractPagePayload,
      });
      if (result) {
        browser.selection = result.selection || "";
        browser.pageText = result.pageText || "";
        if (!browser.title && result.title) browser.title = result.title;
      }
    } catch {
      // Restricted pages (chrome:// etc.)
    }
  }

  return browser;
}

/** Injected into the page — keep self-contained. */
function extractPagePayload() {
  const selection = String(window.getSelection?.()?.toString?.() || "").trim();
  const title = document.title || "";
  const root =
    document.querySelector("article") ||
    document.querySelector("main") ||
    document.body;
  let pageText = "";
  if (root) {
    pageText = (root.innerText || root.textContent || "")
      .replace(/\s+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, 20000);
  }

  return { title, selection, pageText };
}

// ---------- Native host ----------

/** @type {chrome.runtime.Port|null} */
let nativePort = null;
/** Last connectNative / disconnect error (e.g. host not found). */
let lastNativeError = "";
/** @type {Map<string, {events: any[], resolve: Function, reject: Function, done?: boolean}>} */
const pending = new Map();
/** One-shot RPC waiters for list_sessions / get_session / etc. */
/** @type {Map<string, {resolve: Function, reject: Function, op: string}>} */
const rpcPending = new Map();
/** @type {Set<(err: string) => void>} */
const disconnectWaiters = new Set();
/** Side panel long-lived ports for reliable stream delivery (sendMessage can drop). */
/** @type {Set<chrome.runtime.Port>} */
const sidepanelPorts = new Set();
/** @type {Map<chrome.runtime.Port, number>} */
const quickCardPorts = new Map();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "sidepanel") {
    sidepanelPorts.add(port);
    port.onDisconnect.addListener(() => {
      sidepanelPorts.delete(port);
      if (sidepanelPorts.size === 0) {
        for (const tabId of [...debugCaptures.keys()]) stopDebugCapture(tabId).catch(() => {});
      }
    });
    return;
  }
  if (port.name === "quick-card" && port.sender?.tab?.id != null) {
    quickCardPorts.set(port, port.sender.tab.id);
    port.onDisconnect.addListener(() => {
      quickCardPorts.delete(port);
    });
  }
});

/**
 * Push event to open side panels.
 * Prefer Port only when connected — do NOT also sendMessage (that double-renders
 * every thinking/text delta as "TheThe user user…").
 */
function broadcastToSidepanels(message, tabId = null) {
  let delivered = 0;
  for (const port of [...sidepanelPorts]) {
    try {
      port.postMessage(message);
      delivered++;
    } catch {
      sidepanelPorts.delete(port);
    }
  }
  for (const [port, portTabId] of [...quickCardPorts]) {
    if (tabId != null && Number(portTabId) !== Number(tabId)) continue;
    try {
      port.postMessage(message);
      delivered++;
    } catch {
      quickCardPorts.delete(port);
    }
  }
  // Fallback only when no live Port (e.g. side panel not yet connected).
  if (delivered === 0) {
    chrome.runtime.sendMessage(message).catch(() => {});
  }
}

async function handleHostBrowserAction(message) {
  const response = {
    ok: false,
    action: message.action || "action",
    error: "model tools are disabled",
  };

  try {
    ensureNativePort().postMessage({
      op: "browser_result",
      requestId: message.requestId || "",
      callId: message.callId || "",
      ok: !!response.ok,
      result: response,
      error: response.error || "",
    });
  } catch {
    // The host process owns cancellation/disconnect handling.
  }
}

function ensureNativePort() {
  if (nativePort) return nativePort;
  lastNativeError = "";
  nativePort = chrome.runtime.connectNative(NATIVE_HOST);
  // connectNative 失败时 lastError 往往在同步后立刻可读
  const connectErr = chrome.runtime.lastError?.message;
  if (connectErr) {
    lastNativeError = connectErr;
    nativePort = null;
    throw new Error(connectErr);
  }

  nativePort.onMessage.addListener((msg) => {
    const reqId = msg.requestId || msg.request_id;
    if (msg.op === "hello" || msg.op === "pong") {
      broadcastToSidepanels({ type: "host-status", msg });
    }
    if (msg.op === "browser_action" && reqId && msg.callId) {
      handleHostBrowserAction(msg).catch(() => {});
      return;
    }
    // One-shot RPC responses.
    if (reqId && rpcPending.has(reqId)) {
      const r = rpcPending.get(reqId);
      if (msg.op !== r.op && msg.op !== "error") return;
      rpcPending.delete(reqId);
      if (msg.op === "error" || msg.ok === false) {
        r.reject(new Error(msg.error || "host rpc error"));
      } else {
        r.resolve(msg);
      }
      return;
    }
    if (msg.op === "event" && reqId && pending.has(reqId)) {
      const p = pending.get(reqId);
      p.events.push(msg.event);
      broadcastToSidepanels({
        type: "host-event",
        requestId: reqId,
        event: msg.event,
        sessionId: msg.sessionId,
      }, p.tabId);
    }
    if (msg.op === "send_done" && reqId && pending.has(reqId)) {
      const p = pending.get(reqId);
      p.done = true;
      const result = {
        ok: !!msg.ok,
        error: msg.error,
        sessionId: msg.sessionId,
        argv: msg.argv,
        prompt: msg.prompt,
        events: p.events,
        info: msg.info,
      };
      broadcastToSidepanels({
        type: "host-done",
        requestId: reqId,
        ...result,
      }, p.tabId);
      p.resolve(result);
      pending.delete(reqId);
    }
    if (msg.op === "cancelled" && reqId) {
      const p = pending.get(reqId);
      broadcastToSidepanels({ type: "host-cancelled", requestId: reqId }, p?.tabId);
    }
    if (msg.op === "error" && reqId && pending.has(reqId)) {
      const p = pending.get(reqId);
      const error = msg.error || "host error";
      broadcastToSidepanels({
        type: "host-done",
        requestId: reqId,
        ok: false,
        error,
        events: p.events,
      }, p.tabId);
      p.reject(new Error(error));
      pending.delete(reqId);
    }
  });
  nativePort.onDisconnect.addListener(() => {
    const err =
      chrome.runtime.lastError?.message || lastNativeError || "native host disconnected";
    lastNativeError = err;
    for (const [id, p] of pending) {
      broadcastToSidepanels({
        type: "host-done",
        requestId: id,
        ok: false,
        error: err,
        events: p.events,
      }, p.tabId);
      p.reject(new Error(err));
      pending.delete(id);
    }
    for (const [id, p] of rpcPending) {
      p.reject(new Error(err));
      rpcPending.delete(id);
    }
    for (const w of disconnectWaiters) {
      try {
        w(err);
      } catch {
        /* ignore */
      }
    }
    disconnectWaiters.clear();
    nativePort = null;
  });
  return nativePort;
}

/**
 * 通用 request/response RPC（list_sessions / get_session）。
 * @param {string} op
 * @param {object} fields
 * @param {number} [timeoutMs]
 */
function hostRpc(op, fields = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = ensureNativePort();
    } catch (e) {
      reject(e);
      return;
    }
    const requestId = `${op}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const timer = setTimeout(() => {
      if (rpcPending.has(requestId)) {
        rpcPending.delete(requestId);
        reject(new Error(`${op} timed out`));
      }
    }, timeoutMs);
    rpcPending.set(requestId, {
      op,
      resolve: (msg) => {
        clearTimeout(timer);
        resolve(msg);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    try {
      port.postMessage({ op, requestId, ...fields });
    } catch (e) {
      clearTimeout(timer);
      rpcPending.delete(requestId);
      reject(e);
    }
  });
}

function hostListSessions(query, limit) {
  return hostRpc("list_sessions", { query: query || "", limit: limit || 40 }).then((msg) => ({
    ok: !!msg.ok,
    sessions: Array.isArray(msg.sessions) ? msg.sessions : [],
    error: msg.error,
  }));
}

function hostGetSession(sessionId, limit) {
  return hostRpc("get_session", { sessionId: sessionId || "", limit: limit || 80 }).then((msg) => ({
    ok: !!msg.ok,
    sessionId: msg.sessionId || sessionId,
    session: msg.session || null,
    messages: Array.isArray(msg.messages) ? msg.messages : [],
    error: msg.error,
  }));
}

function hostPing() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (info) => {
      if (settled) return;
      settled = true;
      resolve(normalizeHostPingResult(info));
    };

    let port;
    try {
      port = ensureNativePort();
    } catch (e) {
      finish({ lastError: String(e?.message || e), disconnected: true });
      return;
    }

    // 若 connect 后立刻断开（host not found），Chrome 异步触发 onDisconnect
    const onDisconnectWait = (err) => {
      finish({ lastError: err || lastNativeError, disconnected: true });
    };
    disconnectWaiters.add(onDisconnectWait);

    const requestId = `ping-${Date.now()}`;
    const onMsg = (msg) => {
      if (msg.op === "pong" || msg.op === "hello") {
        port.onMessage.removeListener(onMsg);
        disconnectWaiters.delete(onDisconnectWait);
        finish({ version: msg.version, msg });
      }
    };
    port.onMessage.addListener(onMsg);

    try {
      port.postMessage({ op: "ping", requestId });
    } catch (e) {
      port.onMessage.removeListener(onMsg);
      disconnectWaiters.delete(onDisconnectWait);
      finish({ lastError: String(e?.message || e), disconnected: true });
      return;
    }

    // 超时不得 ok:true — host 缺失时用户会看到 not found
    setTimeout(() => {
      port.onMessage.removeListener(onMsg);
      disconnectWaiters.delete(onDisconnectWait);
      if (settled) return;
      const err = lastNativeError || chrome.runtime.lastError?.message || "";
      if (err) {
        finish({ lastError: err, disconnected: true, timedOut: true });
      } else {
        finish({ timedOut: true });
      }
    }, 1500);
  });
}

async function hostSend(payload) {
  const browser = payload?.browser || {};
  const query =
    browser.windowId != null
      ? { active: true, windowId: browser.windowId }
      : { active: true, currentWindow: true };
  const [activeTab] = await chrome.tabs.query(query);
  const activeScope = derivePageScope(activeTab?.id, activeTab?.url || "");
  if (!payload?.pageScope || payload.pageScope !== activeScope) {
    throw new Error("当前标签页已切换，已阻止跨网页续聊；请重新发送。");
  }
  if (Number(browser.tabId) !== Number(activeTab?.id) || browser.url !== (activeTab?.url || "")) {
    throw new Error("当前页面已发生导航，已阻止发送旧页面内容；请重新发送。");
  }
  const scopeData = await chrome.storage.session.get(PAGE_SCOPE_STORE_KEY);
  const scopeRecord = readScopeRecord(scopeData[PAGE_SCOPE_STORE_KEY], payload.pageScope);
  if (payload.sessionId && !scopeRecord.sessionIds.includes(payload.sessionId)) {
    throw new Error("该会话不属于当前网页，已阻止跨网页续聊。");
  }

  return new Promise((resolve, reject) => {
    try {
      const port = ensureNativePort();
      const requestId = payload.requestId || `send-${Date.now()}`;
      const { enableBrowserControl: _ignoredBrowserControl, ...safeBrowser } = browser;
      const existingMentions = Array.isArray(safeBrowser.mentions)
        ? safeBrowser.mentions.slice()
        : [];
      const hasDebugSnapshot = existingMentions.some((mention) => mention?.kind === "debug");
      const capture = debugCaptures.get(Number(browser.tabId));
      if (capture && !hasDebugSnapshot && isDebugQuestion(payload.text || "")) {
        existingMentions.push({
          kind: "debug",
          title: `自动附加调试快照（${capture.network.length} 个请求，${capture.console.length} 条控制台信息）`,
          text: formatDebugSnapshot(capture),
        });
        safeBrowser.mentions = existingMentions;
      }
      pending.set(requestId, {
        events: [],
        resolve,
        reject,
        tabId: browser.tabId,
      });
      chrome.storage.local.set({ browserControl: false }).catch(() => {});
      port.postMessage({
        op: "send",
        requestId,
        sessionId: payload.sessionId || "",
        cwd: payload.cwd || "",
        text: payload.text || "",
        browser: safeBrowser,
        model: payload.model || DEFAULT_MODEL,
        apiBase: payload.apiBase || "",
        apiKey: payload.apiKey || "",
        mode: "default",
        reasoningEffort: payload.reasoningEffort || "high",
        maxTurns: 1,
        alwaysApprove: false,
        dryRun: !!payload.dryRun,
      });
    } catch (e) {
      reject(e);
    }
  });
}

function hostCancel(requestId) {
  return new Promise((resolve, reject) => {
    try {
      const port = ensureNativePort();
      port.postMessage({ op: "cancel", requestId: requestId || "" });
      resolve({ ok: true });
    } catch (e) {
      reject(e);
    }
  });
}
