const CDP_ID = /^[A-Za-z0-9._-]{1,200}$/u;

/** CDP WebSocket地址只接受本机页面调试端点，避免误连到LAN或浏览器级接口。 */
export function validatedDebuggerUrl(endpoint, port) {
  const url = new URL(endpoint);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port
    || url.username || url.password || url.search || url.hash
    || !/^\/devtools\/page\/[A-Za-z0-9._-]{1,200}$/u.test(url.pathname)) {
    throw new Error('拒绝非回环Codex页面调试地址');
  }
  return url.href;
}

export function isCodexPageTarget(target, port) {
  if (target?.type !== 'page' || typeof target.id !== 'string' || !CDP_ID.test(target.id)
    || typeof target.url !== 'string' || !target.url.startsWith('app://')
    || typeof target.webSocketDebuggerUrl !== 'string') return false;
  try {
    const url = new URL(validatedDebuggerUrl(target.webSocketDebuggerUrl, port));
    return url.pathname === `/devtools/page/${target.id}`;
  } catch {
    return false;
  }
}

export async function listCodexPageTargets(port, fetchImpl = fetch) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('CDP端口无效');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, {
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`CDP目标查询失败：HTTP ${response.status}`);
    const body = await response.text();
    if (body.length > 512 * 1024) throw new Error('CDP目标列表超过大小限制');
    const targets = JSON.parse(body);
    if (!Array.isArray(targets)) throw new Error('CDP目标列表格式无效');
    return targets.filter((target) => isCodexPageTarget(target, port));
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 单个页面的轻量CDP会话。绑定消息事件后才发送enable命令，避免启动时丢包。
 */
export class CdpSession {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #eventListeners = new Map();
  #closed = false;

  constructor(target, port, WebSocketImpl = WebSocket) {
    this.target = target;
    this.#socket = new WebSocketImpl(validatedDebuggerUrl(target.webSocketDebuggerUrl, port));
  }

  get closed() {
    return this.#closed;
  }

  async open(timeoutMs = 5000) {
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('连接Codex CDP页面超时')), timeoutMs);
        this.#socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
        this.#socket.addEventListener('error', () => {
          clearTimeout(timeout);
          reject(new Error('连接Codex CDP页面失败'));
        }, { once: true });
      });
      this.#socket.addEventListener('message', (event) => this.#onMessage(event));
      this.#socket.addEventListener('close', () => this.#onClose());
      this.#socket.addEventListener('error', () => this.#onClose());
      await this.send('Runtime.enable');
      await this.send('Page.enable');
      return this;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  on(method, listener) {
    const listeners = this.#eventListeners.get(method) ?? new Set();
    listeners.add(listener);
    this.#eventListeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  send(method, params = {}, timeoutMs = 5000) {
    if (this.#closed || this.#socket.readyState !== 1) {
      return Promise.reject(new Error('Codex CDP页面连接已关闭'));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP命令超时：${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timeout, method });
      try {
        this.#socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  async evaluate(expression, executionContextId) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
      ...(executionContextId ? { contextId: executionContextId } : {}),
    });
    if (result.exceptionDetails) {
      throw new Error(`页面脚本执行失败：${result.exceptionDetails.text ?? '未知错误'}`);
    }
    return result.result?.value;
  }

  close() {
    if (!this.#closed) this.#socket.close();
    this.#onClose();
  }

  #onMessage(event) {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (Number.isInteger(message.id)) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(`CDP命令失败：${pending.method}`));
      else pending.resolve(message.result ?? {});
      return;
    }
    for (const listener of this.#eventListeners.get(message.method) ?? []) {
      try { listener(message.params ?? {}); } catch { /* 单个订阅者错误不应中断CDP接收 */ }
    }
  }

  #onClose() {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Codex CDP页面连接已关闭'));
    }
    this.#pending.clear();
  }
}
