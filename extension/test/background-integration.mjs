import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const runtimeMessageListeners = [];
const runtimeConnectListeners = [];
const nativeMessageListeners = [];
const nativeOutbound = [];
const sidepanelOutbound = [];
const quickCardOutbound = [];
const storage = { browserControl: true };
const sessionStorage = {};
const tabActivatedListeners = [];
const tabUpdatedListeners = [];
const tabRemovedListeners = [];
const debuggerEventListeners = [];
const debuggerDetachListeners = [];
const debuggerCommands = [];
let debuggerAttached = false;
const activeTab = {
  id: 11,
  windowId: 3,
  active: true,
  title: "Mock page",
  url: "https://example.test/page",
};
let scriptExecutions = 0;

const eventTarget = () => ({
  addListener(listener) { this.listener = listener; },
  removeListener() {},
});

const nativePort = {
  onMessage: eventTarget(),
  onDisconnect: eventTarget(),
  postMessage(message) { nativeOutbound.push(message); },
};
nativePort.onMessage.addListener = (listener) => nativeMessageListeners.push(listener);

globalThis.chrome = {
  runtime: {
    lastError: undefined,
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener(listener) { runtimeMessageListeners.push(listener); } },
    onConnect: { addListener(listener) { runtimeConnectListeners.push(listener); } },
    connectNative() { return nativePort; },
    sendMessage: async () => undefined,
  },
  sidePanel: {
    setPanelBehavior: async () => undefined,
    open: async () => undefined,
  },
  contextMenus: {
    removeAll(callback) { callback?.(); },
    create() {},
    onClicked: { addListener() {} },
  },
  commands: { onCommand: { addListener() {} } },
  tabs: {
    async query(query) { return query?.active ? [activeTab] : [activeTab]; },
    async get(tabId) { return tabId === activeTab.id ? activeTab : null; },
    async sendMessage() { return { ok: true }; },
    onActivated: { addListener(listener) { tabActivatedListeners.push(listener); } },
    onUpdated: { addListener(listener) { tabUpdatedListeners.push(listener); }, removeListener() {} },
    onRemoved: { addListener(listener) { tabRemovedListeners.push(listener); } },
  },
  scripting: {
    async executeScript() {
      scriptExecutions++;
      return [];
    },
  },
  debugger: {
    async attach(target, version) {
      assert.equal(target.tabId, activeTab.id);
      assert.equal(version, "1.3");
      debuggerAttached = true;
    },
    async detach() { debuggerAttached = false; },
    async sendCommand(target, method) {
      debuggerCommands.push({ target, method });
      if (method === "Network.getResponseBody") {
        return { body: JSON.stringify({ ok: true, access_token: "response-secret" }), base64Encoded: false };
      }
      return {};
    },
    onEvent: { addListener(listener) { debuggerEventListeners.push(listener); } },
    onDetach: { addListener(listener) { debuggerDetachListeners.push(listener); } },
  },
  storage: {
    local: {
      async get(keys) {
        const names = Array.isArray(keys) ? keys : Object.keys(keys || {});
        return Object.fromEntries(names.map((name) => [name, storage[name]]));
      },
      async set(values) { Object.assign(storage, values); },
    },
    session: {
      async get(keys) {
        const names = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(names.map((name) => [name, sessionStorage[name]]));
      },
      async set(values) { Object.assign(sessionStorage, values); },
      async remove(key) { delete sessionStorage[key]; },
    },
  },
};

await import(pathToFileURL(path.join(directory, "..", "background.js")).href);
assert.equal(runtimeMessageListeners.length, 1, "background should register one runtime message handler");
assert.equal(runtimeConnectListeners.length, 1, "background should register one runtime connect handler");

runtimeConnectListeners[0]({
  name: "sidepanel",
  postMessage(message) { sidepanelOutbound.push(message); },
  onDisconnect: { addListener() {} },
});
runtimeConnectListeners[0]({
  name: "quick-card",
  sender: { tab: activeTab },
  postMessage(message) { quickCardOutbound.push(message); },
  onDisconnect: { addListener() {} },
});

const runtimeHandler = runtimeMessageListeners[0];
let resolveHostSend;
const hostSendResponse = new Promise((resolve) => { resolveHostSend = resolve; });
assert.equal(runtimeHandler({
  type: "host-send",
  payload: {
    requestId: "tool-free-turn",
    pageScope: "v1|tab:11|origin:https://example.test",
    text: "think about this page",
    browserControl: true,
    enableBrowserControl: true,
    browser: {
      tabId: 11,
      windowId: 3,
      title: "Mock page",
      url: "https://example.test/page",
      pageText: "Mock page body",
      enableBrowserControl: true,
    },
    mode: "yolo",
    maxTurns: 99,
    alwaysApprove: true,
  },
}, {}, resolveHostSend), true);

