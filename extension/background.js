/**
 * Background service worker: side panel, page context, and direct API client.
 * Chat path: extension service worker → OpenAI-compatible Chat Completions.
 */

import { localPathHintFromURL } from "./lib/context.js";
import {
  buildChatMessages,
  resolveApiConfig,
  streamChat,
  transcribeAudio,
} from "./lib/api-client.js";
import { createSessionRepository } from "./lib/browser-sessions.js";
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

const PENDING_ASK_KEY = "pendingAsk";
const DEBUG_PROTOCOL_VERSION = "1.3";

/** @type {Map<number, {tabId:number,url:string,startedAt:number,lastEventAt:number,network:any[],console:any[],requests:Map<string, any>}>} */
const debugCaptures = new Map();
const debugStatusTimers = new Map();
const sessionRepository = createSessionRepository(chrome.storage.local);

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
    lastEventAt: Date.now(),
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

function reloadTabAndWait(tabId, timeoutMs = 12_000) {
  const id = Number(tabId);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(result);
    };
    const onUpdated = (updatedTabId, changeInfo) => {
      if (Number(updatedTabId) === id && changeInfo.status === "complete") {
        finish({ complete: true });
      }
    };
    const timer = setTimeout(() => finish({ complete: false, timedOut: true }), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    Promise.resolve(chrome.tabs.reload(id)).catch((error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(error);
    });
  });
}

