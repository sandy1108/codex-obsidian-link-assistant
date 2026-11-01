import { spawn } from 'node:child_process';

/** 只取Codex普通额度窗口；不把账号信息或上游原始对象交给渲染页。 */
export function parseQuotaResponse(response, fetchedAt = Date.now()) {
  const buckets = response?.rateLimitsByLimitId;
  const source = buckets && typeof buckets === 'object' && !Array.isArray(buckets)
    ? (buckets.codex ?? response.rateLimits) : response?.rateLimits;
  const result = { fiveHour: null, weekly: null, fetchedAt };
  for (const window of [source?.primary, source?.secondary]) {
    if (!window || !Number.isInteger(window.usedPercent)
      || window.usedPercent < 0 || window.usedPercent > 100
      || !Number.isSafeInteger(window.resetsAt) || window.resetsAt <= 0) continue;
    const parsed = { remainingPercent: 100 - window.usedPercent, resetsAt: window.resetsAt };
    if (window.windowDurationMins === 300) result.fiveHour = parsed;
    if (window.windowDurationMins === 10080) result.weekly = parsed;
  }
  return result;
}

/** 一次性只读app-server调用；超时和协议异常均拒绝，绝不保留原始响应。 */
export function readQuotaSnapshot(cliPath, { timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => finish(new Error('额度读取超时')), timeoutMs);
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      if (error) reject(error);
      else resolve(value);
    };
    child.once('error', finish);
    child.stdin.on('error', finish);
    child.once('close', () => finish(new Error('额度服务提前退出')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 256 * 1024) return finish(new Error('额度响应过大'));
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { return finish(new Error('额度协议响应无效')); }
        if (message.id === 1) {
          if (!message.result) return finish(new Error('额度协议初始化失败'));
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } });
        } else if (message.id === 2) {
          if (!message.result || !message.result.accountId) return finish(new Error('额度账户不可用'));
          finish(null, parseQuotaResponse(message.result));
          return;
        }
      }
    });
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'codex-obsidian-link-assistant', version: '0.1.8' },
      capabilities: { experimentalApi: true },
    } });
  });
}
