/**
 * 将流式事件映射为 UI 渲染指令（纯函数，便于单测）。
 * 默认隐藏调试噪音以及旧会话中的工具记录。
 */

/**
 * @typedef {{ type: string, text?: string, name?: string, input?: string, sessionId?: string, rawType?: string, id?: string }} StreamEvent
 * @typedef {{ kind: 'thinking'|'assistant'|'error'|'session'|'meta'|'hidden', text: string, label?: string, streaming?: boolean, sessionId?: string }} UICommand
 */

const HIDDEN_PARTIAL = new Set(["stderr", "process_exit", "cancelled"]);

/**
 * 清理工具输出：去掉控制字符/疑似二进制，截断长度。
 * @param {string} text
 * @param {number} [max]
 */
export function sanitizeToolText(text, max = 4000) {
  let s = String(text ?? "");
  // strip ANSI
  s = s.replace(/\u001b\[[0-9;]*m/g, "");
  // drop control/binary noise (null bytes or high ratio of non-printables)
  const sample = s.slice(0, 800);
  let bad = 0;
  let hasNull = false;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0) hasNull = true;
    if (c < 9 || (c > 13 && c < 32) || c === 127) bad++;
  }
  if (hasNull || (sample.length > 20 && bad / sample.length > 0.05)) {
    return "[binary or non-text tool output omitted]";
  }
  // collapse huge whitespace
  s = s.replace(/\r/g, "");
  if (s.length > max) s = `${s.slice(0, max)}…`;
  return s;
}

/**
 * 无信息量的工具结果（如 exit status 1）不展示，避免刷屏。
 * @param {string} text
 */
export function isNoiseToolResult(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  if (/^exit status \d+$/i.test(t)) return true;
  if (/^exited with code \d+$/i.test(t)) return true;
  if (/^command failed with exit code \d+$/i.test(t)) return true;
  if (/^Process exited with code \d+$/i.test(t)) return true;
  if (/^Error: exit status \d+$/i.test(t)) return true;
  // dry-run synthetic noise
  if (t === "dry-run ok") return false;
  return false;
}

/**
 * @param {StreamEvent} event
 * @returns {UICommand[]}
 */
export function mapAssistantEventToUI(event) {
  if (!event || !event.type) return [];
  switch (event.type) {
    case "thinking":
      return [{ kind: "thinking", text: event.text || "", label: "thinking" }];
    case "text":
      return [{ kind: "assistant", text: event.text || "", streaming: false }];
    case "partial":
      if (HIDDEN_PARTIAL.has(event.rawType || "")) {
        return [{ kind: "hidden", text: event.text || "", label: event.rawType || "partial" }];
      }
      return [{ kind: "assistant", text: event.text || "", streaming: true }];
    case "tool_use": {
      const name = event.name || "tool";
      const input = event.input || "";
      return [{ kind: "hidden", text: `${name} ${input}`.trim(), label: "tool_use" }];
    }
    case "tool_result": {
      const cleaned = sanitizeToolText(event.text || "");
      return [{ kind: "hidden", text: cleaned, label: "tool_result" }];
    }
    case "session":
      // dry-session-* 仅调试用，不在 UI 状态里当真实会话展示（由 UI 过滤）
      return [{ kind: "session", text: event.sessionId || "", sessionId: event.sessionId }];
    case "error": {
      const msg = event.text || "error";
      if (isNoiseToolResult(msg)) {
        return [{ kind: "hidden", text: msg, label: "error" }];
      }
      return [{ kind: "error", text: msg, label: "error" }];
    }
    case "done":
      return [{ kind: "hidden", text: "done", label: "done" }];
    default:
      return [];
  }
}