async function waitForDebugQuiet(tabId, timeoutMs = 5_000, quietMs = 700) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const capture = debugCaptures.get(Number(tabId));
    if (!capture) return;
    const hasEvents = capture.network.length > 0 || capture.console.length > 0;
    if (hasEvents && Date.now() - capture.lastEventAt >= quietMs) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function prepareDebugSnapshot(tabId) {
  const id = Number(tabId);
  let reloaded = false;
  try {
    if (!debugCaptures.has(id)) await startDebugCapture(id);
    const capture = debugCaptures.get(id);
    if (!capture) throw new Error("调试采集没有成功启动。");
    if (capture.network.length === 0 && capture.console.length === 0) {
      reloaded = true;
      await reloadTabAndWait(id);
    }
    await waitForDebugQuiet(id);
    const current = debugCaptures.get(id);
    if (!current) throw new Error("调试采集意外中断。");
    const status = debugCaptureStatus(id);
    const snapshot = formatDebugSnapshot(current);
    await stopDebugCapture(id);
    return { ok: true, reloaded, status, snapshot };
  } catch (error) {
    await stopDebugCapture(id).catch(() => {});
    throw error;
  }
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
  capture.lastEventAt = Date.now();

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

  if (msg?.type === "debug-capture-prepare") {
    prepareDebugSnapshot(msg.tabId)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
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

  if (msg?.type === "assistant-send") {
    const payload = msg.payload || {};
    if (payload.sessionId && payload.requestId) {
      broadcastToSidepanels({
        type: "conversation-turn",
        requestId: payload.requestId,
        sessionId: payload.sessionId,
        text: payload.text || "",
      }, payload.browser?.tabId);
    }
    sendAssistant(payload)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg?.type === "quick-card-send") {
    sendQuickCardTurn(msg, sender)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === "expand-quick-card") {
    expandQuickCard(msg, sender)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg?.type === "assistant-cancel") {
    cancelAssistant(msg.requestId)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg?.type === "transcribe-audio") {
    transcribeFromMessage(msg)
      .then((text) => sendResponse({ ok: true, text }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg?.type === "list-sessions") {
    sessionRepository.list(msg.query || "", msg.limit || 40)
      .then((sessions) => sendResponse({ ok: true, sessions }))
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
    sessionRepository.get(msg.sessionId || "", msg.limit || 80)
      .then((result) => sendResponse({
        ok: true,
        sessionId: result.info.id,
        session: result.info,
        messages: result.messages,
      }))
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

  const prefs = await chrome.storage.local.get(["cwd", "apiBase", "apiKey", "apiModel", "visionModel"]);
  const requestId = String(msg.requestId || `card-${Date.now()}`);
  const payload = {
    requestId,
    pageScope,
    sessionId: String(msg.sessionId || ""),
    cwd: prefs.cwd || "",
    apiBase: prefs.apiBase || "",
    apiKey: prefs.apiKey || "",
    model: prefs.apiModel || "",
    visionModel: prefs.visionModel || "",
    text,
    browser,
    reasoningEffort: "high",
    dryRun: false,
  };
  const result = await sendAssistant(payload);
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
// ---------- Direct API client ----------

/** @type {Map<string, {events:any[], tabId:number, controller:AbortController, cancelled?:boolean}>} */
const pending = new Map();
/** Side panel long-lived ports for reliable stream delivery. */
const sidepanelPorts = new Set();
/** @type {Map<chrome.runtime.Port, number>} */
const quickCardPorts = new Map();
let bundledConfigPromise = null;

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
 * Push an event to open side panels and quick cards.
 * Prefer Port when connected; the runtime fallback avoids duplicate deltas.
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
  if (delivered === 0) chrome.runtime.sendMessage(message).catch(() => {});
}

function loadBundledConfig() {
  if (!bundledConfigPromise) {
    bundledConfigPromise = fetch(chrome.runtime.getURL("runtime-config.json"))
      .then((response) => (response.ok ? response.json() : {}))
      .catch(() => ({}));
  }
  return bundledConfigPromise;
}

async function loadApiConfig(payload = {}, hasImages = false) {
  const [stored, bundled] = await Promise.all([
    chrome.storage.local.get(["apiBase", "apiKey", "apiModel", "visionModel"]),
    loadBundledConfig(),
  ]);
  return resolveApiConfig(payload, stored, bundled, hasImages);
}

function createSessionId() {
  const random = globalThis.crypto?.randomUUID?.().slice(0, 8) || Math.random().toString(16).slice(2, 10);
  return `sc-${Date.now()}-${random}`;
}

function emitAssistantEvent(requestId, event, sessionId, tabId) {
  const request = pending.get(requestId);
  if (!request) return;
  request.events.push(event);
  broadcastToSidepanels({
    type: "assistant-event",
    requestId,
    event,
    sessionId,
  }, tabId);
}

async function validatePageScope(payload) {
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
}

async function sendAssistant(payload) {
  await validatePageScope(payload);
  const browser = payload?.browser || {};
  const requestId = String(payload.requestId || `send-${Date.now()}`);
  const sessionId = payload.dryRun
    ? `dry-session-${Date.now()}`
    : String(payload.sessionId || "").trim() || createSessionId();
  const { enableBrowserControl: _ignoredBrowserControl, ...safeBrowser } = browser;
  const existingMentions = Array.isArray(safeBrowser.mentions)
    ? safeBrowser.mentions.slice()
    : [];
  const hasDebugSnapshot = existingMentions.some((mention) => mention?.kind === "debug");
  if (!hasDebugSnapshot && isDebugQuestion(payload.text || "")) {
    const prepared = await prepareDebugSnapshot(browser.tabId);
    existingMentions.push({
      kind: "debug",
      title: `自动附加调试快照（${prepared.status.networkCount} 个请求，${prepared.status.consoleCount} 条控制台信息）`,
      text: prepared.snapshot,
    });
    safeBrowser.mentions = existingMentions;
  }

  const controller = new AbortController();
  pending.set(requestId, {
    events: [],
    tabId: Number(browser.tabId),
    controller,
    cancelled: false,
  });
  emitAssistantEvent(requestId, { type: "session", sessionId }, sessionId, browser.tabId);

  if (payload.dryRun) {
    emitAssistantEvent(requestId, { type: "text", text: "dry-run ok" }, sessionId, browser.tabId);
    const events = pending.get(requestId)?.events.slice() || [];
    const result = { ok: true, sessionId, events };
    broadcastToSidepanels({ type: "assistant-done", requestId, ...result }, browser.tabId);
    pending.delete(requestId);
    return result;
  }

  const hasImages = Array.isArray(safeBrowser.images) && safeBrowser.images.length > 0;
  const [config, history] = await Promise.all([
    loadApiConfig(payload, hasImages),
    sessionRepository.history(payload.sessionId || ""),
  ]);
  const messages = buildChatMessages(safeBrowser, payload.text || "", history);
  let assistant = "";
  let thinking = "";

  try {
    const result = await streamChat({
      config,
      messages,
      signal: controller.signal,
      onDelta(type, text) {
        if (!text) return;
        if (type === "thinking") thinking += text;
        else assistant += text;
        emitAssistantEvent(
          requestId,
          type === "thinking"
            ? { type: "thinking", text }
            : { type: "partial", rawType: "assistant", text },
          sessionId,
          browser.tabId
        );
      },
    });
    assistant = result.assistant;
    thinking = result.thinking;
    await sessionRepository.appendTurn(sessionId, {
      cwd: payload.cwd || "",
      model: config.model,
      user: payload.text || "",
      assistant,
      thinking,
    });
    const events = pending.get(requestId)?.events.slice() || [];
    const response = { ok: true, sessionId, events };
    broadcastToSidepanels({ type: "assistant-done", requestId, ...response }, browser.tabId);
    return response;
  } catch (error) {
    if (error?.name === "AbortError" || controller.signal.aborted) {
      const request = pending.get(requestId);
      if (assistant || thinking) {
        await sessionRepository.appendTurn(sessionId, {
          cwd: payload.cwd || "",
          model: config.model,
          user: payload.text || "",
          assistant,
          thinking,
        }).catch(() => {});
      }
      if (!request?.cancelled) {
        broadcastToSidepanels({ type: "assistant-cancelled", requestId }, browser.tabId);
      }
      return {
        ok: false,
        cancelled: true,
        sessionId,
        events: request?.events.slice() || [],
      };
    }
    const message = String(error?.message || error);
    const events = pending.get(requestId)?.events.slice() || [];
    const response = { ok: false, error: message, sessionId, events };
    broadcastToSidepanels({ type: "assistant-done", requestId, ...response }, browser.tabId);
    return response;
  } finally {
    pending.delete(requestId);
  }
}

async function cancelAssistant(requestId) {
  const request = pending.get(String(requestId || ""));
  if (!request) return { ok: true, active: false };
  request.cancelled = true;
  request.controller.abort();
  broadcastToSidepanels({
    type: "assistant-cancelled",
    requestId: String(requestId || ""),
  }, request.tabId);
  return { ok: true, active: true };
}

async function transcribeFromMessage(message) {
  const config = await loadApiConfig({
    apiBase: message.apiBase || "",
    apiKey: message.apiKey || "",
  });
  return transcribeAudio({
    config,
    dataUrl: message.mediaData || "",
    mimeType: message.mimeType || "audio/webm",
    fileName: message.fileName || "recording.webm",
  });
}