await new Promise((resolve) => setTimeout(resolve, 0));

const nativeSend = nativeOutbound.find(
  (message) => message.op === "send" && message.requestId === "tool-free-turn"
);
assert.ok(nativeSend);
assert.equal(nativeSend.model, "");
assert.equal(nativeSend.apiBase, "");
assert.equal(nativeSend.apiKey, "");
assert.equal(nativeSend.reasoningEffort, "high");
assert.equal(nativeSend.mode, "default");
assert.equal(nativeSend.maxTurns, 1);
assert.equal(nativeSend.alwaysApprove, false);
assert.equal(nativeSend.browser.enableBrowserControl, undefined);
assert.equal(storage.browserControl, false);
assert.equal(nativeSend.browser.tabId, 11);

const captureStarted = await new Promise((resolve) => {
  runtimeHandler({ type: "debug-capture-start", tabId: 11 }, {}, resolve);
});
assert.equal(captureStarted.ok, true);
assert.equal(debuggerAttached, true);
assert.ok(debuggerCommands.some((command) => command.method === "Network.enable"));
assert.ok(debuggerCommands.some((command) => command.method === "Runtime.enable"));

for (const listener of debuggerEventListeners) {
  listener({ tabId: 11 }, "Network.requestWillBeSent", {
    requestId: "request-1",
    type: "Fetch",
    request: {
      method: "POST",
      url: "https://example.test/api?token=request-secret",
      postData: JSON.stringify({ query: "hello", password: "body-secret" }),
    },
  });
  listener({ tabId: 11 }, "Network.responseReceived", {
    requestId: "request-1",
    type: "Fetch",
    response: { status: 200, mimeType: "application/json", url: "https://example.test/api" },
  });
  listener({ tabId: 11 }, "Network.loadingFinished", {
    requestId: "request-1",
    encodedDataLength: 120,
  });
  listener({ tabId: 11 }, "Runtime.consoleAPICalled", {
    type: "error",
    args: [{ value: "Authorization: Bearer console-secret" }],
  });
}
await new Promise((resolve) => setTimeout(resolve, 0));
const debugSnapshot = await new Promise((resolve) => {
  runtimeHandler({ type: "debug-capture-snapshot", tabId: 11 }, {}, resolve);
});
assert.equal(debugSnapshot.ok, true);
assert.match(debugSnapshot.snapshot, /POST .*\/api/);
assert.match(debugSnapshot.snapshot, /\"query\":\"hello\"/);
assert.match(debugSnapshot.snapshot, /\[redacted\]/);
assert.equal(debugSnapshot.snapshot.includes("request-secret"), false);
assert.equal(debugSnapshot.snapshot.includes("body-secret"), false);
assert.equal(debugSnapshot.snapshot.includes("response-secret"), false);
assert.equal(debugSnapshot.snapshot.includes("console-secret"), false);

let resolveDebugSend;
const debugSendResponse = new Promise((resolve) => { resolveDebugSend = resolve; });
assert.equal(runtimeHandler({
  type: "host-send",
  payload: {
    requestId: "auto-debug-turn",
    pageScope: "v1|tab:11|origin:https://example.test",
    text: "你可以拿到这页面的接口和数据吗",
    browser: {
      tabId: 11,
      windowId: 3,
      title: "Mock page",
      url: "https://example.test/page",
      mentions: [],
    },
  },
}, {}, resolveDebugSend), true);
await new Promise((resolve) => setTimeout(resolve, 0));
const autoDebugSend = nativeOutbound.find(
  (message) => message.op === "send" && message.requestId === "auto-debug-turn"
);
assert.ok(autoDebugSend);
const autoDebugMention = autoDebugSend.browser.mentions.find(
  (mention) => mention.kind === "debug"
);
assert.ok(autoDebugMention, "active capture should be attached automatically for debug questions");
assert.match(autoDebugMention.text, /Network \(1\)/);
assert.match(autoDebugMention.text, /Console \(1\)/);
emitNative({ op: "send_done", requestId: "auto-debug-turn", ok: true, sessionId: "debug-session" });
assert.equal((await debugSendResponse).ok, true);

tabActivatedListeners[0]({ tabId: activeTab.id, windowId: activeTab.windowId });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.ok(
  sidepanelOutbound.some(
    (message) => message.type === "active-page-changed" && message.page?.tabId === 11
  ),
  "active tab changes should notify the side panel"
);

const outboundBeforeBlockedSend = nativeOutbound.length;
const blockedCrossPageSend = await new Promise((resolve) => {
  runtimeHandler(
    {
      type: "host-send",
      payload: {
        requestId: "wrong-page",
        pageScope: "v1|tab:99|origin:https://other.test",
        text: "do not send",
        browser: {
          tabId: 11,
          windowId: 3,
          url: "https://example.test/page",
        },
      },
    },
    {},
    resolve
  );
});
assert.equal(blockedCrossPageSend.ok, false);
assert.match(blockedCrossPageSend.error, /跨网页|标签页已切换/);
assert.equal(nativeOutbound.length, outboundBeforeBlockedSend);

sessionStorage.pageScopeSessionsV1 = {
  "v1|tab:11|origin:https://example.test": {
    activeSessionId: "bound-session",
    sessionIds: ["bound-session"],
    title: "Bound",
  },
};
const blockedForeignSession = await new Promise((resolve) => {
  runtimeHandler(
    {
      type: "host-send",
      payload: {
        requestId: "foreign-session",
        pageScope: "v1|tab:11|origin:https://example.test",
        sessionId: "session-from-another-page",
        text: "do not resume",
        browser: {
          tabId: 11,
          windowId: 3,
          url: "https://example.test/page",
        },
      },
    },
    {},
    resolve
  );
});
assert.equal(blockedForeignSession.ok, false);
assert.match(blockedForeignSession.error, /不属于当前网页/);
assert.equal(nativeOutbound.length, outboundBeforeBlockedSend);

function emitNative(message) {
  for (const listener of nativeMessageListeners) listener(message);
}

emitNative({
  op: "event",
  requestId: "tool-free-turn",
  event: { type: "thinking", text: "reasoning..." },
});
assert.ok(
  sidepanelOutbound.some(
    (message) => message.type === "host-event" && message.event?.type === "thinking"
  ),
  "thinking event should stream to the side panel"
);

emitNative({
  op: "browser_action",
  requestId: "tool-free-turn",
  callId: "unexpected-tool-call",
  action: "click",
  arguments: { selector: "button" },
});
await new Promise((resolve) => setTimeout(resolve, 0));
const blockedTool = nativeOutbound.find((message) => message.callId === "unexpected-tool-call");
assert.equal(blockedTool.ok, false);
assert.match(blockedTool.error, /tools are disabled/i);
assert.equal(scriptExecutions, 0, "blocked model tool must not touch the page");

emitNative({ op: "send_done", requestId: "tool-free-turn", ok: true, sessionId: "mock-session" });
const completed = await hostSendResponse;
assert.equal(completed.ok, true);
assert.equal(completed.sessionId, "mock-session");

let resolveQuickSend;
const quickSendResponse = new Promise((resolve) => { resolveQuickSend = resolve; });
assert.equal(runtimeHandler({
  type: "quick-card-send",
  requestId: "quick-turn",
  text: "解释它",
  context: { kind: "selection", text: "被引用的句子" },
}, { tab: activeTab }, resolveQuickSend), true);
await new Promise((resolve) => setTimeout(resolve, 0));
const quickNativeSend = nativeOutbound.find(
  (message) => message.op === "send" && message.requestId === "quick-turn"
);
assert.ok(quickNativeSend, "quick card should use the same background-owned host request");
assert.equal(quickNativeSend.browser.pageText, "", "page body must not be attached implicitly");
assert.ok(
  quickNativeSend.browser.mentions.some(
    (mention) => mention.kind === "selection" && mention.text === "被引用的句子"
  )
);
emitNative({
  op: "event",
  requestId: "quick-turn",
  event: { type: "partial", text: "解释结果" },
});
assert.ok(
  quickCardOutbound.some(
    (message) => message.type === "host-event" && message.requestId === "quick-turn"
  ),
  "quick-card port should receive streaming events"
);
emitNative({ op: "send_done", requestId: "quick-turn", ok: true, sessionId: "quick-session" });
const quickCompleted = await quickSendResponse;
assert.equal(quickCompleted.sessionId, "quick-session");
assert.ok(
  quickCardOutbound.some(
    (message) => message.type === "host-done" && message.requestId === "quick-turn"
  ),
  "all views should receive the shared completion event"
);

const nativeBeforeHandoff = nativeOutbound.length;
const expanded = await new Promise((resolve) => {
  runtimeHandler({
    type: "expand-quick-card",
    handoff: {
      sessionId: "quick-session",
      messages: [
        { role: "user", text: "解释它" },
        { role: "assistant", text: "解释结果" },
      ],
      draft: "继续问",
    },
  }, { tab: activeTab }, resolve);
});
assert.equal(expanded.ok, true);
assert.equal(sessionStorage.pendingAsk.kind, "card-handoff");
assert.equal(nativeOutbound.length, nativeBeforeHandoff, "expanding must not resend the prompt");

const captureStopped = await new Promise((resolve) => {
  runtimeHandler({ type: "debug-capture-stop", tabId: 11 }, {}, resolve);
});
assert.equal(captureStopped.ok, true);
assert.equal(debuggerAttached, false);

console.log("ok  - background tool-free reasoning integration");
