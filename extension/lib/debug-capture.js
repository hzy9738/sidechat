/**
 * Pure helpers for the opt-in DevTools snapshot.
 * Keep credentials out of the model context and cap every captured value.
 */

export const DEBUG_NETWORK_LIMIT = 60;
export const DEBUG_CONSOLE_LIMIT = 80;
export const DEBUG_BODY_LIMIT = 12_000;
export const DEBUG_RESPONSE_FETCH_LIMIT = 256 * 1024;

const SENSITIVE_KEY = /(?:authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|password|passwd|secret|session|credential|jwt)/i;

export function isDebugQuestion(text) {
  return /(?:network|console|xhr|fetch|\bapi\b|接口|控制台|请求(?:体|参数|数据)?|响应(?:体|数据)?|状态码|页面.{0,8}数据|数据.{0,8}页面)/i.test(
    String(text || "")
  );
}

function truncate(value, maxChars = DEBUG_BODY_LIMIT) {
  const text = String(value ?? "");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated]` : text;
}

function redactObject(value, depth = 0) {
  if (depth > 8) return "[depth limited]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactObject(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    result[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redactObject(item, depth + 1);
  }
  return result;
}

export function sanitizeUrl(rawUrl) {
  const raw = String(rawUrl || "");
  try {
    const url = new URL(raw);
    if (url.username) url.username = "[redacted]";
    if (url.password) url.password = "[redacted]";
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, "[redacted]");
    }
    url.hash = "";
    return truncate(url.toString(), 2_000);
  } catch {
    return truncate(raw, 2_000);
  }
}

export function sanitizeText(rawValue, maxChars = DEBUG_BODY_LIMIT) {
  const raw = String(rawValue ?? "").trim();
  if (!raw) return "";
  try {
    return truncate(JSON.stringify(redactObject(JSON.parse(raw))), maxChars);
  } catch {
    return truncate(
      raw
        .replace(/(authorization\s*[=:]\s*)(?:bearer\s+)?[^\s,;&]+/gi, "$1[redacted]")
        .replace(/((?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|cookie)\s*[=:]\s*)([^\s,;&]+)/gi, "$1[redacted]")
        .replace(/(bearer\s+)[a-z0-9._~+\/-]+=*/gi, "$1[redacted]"),
      maxChars
    );
  }
}

export function consoleArgumentText(argument) {
  if (!argument || typeof argument !== "object") return sanitizeText(argument, 2_000);
  if (argument.value !== undefined) {
    const value =
      typeof argument.value === "string" ? argument.value : JSON.stringify(redactObject(argument.value));
    return sanitizeText(value, 2_000);
  }
  return sanitizeText(argument.description || argument.className || argument.type || "", 2_000);
}

export function pushBounded(list, value, limit) {
  list.push(value);
  while (list.length > limit) list.shift();
  return value;
}

export function formatDebugSnapshot(capture) {
  const network = Array.isArray(capture?.network) ? capture.network : [];
  const consoleEntries = Array.isArray(capture?.console) ? capture.console : [];
  const lines = [
    "[Read-only DevTools snapshot]",
    `Page: ${sanitizeUrl(capture?.url || "")}`,
    `Captured since: ${new Date(capture?.startedAt || Date.now()).toISOString()}`,
    "Credential-like fields were redacted. This snapshot only contains events observed after capture started.",
    "",
    `Network (${network.length}):`,
  ];

  if (!network.length) lines.push("- No requests captured yet. Reload or reproduce the issue, then attach another snapshot.");
  for (const item of network) {
    const status = item.status != null ? ` → ${item.status}` : item.error ? " → failed" : "";
    const type = item.type ? ` [${item.type}]` : "";
    lines.push(`- ${item.method || "GET"} ${sanitizeUrl(item.url)}${status}${type}`);
    if (item.mimeType) lines.push(`  Content-Type: ${sanitizeText(item.mimeType, 200)}`);
    if (item.requestBody) lines.push(`  Request body: ${sanitizeText(item.requestBody)}`);
    if (item.responseBody) lines.push(`  Response body: ${sanitizeText(item.responseBody)}`);
    if (item.bodyNote) lines.push(`  Response body: ${sanitizeText(item.bodyNote, 500)}`);
    if (item.error) lines.push(`  Error: ${sanitizeText(item.error, 1_000)}`);
  }

  lines.push("", `Console (${consoleEntries.length}):`);
  if (!consoleEntries.length) lines.push("- No console messages captured yet.");
  for (const item of consoleEntries) {
    const where = item.url ? ` (${sanitizeUrl(item.url)}${item.line ? `:${item.line}` : ""})` : "";
    lines.push(`- [${item.level || "log"}] ${sanitizeText(item.text, 4_000)}${where}`);
  }
  return lines.join("\n");
}
