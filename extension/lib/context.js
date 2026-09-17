/**
 * Pure context helpers: @-mention parsing and browser payload packing.
 * Usable from the side panel and Node tests (no chrome.* APIs).
 */

/** @typedef {{ kind: string, title?: string, url?: string, text?: string, tabId?: number }} Mention */
/** @typedef {{ title?: string, url?: string, selection?: string, pageText?: string, tabs?: Array<{title?:string,url?:string,id?:number}>, includeTabs?: boolean, mentions?: Mention[], localPathHint?: string }} BrowserContext */

/**
 * 从输入文本中解析 @ 提及标记（@page / @selection / @tabs / @tab:标题）。
 * @param {string} text
 * @returns {{ kinds: Set<string>, tabQueries: string[] }}
 */
export function parseMentionTokens(text) {
  const kinds = new Set();
  const tabQueries = [];
  const src = String(text || "");
  const re = /@([a-zA-Z_][\w-]*)(?::([^\s@]+))?/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const kind = m[1].toLowerCase();
    const arg = m[2] || "";
    if (kind === "tab" && arg) {
      kinds.add("tab");
      tabQueries.push(decodeURIComponent(arg.replace(/\+/g, " ")));
    } else {
      kinds.add(kind);
    }
  }
  return { kinds, tabQueries };
}

/**
 * 根据 toggles / @tokens / 页面采集结果组装发往模型接口的 browser 载荷。
 * 不会把页面 URL 写成 cwd。
 * @param {object} opts
 * @param {BrowserContext} opts.page
 * @param {string} [opts.inputText]
 * @param {Mention[]} [opts.chips]
 * @param {boolean} [opts.includePageText]
 */
export function packBrowserContext(opts) {
  const page = opts.page || {};
  const chips = Array.isArray(opts.chips) ? opts.chips.slice() : [];
  const { kinds, tabQueries } = parseMentionTokens(opts.inputText || "");

  const wantPage = kinds.has("page") || chips.some((c) => c.kind === "page");
  const wantSelection = kinds.has("selection") || chips.some((c) => c.kind === "selection");
  const wantTabs = kinds.has("tabs") || kinds.has("tab") || chips.some((c) => c.kind === "tab" || c.kind === "tabs");
  // 正文：设置里「默认附带页面正文」/ @body / 口头问当前页
  const asksAboutPage = /当前页|这个页面|本页|this page|current page|看得到|能看到/i.test(
    String(opts.inputText || "")
  );
  const wantPageText =
    opts.includePageText === true ||
    opts.defaultPageText === true ||
    kinds.has("pagetext") ||
    kinds.has("body") ||
    chips.some((c) => c.kind === "pageText" || c.kind === "body") ||
    asksAboutPage;

  /** @type {Mention[]} */
  const mentions = [];

  if (wantPage || chips.some((c) => c.kind === "page")) {
    mentions.push({
      kind: "page",
      title: page.title || "",
      url: page.url || "",
    });
  }
  if (wantSelection && (page.selection || chips.some((c) => c.kind === "selection" && c.text))) {
    const fromChip = chips.find((c) => c.kind === "selection" && c.text);
    mentions.push({
      kind: "selection",
      text: (fromChip && fromChip.text) || page.selection || "",
    });
  }
  if (wantTabs && Array.isArray(page.tabs)) {
    let tabs = page.tabs;
    if (tabQueries.length) {
      tabs = tabs.filter((t) =>
        tabQueries.some((q) => {
          const qq = q.toLowerCase();
          return (
            String(t.title || "").toLowerCase().includes(qq) ||
            String(t.url || "").toLowerCase().includes(qq)
          );
        })
      );
    }
    for (const t of tabs) {
      mentions.push({
        kind: "tab",
        title: t.title || "",
        url: t.url || "",
        tabId: t.id,
      });
    }
  }
  // Explicit chips (user-selected) always included.
  for (const c of chips) {
    if (c.kind === "page" || c.kind === "selection" || c.kind === "tab" || c.kind === "tabs") {
      // already synthesized from tokens; still allow extra chip text
      if (c.kind === "pageText" || c.kind === "body") {
        mentions.push(c);
      }
    } else {
      mentions.push(c);
    }
  }
  if (wantPageText && page.pageText) {
    mentions.push({ kind: "pageText", text: page.pageText });
  }

  const images = [];
  for (const c of chips) {
    if (c.kind !== "image") continue;
    const src = String(c.src || c.url || "").trim();
    const dataUrl = String(c.dataUrl || "").trim();
    if (!src && !dataUrl) continue;
    images.push({
      src,
      dataUrl,
      alt: String(c.alt || c.title || "").trim(),
    });
  }
  if (Array.isArray(page.images)) {
    for (const img of page.images) {
      if (!img) continue;
      images.push({
        src: String(img.src || "").trim(),
        dataUrl: String(img.dataUrl || "").trim(),
        alt: String(img.alt || "").trim(),
      });
    }
  }

  const includeTabs = wantTabs;
  /** @type {BrowserContext} */
  const browser = {
    tabId: page.tabId,
    windowId: page.windowId,
    title: page.title || "",
    url: page.url || "",
    selection: wantSelection ? page.selection || "" : "",
    pageText: wantPageText ? page.pageText || "" : "",
    includeTabs,
    tabs: includeTabs ? page.tabs || [] : [],
    mentions,
    images,
    localPathHint: page.localPathHint || "",
  };

  // 始终带上当前页身份；正文由 wantPageText 控制。
  if (!browser.title) browser.title = page.title || "";
  if (!browser.url) browser.url = page.url || "";
  if (!wantSelection && page.selection) {
    // 有选区时默认捎带（不强制 chip）
    browser.selection = page.selection;
  }

  return browser;
}

/**
 * 从用户输入中剥离 @token，保留可读文本。
 * @param {string} text
 */
export function stripMentionTokens(text) {
  return String(text || "")
    .replace(/@([a-zA-Z_][\w]*)(?::([^\s@]+))?/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * localhost 调试页可选路径提示（不是 cwd）。
 * @param {string} pageURL
 */
export function localPathHintFromURL(pageURL) {
  try {
    const u = new URL(String(pageURL || ""));
    const host = (u.hostname || "").toLowerCase();
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") return "";
    const p = u.pathname || "";
    if (!p || p === "/") return "";
    return p;
  } catch {
    return "";
  }
}
