/** 页面脚本：只负责抽取网页上下文与受控页面动作。 */

function getSelectionText() {
  try {
    return String(window.getSelection?.()?.toString?.() || "").trim();
  } catch {
    return "";
  }
}

function getPageText(limit = 20000) {
  try {
    const root =
      document.querySelector("article") ||
      document.querySelector("main") ||
      document.body;
    if (!root) return "";
    return (root.innerText || root.textContent || "")
      .replace(/\s+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, limit);
  } catch {
    return "";
  }
}

function clickSelector(selector) {
  const el = document.querySelector(selector);
  if (!el) return { ok: false, error: `not found: ${selector}` };
  el.scrollIntoView({ block: "center", inline: "center" });
  el.click();
  return { ok: true, selector, tag: el.tagName };
}

function fillSelector(selector, value) {
  const el = document.querySelector(selector);
  if (!el) return { ok: false, error: `not found: ${selector}` };
  el.focus();
  if ("value" in el) {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, selector, valueLength: String(value).length };
  }
  if (el.isContentEditable) {
    el.textContent = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return { ok: true, selector, valueLength: String(value).length };
  }
  return { ok: false, error: "element not fillable" };
}

function pressKey(selector, key) {
  const el = selector ? document.querySelector(selector) : document.activeElement || document.body;
  if (!el) return { ok: false, error: "no target" };
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  el.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
  return { ok: true, key, selector: selector || null };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "extract-context") {
    sendResponse({
      title: document.title || "",
      url: location.href,
      selection: getSelectionText(),
      pageText: getPageText(msg.limit || 20000),
    });
    return true;
  }
  if (msg?.type === "browser-page-action") {
    const action = msg.action;
    try {
      if (action === "click") sendResponse(clickSelector(msg.selector));
      else if (action === "fill") sendResponse(fillSelector(msg.selector, msg.value ?? ""));
      else if (action === "press") sendResponse(pressKey(msg.selector || null, msg.key || "Enter"));
      else if (action === "read") {
        sendResponse({
          ok: true,
          title: document.title || "",
          url: location.href,
          selection: getSelectionText(),
          pageText: getPageText(msg.limit || 20000),
        });
      } else sendResponse({ ok: false, error: `unknown page action: ${action}` });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return true;
  }
  return false;
});
