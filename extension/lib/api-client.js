const TOOL_FREE_SYSTEM =
  "你是安能助手，由正泰安能提供的通用浏览器智能助手。对用户询问身份、来源或所属产品时，只能回答你是安能助手；不得自称其他产品。你通过公司私有化模型服务回答问题。只能根据用户消息和扩展提供的只读上下文回答，不能主动操作网页、执行命令、搜索或调用工具。扩展会在用户询问接口、Network、Console、请求或响应数据时自动采集、脱敏并附带 @debug DevTools 快照；只要存在 @debug，就必须直接分析其中的实际内容，绝不能声称自己无法读取 Network、Console、接口或原始数据。如果本轮没有 @debug，只能说明这一次未采集到调试快照并建议用户重试，不要要求用户寻找开关，也不要把它描述成助手永久不具备的能力。";

function clean(value) {
  return String(value || "").trim();
}

function firstNonempty(...values) {
  return values.map(clean).find(Boolean) || "";
}

function truncate(text, max = 16_000) {
  const chars = [...String(text || "")];
  return chars.length > max ? `${chars.slice(0, max).join("")}\n…[truncated]` : chars.join("");
}

/** 保证地址与密钥来自同一层配置，避免把内置密钥发往用户填写的第三方地址。 */
export function resolveApiConfig(request = {}, stored = {}, bundled = {}, hasImages = false) {
  let apiBase = "";
  let apiKey = "";
  if (clean(request.apiBase)) {
    apiBase = clean(request.apiBase);
    apiKey = clean(request.apiKey);
  } else if (clean(stored.apiBase)) {
    apiBase = clean(stored.apiBase);
    apiKey = clean(stored.apiKey);
  } else {
    apiBase = clean(bundled.apiBase);
    apiKey = clean(bundled.apiKey);
  }
  const visionModel = firstNonempty(
    request.visionModel,
    stored.visionModel,
    bundled.visionModel,
    "qwen-vl"
  );
  let model = firstNonempty(request.model, stored.apiModel, bundled.model, "deepseek-v4");
  if (hasImages && !clean(request.model)) model = visionModel;
  return { apiBase, apiKey, model, visionModel };
}

export function chatCompletionsUrl(base) {
  const value = clean(base).replace(/\/+$/, "");
  if (!value) throw new Error("需要 API 地址，请在设置中填写或使用带内置配置的扩展包。");
  return value.endsWith("/chat/completions") ? value : `${value}/chat/completions`;
}

export function apiUrl(base, path) {
  let value = clean(base).replace(/\/+$/, "");
  if (!value) throw new Error("需要 API 地址，请在设置中填写或使用带内置配置的扩展包。");
  value = value.replace(/\/chat\/completions$/, "");
  return `${value}/${String(path || "").replace(/^\/+/, "")}`;
}

export function assembleBrowserContext(ctx = {}, maxPageChars = 16_000) {
  const mentions = Array.isArray(ctx.mentions) ? ctx.mentions : [];
  const tabs = Array.isArray(ctx.tabs) ? ctx.tabs : [];
  const images = Array.isArray(ctx.images) ? ctx.images : [];
  const hasContext =
    clean(ctx.title) ||
    clean(ctx.url) ||
    clean(ctx.selection) ||
    clean(ctx.pageText) ||
    clean(ctx.localPathHint) ||
    mentions.length ||
    images.length ||
    (ctx.includeTabs && tabs.length);
  if (!hasContext) return "";

  const out = ["[Browser context]"];
  if (clean(ctx.title)) out.push(`Title: ${clean(ctx.title)}`);
  if (clean(ctx.url)) out.push(`URL: ${clean(ctx.url)}`);
  if (clean(ctx.selection)) out.push("Selection:", clean(ctx.selection));
  if (clean(ctx.pageText)) out.push("Page extract:", truncate(clean(ctx.pageText), maxPageChars));
  if (clean(ctx.localPathHint)) {
    out.push(`Local path hint (localhost debug only; not a bound workspace): ${clean(ctx.localPathHint)}`);
  }
  if (images.length) {
    out.push("Attached images:");
    for (const image of images) {
      const src = clean(image?.src) || "(inline)";
      const alt = clean(image?.alt);
      out.push(alt ? `- ${alt} | ${src}` : `- ${src}`);
    }
  }
  if (mentions.length) {
    out.push("Attached mentions:");
    for (const mention of mentions) {
      const kind = clean(mention?.kind) || "item";
      const title = clean(mention?.title);
      const url = clean(mention?.url);
      out.push(`- @${kind}${title ? ` ${title}` : ""}${url ? ` | ${url}` : ""}`);
      if (clean(mention?.text)) out.push(truncate(clean(mention.text), maxPageChars));
    }
  }
  if (ctx.includeTabs && tabs.length) {
    out.push("Open tabs:");
    for (const tab of tabs) {
      const title = clean(tab?.title) || "(untitled)";
      const url = clean(tab?.url);
      if (title !== "(untitled)" || url) out.push(`- ${title} | ${url}`);
    }
  }
  return `${out.join("\n")}\n`;
}

