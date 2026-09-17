/**
 * Pure-helper tests for extension lib (real shipped modules).
 * Run: node extension/test/run-tests.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const lib = path.join(__dirname, "..", "lib");

const context = await import(pathToFileURL(path.join(lib, "context.js")).href);
const events = await import(pathToFileURL(path.join(lib, "events.js")).href);
const threads = await import(pathToFileURL(path.join(lib, "threads.js")).href);
const markdown = await import(pathToFileURL(path.join(lib, "markdown.js")).href);
const apiClient = await import(pathToFileURL(path.join(lib, "api-client.js")).href);
const pageScope = await import(pathToFileURL(path.join(lib, "page-scope.js")).href);
const debugCapture = await import(pathToFileURL(path.join(lib, "debug-capture.js")).href);

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok  - ${name}`);
  } catch (e) {
    failed++;
    console.error(`fail - ${name}`);
    console.error(e);
  }
}

test("parseMentionTokens finds page/selection/tabs", () => {
  const { kinds } = context.parseMentionTokens("look at @page and @selection please @tabs");
  assert.ok(kinds.has("page"));
  assert.ok(kinds.has("selection"));
  assert.ok(kinds.has("tabs"));
});

test("packBrowserContext keeps selected images for vision turns", () => {
  const packed = context.packBrowserContext({
    page: {
      title: "Example",
      url: "https://example.com/docs",
    },
    inputText: "这张图是什么",
    chips: [
      {
        kind: "image",
        src: "https://example.com/a.png",
        dataUrl: "data:image/png;base64,xx",
        alt: "示意图",
      },
    ],
  });
  assert.equal(packed.images.length, 1);
  assert.equal(packed.images[0].src, "https://example.com/a.png");
  assert.ok(packed.mentions.some((m) => m.kind === "image"));
});

test("packBrowserContext keeps extracted PDF text as a document mention", () => {
  const packed = context.packBrowserContext({
    page: { title: "Example", url: "https://example.com" },
    inputText: "总结文档",
    chips: [{ kind: "document", title: "方案.pdf", text: "第一章 项目背景" }],
  });
  const document = packed.mentions.find((item) => item.kind === "document");
  assert.equal(document.title, "方案.pdf");
  assert.match(document.text, /项目背景/);
});

test("debug snapshot redacts credentials and keeps useful API data", () => {
  const snapshot = debugCapture.formatDebugSnapshot({
    url: "https://example.test/app?token=secret-token&view=main",
    startedAt: 1,
    network: [{
      method: "POST",
      url: "https://example.test/api/items?api_key=top-secret",
      type: "Fetch",
      status: 200,
      mimeType: "application/json",
      requestBody: JSON.stringify({ name: "demo", password: "dont-show" }),
      responseBody: JSON.stringify({ data: [1, 2], access_token: "dont-show-either" }),
    }],
    console: [{ level: "error", text: "Authorization: Bearer abc.def", url: "https://example.test/app.js", line: 9 }],
  });
  assert.match(snapshot, /POST .*\/api\/items/);
  assert.match(snapshot, /\"name\":\"demo\"/);
  assert.match(snapshot, /\[redacted\]/);
  assert.equal(snapshot.includes("dont-show"), false);
  assert.equal(snapshot.includes("secret-token"), false);
  assert.equal(snapshot.includes("top-secret"), false);
  assert.equal(snapshot.includes("abc.def"), false);
});

test("debug questions are detected without treating ordinary questions as debug work", () => {
  assert.equal(debugCapture.isDebugQuestion("你可以拿到这页面的接口和数据吗"), true);
  assert.equal(debugCapture.isDebugQuestion("分析一下 Network 和 Console"), true);
  assert.equal(debugCapture.isDebugQuestion("这段文字是什么意思"), false);
});

test("packBrowserContext contains page context but no tool toggle or cwd", () => {
  const packed = context.packBrowserContext({
    page: {
      title: "Example",
      url: "https://example.com/docs",
      selection: "hi",
      pageText: "body",
      tabs: [{ title: "Example", url: "https://example.com/docs", id: 1 }],
    },
    inputText: "summarize @page @selection",
    chips: [],
    enableBrowserControl: true,
  });
  assert.equal(packed.url, "https://example.com/docs");
  assert.ok(packed.mentions.some((m) => m.kind === "page"));
  assert.ok(packed.mentions.some((m) => m.kind === "selection"));
  assert.equal(Object.prototype.hasOwnProperty.call(packed, "enableBrowserControl"), false);
  // no cwd field on browser payload
  assert.equal(Object.prototype.hasOwnProperty.call(packed, "cwd"), false);
});

test("localPathHintFromURL only localhost", () => {
  assert.equal(context.localPathHintFromURL("https://example.com/x"), "");
  assert.equal(context.localPathHintFromURL("http://localhost:5173/src/App.tsx"), "/src/App.tsx");
});

test("page scope isolates tabs and cross-origin navigation", () => {
  const docsA = pageScope.derivePageScope(7, "https://example.com/docs/a");
  const docsB = pageScope.derivePageScope(7, "https://example.com/docs/b?x=1");
  assert.equal(docsA, docsB, "same tab and origin should keep the conversation");
  assert.notEqual(docsA, pageScope.derivePageScope(8, "https://example.com/docs/a"));
  assert.notEqual(docsA, pageScope.derivePageScope(7, "https://other.example/docs/a"));
  assert.notEqual(
    pageScope.derivePageScope(7, "file:///tmp/a.html"),
    pageScope.derivePageScope(7, "file:///tmp/b.html")
  );
});

test("scope records retain only sessions bound to that page scope", () => {
  const scopeA = pageScope.derivePageScope(1, "https://a.example/one");
  const scopeB = pageScope.derivePageScope(2, "https://a.example/one");
  let store = pageScope.updateScopeRecord({}, scopeA, {
    activeSessionId: "session-a",
    title: "A",
  });
  store = pageScope.updateScopeRecord(store, scopeB, { activeSessionId: "session-b" });
  assert.deepEqual(pageScope.readScopeRecord(store, scopeA).sessionIds, ["session-a"]);
  assert.deepEqual(
    pageScope.filterSessionsForScope(
      [{ id: "session-a" }, { id: "session-b" }],
      pageScope.readScopeRecord(store, scopeA)
    ).map((session) => session.id),
    ["session-a"]
  );
  store = pageScope.removeScopesForTab(store, 1);
  assert.equal(pageScope.readScopeRecord(store, scopeA).activeSessionId, "");
  assert.equal(pageScope.readScopeRecord(store, scopeB).activeSessionId, "session-b");
});

test("mapAssistantEventToUI maps thinking/text and hides tools", () => {
  const t = events.mapAssistantEventToUI({ type: "thinking", text: "..." });
  assert.equal(t[0].kind, "thinking");
  const a = events.mapAssistantEventToUI({ type: "partial", text: "hello" });
  assert.equal(a[0].kind, "assistant");
  assert.equal(a[0].streaming, true);
  const tool = events.mapAssistantEventToUI({
    type: "tool_use",
    name: "browser_click",
    input: '{"selector":"#go"}',
  });
  assert.equal(tool[0].kind, "hidden");
});

test("mapAssistantEventToUI hides stream noise and done events", () => {
  const argv = events.mapAssistantEventToUI({
    type: "partial",
    text: "argv: [...]",
    rawType: "stderr",
  });
  assert.equal(argv[0].kind, "hidden");
  const done = events.mapAssistantEventToUI({ type: "done" });
  assert.equal(done[0].kind, "hidden");
});

test("sanitizeToolText strips binary-ish noise", () => {
  const bin = "\x00\x01\x02" + "x".repeat(50);
  const s = events.sanitizeToolText(bin);
  assert.match(s, /binary|omitted/i);
});

test("exit status tool results are hidden noise", () => {
  assert.equal(events.isNoiseToolResult("exit status 1"), true);
  const mapped = events.mapAssistantEventToUI({ type: "tool_result", text: "exit status 1" });
  assert.equal(mapped[0].kind, "hidden");
});

test("threads create/sort/title", () => {
  const a = threads.createThread({ title: "A", updatedAt: 1 });
  const b = threads.createThread({ title: "B", updatedAt: 2 });
  const sorted = threads.sortThreads([a, b]);
  assert.equal(sorted[0].title, "B");
  assert.ok(threads.titleFromUserText("hello world").includes("hello"));
});

test("renderMarkdown code block has copy button", () => {
  const html = markdown.renderMarkdown("```js\nconst x = 1\n```");
  assert.ok(html.includes("code-block"));
  assert.ok(html.includes("data-copy"));
  assert.ok(html.includes("const x = 1"));
});

test("stripMentionTokens", () => {
  const s = context.stripMentionTokens("@page hello @selection");
  assert.ok(s.includes("hello"));
  assert.ok(!s.includes("@page"));
});

test("direct API config keeps endpoint and credentials from the same layer", () => {
  const config = apiClient.resolveApiConfig(
    { apiBase: "https://request.example/v1", apiKey: "request-key" },
    { apiBase: "https://stored.example/v1", apiKey: "stored-key", apiModel: "stored-model" },
    { apiBase: "https://bundled.example/v1", apiKey: "bundled-key", model: "bundled-model" }
  );
  assert.equal(config.apiBase, "https://request.example/v1");
  assert.equal(config.apiKey, "request-key");
  assert.equal(config.model, "stored-model");
});

test("direct API messages include debug context and images", () => {
  const messages = apiClient.buildChatMessages(
    {
      title: "Example",
      url: "https://example.test",
      mentions: [{ kind: "debug", text: "Network (1): GET /api" }],
      images: [{ dataUrl: "data:image/png;base64,eA==" }],
    },
    "分析页面",
    [{ role: "assistant", text: "上一轮" }]
  );
  assert.match(messages[0].content, /Network \(1\)/);
  assert.equal(messages[1].content, "上一轮");
  assert.equal(messages[2].content[1].type, "image_url");
});

test("OpenAI SSE parser reads reasoning and answer deltas", () => {
  assert.deepEqual(
    apiClient.parseOpenAIStreamLine('data: {"choices":[{"delta":{"reasoning_content":"想","content":"答"}}]}'),
    { thinking: "想", text: "答", done: false }
  );
  assert.equal(apiClient.parseOpenAIStreamLine("data: [DONE]").done, true);
});

test("UI and background use the browser-only direct API path", async () => {
  const fs = await import("node:fs");
  const sp = fs.readFileSync(path.join(__dirname, "..", "sidepanel.js"), "utf8");
  assert.equal(sp.includes('type: "browser-action"'), false);
  assert.equal(sp.includes('type: "browser-approval-response"'), false);
  assert.equal(sp.includes('$("browser-control")'), false);
  assert.ok(sp.includes('reasoningEffort: "high"'));
  assert.ok(sp.includes('type: "transcribe-audio"'));
  assert.ok(sp.includes('import("./vendor/pdf.mjs")'));
  assert.ok(sp.includes('type: "assistant-send"'));
  const bg = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  assert.ok(bg.includes("streamChat({"));
  assert.ok(bg.includes('type: "assistant-event"'));
  assert.equal(bg.includes("connectNative"), false);
  assert.equal(bg.includes("nativeMessaging"), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  assert.equal(manifest.permissions.includes("nativeMessaging"), false);
});

test("sidepanel exposes keyboard and streaming interaction affordances", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "sidepanel.html"), "utf8");
  const js = fs.readFileSync(path.join(__dirname, "..", "sidepanel.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "sidepanel.css"), "utf8");
  assert.ok(html.includes('aria-modal="true"'));
  assert.ok(html.includes('id="btn-scroll-bottom"'));
  assert.ok(html.includes('aria-describedby="composer-hint"'));
  assert.ok(js.includes('state.followOutput = isLogNearBottom()'));
  assert.ok(js.includes('e.key === "ArrowDown" || e.key === "ArrowUp"'));
  assert.ok(js.includes("finishThinking()"));
  assert.equal(html.includes('id="btn-debug-toggle"'), false);
  assert.equal(html.includes('id="btn-debug-snapshot"'), false);
  assert.ok(js.includes('type: "debug-capture-prepare"'));
  assert.equal(js.includes('permissions.request({ permissions: ["debugger"] })'), false);
  assert.ok(css.includes("prefers-reduced-motion: reduce"));
});

test("quick card supports optional context and lossless side-panel handoff", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  const quick = fs.readFileSync(path.join(__dirname, "..", "quick-card.js"), "utf8");
  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.ok(manifest.permissions.includes("debugger"));
  assert.equal(Object.prototype.hasOwnProperty.call(manifest, "optional_permissions"), false);
  assert.ok(manifest.content_scripts[0].js.includes("quick-card.js"));
  assert.ok(quick.includes('data-action="explain"'));
  assert.ok(quick.includes('data-action="translate"'));
  assert.ok(quick.includes('addQuickButton("ocr"'));
  assert.ok(quick.includes('type: "expand-quick-card"'));
  assert.ok(quick.includes("sessionId: state.sessionId"));
  assert.ok(quick.includes("requestId: state.requestId"));
  assert.ok(quick.includes("messages: state.messages.map"));
  assert.ok(quick.includes("draft: input.value"));
  assert.equal(content.includes('"contextmenu"'), false);
});

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nall extension logic tests passed");
await import("./background-integration.mjs");
