/**
 * Native host 状态纯函数（可单测）。
 */

/**
 * connectNative / ping 失败时的标准化结果。
 * @param {{ lastError?: string|null, timedOut?: boolean, disconnected?: boolean, version?: string, msg?: any }} info
 * @returns {{ ok: boolean, error?: string, version?: string, msg?: any, note?: string }}
 */
export function normalizeHostPingResult(info = {}) {
  const lastError = (info.lastError && String(info.lastError).trim()) || "";
  if (info.disconnected || lastError) {
    return {
      ok: false,
      error: lastError || "native host disconnected",
    };
  }
  if (info.timedOut) {
    return {
      ok: false,
      error: "native host ping timed out (no pong) — host may be missing or not registered",
    };
  }
  if (info.version || info.msg) {
    return {
      ok: true,
      version: info.version,
      msg: info.msg,
    };
  }
  return { ok: false, error: "native host unreachable" };
}

/**
 * 识别 Chrome「Specified native messaging host not found」类错误。
 * @param {string} message
 */
export function isNativeHostMissingError(message) {
  const m = String(message || "").toLowerCase();
  return (
    m.includes("specified native messaging host not found") ||
    m.includes("native messaging host not found") ||
    m.includes("access to the specified native messaging host is forbidden") ||
    m.includes("host not found")
  );
}

/**
 * 把 Chrome 原生英文错误转成可执行的安装指引。
 * @param {string} message
 */
export function formatNativeHostError(message) {
  const raw = String(message || "").replace(/^Error:\s*/i, "").trim();
  if (isNativeHostMissingError(raw)) {
    return "本机尚未安装安能助手 Host。仅复制 extension 文件夹不能运行；请先运行配套安装包中的 install-host，再完全退出并重开 Chrome。";
  }
  return raw || "无法连接安能助手 Host。";
}