export function buildChatMessages(browser, userText, history = []) {
  const context = assembleBrowserContext(browser);
  const messages = [
    { role: "system", content: context ? `${TOOL_FREE_SYSTEM}\n\n${context}` : TOOL_FREE_SYSTEM },
  ];
  for (const message of history) {
    const role = clean(message?.role);
    const text = clean(message?.text);
    if ((role === "user" || role === "assistant") && text) {
      messages.push({ role, content: text });
    }
  }
  const images = (Array.isArray(browser?.images) ? browser.images : [])
    .map((image) => firstNonempty(image?.dataUrl, image?.src))
    .filter((url) => url && url.length <= 8 * 1024 * 1024);
  const content = images.length
    ? [
        { type: "text", text: clean(userText) },
        ...images.map((url) => ({ type: "image_url", image_url: { url } })),
      ]
    : clean(userText);
  messages.push({ role: "user", content });
  return messages;
}

export function parseOpenAIStreamLine(line) {
  let value = String(line || "").trim();
  if (!value || value.startsWith(":")) return { thinking: "", text: "", done: false };
  if (value.startsWith("data:")) value = value.slice(5).trim();
  if (!value) return { thinking: "", text: "", done: false };
  if (value === "[DONE]") return { thinking: "", text: "", done: true };
  let chunk;
  try {
    chunk = JSON.parse(value);
  } catch {
    return { thinking: "", text: "", done: false };
  }
  if (clean(chunk?.error?.message)) throw new Error(clean(chunk.error.message));
  const choice = chunk?.choices?.[0] || {};
  const delta = choice.delta || choice.message || {};
  return {
    thinking: firstNonempty(delta.reasoning_content, delta.reasoning),
    text: typeof delta.content === "string" ? delta.content : "",
    done: false,
  };
}

function headers(config, accept) {
  const out = { "Content-Type": "application/json", Accept: accept };
  if (clean(config.apiKey)) out.Authorization = `Bearer ${clean(config.apiKey)}`;
  return out;
}

export async function streamChat({ config, messages, signal, onDelta, fetchImpl = fetch }) {
  if (!clean(config?.model)) throw new Error("需要模型名。");
  const response = await fetchImpl(chatCompletionsUrl(config.apiBase), {
    method: "POST",
    headers: headers(config, "text/event-stream"),
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: true,
      thinking: { type: "enabled" },
    }),
    signal,
  });
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 4096).trim();
    throw new Error(`模型服务返回 HTTP ${response.status}${body ? `: ${body}` : ""}`);
  }

  let assistant = "";
  let thinking = "";
  const contentType = response.headers?.get?.("content-type") || "";
  if (!response.body || /application\/json/i.test(contentType)) {
    const json = await response.json();
    const delta = json?.choices?.[0]?.message || json?.choices?.[0]?.delta || {};
    thinking = firstNonempty(delta.reasoning_content, delta.reasoning);
    assistant = typeof delta.content === "string" ? delta.content : "";
    if (thinking) onDelta?.("thinking", thinking);
    if (assistant) onDelta?.("partial", assistant);
    return { assistant, thinking };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  while (!done) {
    const part = await reader.read();
    buffer += decoder.decode(part.value || new Uint8Array(), { stream: !part.done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const parsed = parseOpenAIStreamLine(line);
      if (parsed.thinking) {
        thinking += parsed.thinking;
        onDelta?.("thinking", parsed.thinking);
      }
      if (parsed.text) {
        assistant += parsed.text;
        onDelta?.("partial", parsed.text);
      }
      if (parsed.done) {
        done = true;
        break;
      }
    }
    if (part.done) done = true;
  }
  if (buffer.trim()) {
    const parsed = parseOpenAIStreamLine(buffer);
    if (parsed.thinking) {
      thinking += parsed.thinking;
      onDelta?.("thinking", parsed.thinking);
    }
    if (parsed.text) {
      assistant += parsed.text;
      onDelta?.("partial", parsed.text);
    }
  }
  return { assistant, thinking };
}

export async function transcribeAudio({ config, dataUrl, mimeType, fileName, fetchImpl = fetch }) {
  const response = await fetchImpl(dataUrl);
  const blob = await response.blob();
  if (!blob.size || blob.size > 24 * 1024 * 1024) throw new Error("录音为空或超过 24 MB。");
  const form = new FormData();
  form.append("model", "whisper-1");
  form.append("file", blob, clean(fileName) || "recording.webm");
  const requestHeaders = {};
  if (clean(config.apiKey)) requestHeaders.Authorization = `Bearer ${clean(config.apiKey)}`;
  const result = await fetchImpl(apiUrl(config.apiBase, "audio/transcriptions"), {
    method: "POST",
    headers: requestHeaders,
    body: form,
  });
  if (!result.ok) {
    const body = (await result.text().catch(() => "")).slice(0, 2048).trim();
    throw new Error(`语音转写接口返回 HTTP ${result.status}${body ? `: ${body}` : ""}`);
  }
  const json = await result.json();
  const text = clean(json?.text);
  if (!text) throw new Error("语音转写结果为空。");
  return text;
}

