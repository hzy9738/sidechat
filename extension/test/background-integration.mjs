import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const runtimeMessageListeners = [];
const runtimeConnectListeners = [];
const sidepanelOutbound = [];
const quickCardOutbound = [];
const storage = {};
const sessionStorage = {};
const tabActivatedListeners = [];
const tabUpdatedListeners = [];
const debuggerEventListeners = [];
const debuggerCommands = [];
const fetchCalls = [];
let debuggerAttached = false;
let reloadCalls = 0;

const activeTab = {
  id: 11,
  windowId: 3,
  active: true,
  title: "Mock page",
  url: "https://example.test/page",
};

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.endsWith("/runtime-config.json")) {
    return new Response(JSON.stringify({
      apiBase: "https://model.example/v1",
      apiKey: "bundled-key",
      model: "deepseek-v4",
      visionModel: "qwen-vl",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.startsWith("data:audio/")) {
    return new Response(new Blob(["audio-bytes"], { type: "audio/webm" }), { status: 200 });
  }
  fetchCalls.push({ url, init });
  if (url.endsWith("/audio/transcriptions")) {
    return new Response(JSON.stringify({ text: "转写结果" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  const body = JSON.parse(String(init.body || "{}"));
  const prompt = body.messages?.at(-1)?.content;
  const userText = Array.isArray(prompt) ? prompt[0]?.text : prompt;
  const answer = String(userText || "").includes("解释") ? "解释结果" : "回答内容";
  const stream = [
    'data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}',
    `data: {"choices":[{"delta":{"content":"${answer}"}}]}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
};

const eventTarget = () => ({
  addListener(listener) { this.listener = listener; },
  removeListener() {},
});

globalThis.chrome = {
  runtime: {
    lastError: undefined,
    getURL(relative) { return `chrome-extension://mock/${relative}`; },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener(listener) { runtimeMessageListeners.push(listener); } },
    onConnect: { addListener(listener) { runtimeConnectListeners.push(listener); } },
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
    async query() { return [activeTab]; },
    async get(tabId) { return tabId === activeTab.id ? activeTab : null; },
    async sendMessage() { return { ok: true }; },
    async reload(tabId) {
      reloadCalls++;
      setTimeout(() => {
        for (const listener of debuggerEventListeners) {
          listener({ tabId }, "Network.requestWillBeSent", {
            requestId: "prepared-request",
            type: "Fetch",
            request: { method: "GET", url: "https://example.test/api/prepared" },
          });
          listener({ tabId }, "Network.responseReceived", {
            requestId: "prepared-request",
            type: "Fetch",
            response: {
              status: 200,
              mimeType: "application/json",
              url: "https://example.test/api/prepared",
            },
          });
          listener({ tabId }, "Network.loadingFinished", {
            requestId: "prepared-request",
            encodedDataLength: 100,
          });
          listener({ tabId }, "Runtime.consoleAPICalled", {
            type: "log",
            args: [{ value: "prepared-console" }],
          });
        }
        for (const listener of [...tabUpdatedListeners]) {
          listener(tabId, { status: "complete" }, activeTab);
        }
      }, 0);
    },
    onActivated: { addListener(listener) { tabActivatedListeners.push(listener); } },
    onUpdated: {
      addListener(listener) { tabUpdatedListeners.push(listener); },
      removeListener(listener) {
        const index = tabUpdatedListeners.indexOf(listener);
        if (index >= 0) tabUpdatedListeners.splice(index, 1);
      },
    },
    onRemoved: { addListener() {} },
  },
  scripting: {
    async executeScript() { return []; },
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
        return {
          body: JSON.stringify({ ok: true, access_token: "response-secret" }),
          base64Encoded: false,
        };
      }
      return {};
    },
    onEvent: { addListener(listener) { debuggerEventListeners.push(listener); } },
    onDetach: eventTarget(),
  },
  storage: {
    local: {
      async get(keys) {
        const names =
          typeof keys === "string"
            ? [keys]
            : Array.isArray(keys)
              ? keys
              : Object.keys(keys || {});
        return Object.fromEntries(names.map((name) => [name, storage[name]]));
      },
      async set(values) { Object.assign(storage, values); },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
      },
    },
    session: {
      async get(keys) {
        const names = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
        return Object.fromEntries(names.map((name) => [name, sessionStorage[name]]));
      },
      async set(values) { Object.assign(sessionStorage, values); },
      async remove(key) { delete sessionStorage[key]; },
    },
  },
};

await import(pathToFileURL(path.join(directory, "..", "background.js")).href);
assert.equal(runtimeMessageListeners.length, 1);
assert.equal(runtimeConnectListeners.length, 1);

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
function send(message, sender = {}) {
  return new Promise((resolve) => {
    assert.equal(runtimeHandler(message, sender, resolve), true);
  });
}

const basePayload = {
  pageScope: "v1|tab:11|origin:https://example.test",
  text: "分析当前页",
  browser: {
    tabId: 11,
    windowId: 3,
    title: "Mock page",
    url: "https://example.test/page",
    pageText: "Mock page body",
    enableBrowserControl: true,
  },
};

const completed = await send({
  type: "assistant-send",
  payload: { ...basePayload, requestId: "direct-turn" },
});
assert.equal(completed.ok, true);
assert.match(completed.sessionId, /^sc-/);
assert.ok(completed.events.some((event) => event.type === "thinking"));
assert.ok(completed.events.some((event) => event.type === "partial"));
const directCall = fetchCalls.find((call) => call.url.endsWith("/chat/completions"));
assert.ok(directCall, "service worker should call the model API directly");
assert.equal(directCall.init.headers.Authorization, "Bearer bundled-key");
const directBody = JSON.parse(directCall.init.body);
assert.equal(directBody.model, "deepseek-v4");
assert.equal(directBody.messages.at(-1).content, "分析当前页");
assert.match(directBody.messages[0].content, /Mock page body/);
assert.equal(directBody.messages[0].content.includes("enableBrowserControl"), false);
assert.ok(
  sidepanelOutbound.some(
    (message) => message.type === "assistant-event" && message.event?.type === "thinking"
  )
);
assert.ok(
  sidepanelOutbound.some(
    (message) => message.type === "assistant-done" && message.requestId === "direct-turn"
  )
);

const listed = await send({ type: "list-sessions", query: "", limit: 40 });
assert.equal(listed.ok, true);
assert.ok(listed.sessions.some((session) => session.id === completed.sessionId));
const loaded = await send({ type: "get-session", sessionId: completed.sessionId, limit: 80 });
assert.equal(loaded.ok, true);
assert.deepEqual(loaded.messages.map((message) => message.role), ["user", "thinking", "assistant"]);

const captureStarted = await send({ type: "debug-capture-start", tabId: 11 });
assert.equal(captureStarted.ok, true);
assert.equal(debuggerAttached, true);
assert.ok(debuggerCommands.some((command) => command.method === "Network.enable"));

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
    response: {
      status: 200,
      mimeType: "application/json",
      url: "https://example.test/api",
    },
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
const debugSnapshot = await send({ type: "debug-capture-snapshot", tabId: 11 });
assert.equal(debugSnapshot.ok, true);
assert.match(debugSnapshot.snapshot, /POST .*\/api/);
assert.match(debugSnapshot.snapshot, /\[redacted\]/);
assert.equal(debugSnapshot.snapshot.includes("request-secret"), false);
assert.equal(debugSnapshot.snapshot.includes("body-secret"), false);
assert.equal(debugSnapshot.snapshot.includes("response-secret"), false);
assert.equal(debugSnapshot.snapshot.includes("console-secret"), false);

const callsBeforeDebug = fetchCalls.length;
const debugCompleted = await send({
  type: "assistant-send",
  payload: {
    ...basePayload,
    requestId: "auto-debug-turn",
    text: "你可以拿到这页面的接口和数据吗",
    browser: { ...basePayload.browser, mentions: [] },
  },
});
assert.equal(debugCompleted.ok, true);
const debugCall = fetchCalls.slice(callsBeforeDebug).find((call) => call.url.endsWith("/chat/completions"));
const debugBody = JSON.parse(debugCall.init.body);
assert.match(debugBody.messages[0].content, /@debug/);
assert.match(debugBody.messages[0].content, /Network \(1\)/);
assert.match(debugBody.messages[0].content, /Console \(1\)/);

const blockedCrossPage = await send({
  type: "assistant-send",
  payload: {
    ...basePayload,
    requestId: "wrong-page",
    pageScope: "v1|tab:99|origin:https://other.test",
  },
});
assert.equal(blockedCrossPage.ok, false);
assert.match(blockedCrossPage.error, /跨网页|标签页已切换/);

sessionStorage.pageScopeSessionsV1 = {
  "v1|tab:11|origin:https://example.test": {
    activeSessionId: completed.sessionId,
    sessionIds: [completed.sessionId],
    title: "Bound",
  },
};
const blockedForeign = await send({
  type: "assistant-send",
  payload: {
    ...basePayload,
    requestId: "foreign-session",
    sessionId: "another-page-session",
  },
});
assert.equal(blockedForeign.ok, false);
assert.match(blockedForeign.error, /不属于当前网页/);

const quickCompleted = await send({
  type: "quick-card-send",
  requestId: "quick-turn",
  text: "解释它",
  context: { kind: "selection", text: "被引用的句子" },
}, { tab: activeTab });
assert.equal(quickCompleted.ok, true);
const quickCall = fetchCalls.at(-1);
const quickBody = JSON.parse(quickCall.init.body);
assert.match(quickBody.messages[0].content, /被引用的句子/);
assert.equal(quickBody.messages[0].content.includes("Mock page body"), false);
assert.ok(
  quickCardOutbound.some(
    (message) => message.type === "assistant-event" && message.requestId === "quick-turn"
  )
);
assert.ok(
  quickCardOutbound.some(
    (message) => message.type === "assistant-done" && message.requestId === "quick-turn"
  )
);

const callsBeforeHandoff = fetchCalls.length;
const expanded = await send({
  type: "expand-quick-card",
  handoff: {
    sessionId: quickCompleted.sessionId,
    messages: [
      { role: "user", text: "解释它" },
      { role: "assistant", text: "解释结果" },
    ],
    draft: "继续问",
  },
}, { tab: activeTab });
assert.equal(expanded.ok, true);
assert.equal(sessionStorage.pendingAsk.kind, "card-handoff");
assert.equal(fetchCalls.length, callsBeforeHandoff, "expanding must not resend the prompt");

const transcription = await send({
  type: "transcribe-audio",
  mediaData: "data:audio/webm;base64,YQ==",
  mimeType: "audio/webm",
  fileName: "recording.webm",
});
assert.deepEqual(transcription, { ok: true, text: "转写结果" });
assert.ok(fetchCalls.some((call) => call.url.endsWith("/audio/transcriptions")));

tabActivatedListeners[0]({ tabId: activeTab.id, windowId: activeTab.windowId });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.ok(
  sidepanelOutbound.some(
    (message) => message.type === "active-page-changed" && message.page?.tabId === 11
  )
);

const captureStopped = await send({ type: "debug-capture-stop", tabId: 11 });
assert.equal(captureStopped.ok, true);
assert.equal(debuggerAttached, false);
const preparedDebug = await send({ type: "debug-capture-prepare", tabId: 11 });
assert.equal(preparedDebug.ok, true);
assert.equal(preparedDebug.reloaded, true);
assert.equal(reloadCalls, 1);
assert.match(preparedDebug.snapshot, /\/api\/prepared/);
assert.match(preparedDebug.snapshot, /prepared-console/);
assert.equal(debuggerAttached, false);

console.log("ok  - background direct API integration");

