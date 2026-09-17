export const SESSION_STORE_KEY = "assistantSessionsV1";
const MAX_SESSIONS = 80;
const MAX_MESSAGES = 120;
const MAX_MESSAGE_CHARS = 30_000;
const MAX_STORE_BYTES = 7 * 1024 * 1024;

function now() {
  return new Date().toISOString();
}

function newId() {
  const random = globalThis.crypto?.randomUUID?.().slice(0, 8) || Math.random().toString(16).slice(2, 10);
  return `sc-${Date.now()}-${random}`;
}

function titleFromText(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  const chars = [...value];
  return chars.length > 40 ? `${chars.slice(0, 40).join("")}…` : value || "新对话";
}

function trimMessage(message) {
  return {
    role: String(message?.role || ""),
    text: [...String(message?.text || "")].slice(0, MAX_MESSAGE_CHARS).join(""),
  };
}

export function createSessionRepository(storage) {
  let writeQueue = Promise.resolve();

  async function readAll() {
    const data = await storage.get(SESSION_STORE_KEY);
    const store = data?.[SESSION_STORE_KEY];
    return store && typeof store === "object" && !Array.isArray(store) ? store : {};
  }

  function mutate(action) {
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      const store = await readAll();
      const result = await action(store);
      const ordered = Object.values(store).sort((a, b) =>
        String(b?.info?.updatedAt || "").localeCompare(String(a?.info?.updatedAt || ""))
      );
      for (const stale of ordered.slice(MAX_SESSIONS)) delete store[stale.info.id];
      while (new TextEncoder().encode(JSON.stringify(store)).byteLength > MAX_STORE_BYTES) {
        const sessions = Object.values(store).sort((a, b) =>
          String(a?.info?.updatedAt || "").localeCompare(String(b?.info?.updatedAt || ""))
        );
        if (sessions.length > 1) {
          delete store[sessions[0].info.id];
          continue;
        }
        const only = sessions[0];
        if (!only || only.messages.length <= 2) break;
        only.messages.splice(0, Math.min(2, only.messages.length - 2));
        only.info.numMessages = only.messages.length;
      }
      await storage.set({ [SESSION_STORE_KEY]: store });
      return result;
    });
    return writeQueue;
  }

  async function list(query = "", limit = 40) {
    await writeQueue.catch(() => {});
    const store = await readAll();
    const needle = String(query || "").trim().toLowerCase();
    return Object.values(store)
      .map((session) => session.info)
      .filter((info) => {
        if (!needle) return true;
        return `${info.title || ""} ${info.summary || ""} ${info.id || ""}`
          .toLowerCase()
          .includes(needle);
      })
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .slice(0, Math.max(1, Number(limit) || 40));
  }

  async function get(sessionId, limit = 80) {
    await writeQueue.catch(() => {});
    const store = await readAll();
    const session = store[String(sessionId || "")];
    if (!session) throw new Error("会话不存在。");
    return {
      info: session.info,
      messages: session.messages.slice(-Math.max(1, Number(limit) || 80)),
    };
  }

  async function history(sessionId) {
    if (!sessionId) return [];
    const { messages } = await get(sessionId, MAX_MESSAGES).catch(() => ({ messages: [] }));
    return messages.filter((message) => message.role === "user" || message.role === "assistant");
  }

  async function appendTurn(sessionId, turn) {
    return mutate((store) => {
      const id = String(sessionId || "").trim() || newId();
      const existing = store[id] || {
        info: { id, title: "新对话", createdAt: now() },
        messages: [],
      };
      const timestamp = now();
      const user = trimMessage({ role: "user", text: turn.user });
      const thinking = trimMessage({ role: "thinking", text: turn.thinking });
      const assistant = trimMessage({ role: "assistant", text: turn.assistant });
      if (user.text.trim()) existing.messages.push(user);
      if (thinking.text.trim()) existing.messages.push(thinking);
      if (assistant.text.trim()) existing.messages.push(assistant);
      existing.messages = existing.messages.slice(-MAX_MESSAGES);
      existing.info = {
        ...existing.info,
        id,
        title:
          !existing.info.title || existing.info.title === "新对话"
            ? titleFromText(turn.user)
            : existing.info.title,
        summary: assistant.text.trim() || user.text.trim(),
        cwd: String(turn.cwd || existing.info.cwd || ""),
        model: String(turn.model || existing.info.model || ""),
        updatedAt: timestamp,
        createdAt: existing.info.createdAt || timestamp,
        numMessages: existing.messages.length,
      };
      store[id] = existing;
      return existing;
    });
  }

  return { list, get, history, appendTurn };
}
