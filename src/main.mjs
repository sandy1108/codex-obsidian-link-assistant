import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { CdpSession, listCodexPageTargets } from './cdp-client.mjs';
import { resolveVaultFileHref } from './uri-policy.mjs';
import { buildRendererSource } from './renderer-patch.mjs';
import { classifyCodexLaunchState } from './launch-policy.mjs';
import { isExecutableProcess, parseProcessSnapshot } from './process-snapshot.mjs';
import { acquireAssistantLock } from './single-instance-lock.mjs';
import {
  compatibilityErrorCode, compatibilityIdentityKey, forceCompatibilityErrorCode,
} from './compatibility-policy.mjs';
import { isDirectExecution } from './entry-point.mjs';
import { createVaultSettingsStore } from './vault-settings.mjs';
import { formatLaunchFailure } from './launch-diagnostics.mjs';
import { createCompatibilityCache } from './compatibility-cache.mjs';
import { requestedDebuggingPorts } from './cdp-args.mjs';
import { restorePrecondition } from './restore-policy.mjs';
import { createLogWriter } from './log-file.mjs';
import { readCompatibilityManifest } from './compatibility-file.mjs';
import { createLaunchOwnershipStore, isOwnedVerifiedProcess } from './launch-ownership.mjs';
import { createQuotaSettingsStore } from './quota-settings.mjs';
import { readQuotaSnapshot } from './quota.mjs';
import { buildQuotaRendererSource } from './quota-renderer.mjs';

const execFileAsync = promisify(execFile);
function runtimeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
const TEAM_ID = '2DC432GLL2';
export const ASSISTANT_STATE_ROOT = path.join(os.homedir(), 'Library/Application Support/CodexObsidianLinkAssistant');
const STATE_ROOT = ASSISTANT_STATE_ROOT;
const LOG_PATH = path.join(STATE_ROOT, 'assistant.log');
const logWriter = createLogWriter({ filePath: LOG_PATH });
const COMPATIBILITY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'macOSApp', 'Resources', 'compatibility.json',
);
const APP_CANDIDATES = [
  '/Applications/Codex.app',
  path.join(os.homedir(), 'Applications/Codex.app'),
  '/Applications/ChatGPT.app',
  path.join(os.homedir(), 'Applications/ChatGPT.app'),
];
const sessions = new Map();
const openDebounce = new Map();
let stopping = false;
let cliLock = null;
let sessionCleanupPromise = null;
// 签名与ASAR哈希只随bundle文件变化，按元数据缓存避免每次inspect都重算643 MB。
const compatibilityCache = createCompatibilityCache();

async function run(file, args, options = {}) {
  const { stdout = '', stderr = '' } = await execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 10000,
    maxBuffer: 1024 * 1024,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function log(event, detail = '') {
  const line = `${new Date().toISOString()} ${event}${detail ? ` ${detail}` : ''}\n`;
  await logWriter.append(line);
}

/** 追加一条单行日志；日志不可写时静默失败，不改变调用方结果。 */
export async function appendAssistantLog(event, detail = '') {
  try { await log(event, detail); } catch { /* 日志目录不可写时保持原流程 */ }
}

async function bundleValue(bundle, key) {
  const result = await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(bundle, 'Contents/Info.plist')]);
  return result.stdout;
}

async function findCodexBundle() {
  for (const candidate of APP_CANDIDATES) {
    try {
      if (await bundleValue(candidate, 'CFBundleIdentifier') === 'com.openai.codex') return candidate;
    } catch { /* 应用不在该位置，继续检查常见安装路径 */ }
  }
  throw new Error('找不到Bundle ID为com.openai.codex的桌面应用');
}

async function verifySignedRuntime(bundle) {
  if (await bundleValue(bundle, 'CFBundleIdentifier') !== 'com.openai.codex') {
    throw runtimeError('SIGNATURE_MISMATCH');
  }
  const executable = path.join(bundle, 'Contents/MacOS', await bundleValue(bundle, 'CFBundleExecutable'));
  const node = path.join(bundle, 'Contents/Resources/cua_node/bin/node');
  const requirement = `anchor apple generic and certificate leaf[subject.OU] = "${TEAM_ID}"`;
  try {
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--test-requirement', `=${requirement}`, bundle]);
    await run('/usr/bin/codesign', ['--verify', '--strict', '--test-requirement', `=${requirement}`, node]);
  } catch { throw runtimeError('SIGNATURE_MISMATCH'); }
  const { stdout: version } = await run(node, ['--version']);
  const major = Number(version.replace(/^v/u, '').split('.')[0]);
  if (!Number.isInteger(major) || major < 24) throw runtimeError('VERSION_UNSUPPORTED');
  return { executable, node, version, major };
}

async function processSnapshot() {
  // 分开读取数字列、完整命令和启动时间，避免路径含空格或PID复用造成身份误判。
  const [{ stdout: identityRows }, { stdout: commandRows }, { stdout: startTimeRows }] = await Promise.all([
    run('/bin/ps', ['-axo', 'pid=,ppid=,comm=']),
    run('/bin/ps', ['-ww', '-axo', 'pid=,command=']),
    run('/bin/ps', ['-axo', 'pid=,lstart=']),
  ]);
  return parseProcessSnapshot(identityRows, commandRows, startTimeRows);
}

function findCodexProcesses(snapshot, executable) {
  return snapshot.filter((process) => isExecutableProcess(process, executable));
}

async function listeners() {
  const { stdout } = await run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']);
  const output = [];
  let pid = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) output.push({ pid, address: line.slice(1) });
  }
  return output;
}

function isDescendantOrSelf(pid, rootPid, snapshot) {
  const byPid = new Map(snapshot.map((process) => [process.pid, process]));
  let current = pid;
  for (let depth = 0; depth < 32 && current > 1; depth += 1) {
    if (current === rootPid) return true;
    const record = byPid.get(current);
    if (!record || record.ppid === current) return false;
    current = record.ppid;
  }
  return false;
}

async function trustedEndpoint(processes, snapshot) {
  if (processes.length !== 1) return null;
  const [process] = processes;
  const ports = requestedDebuggingPorts(process.command);
  if (!ports.length) return null;
  const openListeners = await listeners();
  for (const port of ports) {
    const exact = openListeners.filter((listener) => listener.address === `127.0.0.1:${port}`
      && isDescendantOrSelf(listener.pid, process.pid, snapshot));
    if (!exact.length) continue;
    try {
      const targets = await listCodexPageTargets(port);
      if (targets.length) return { port, targets };
    } catch { /* 未能确认页面时不附着到该监听器 */ }
  }
  return null;
}

function askToRestart() {
  const script = `display dialog "Codex已经打开，但没有可验证的本地调试入口。请先确认当前任务已保存；我会请求Codex正常退出，并从桌面助手重新打开。" buttons {"取消", "正常退出并启用"} default button "取消" cancel button "取消" with title "Codex笔记链接助手"`;
  return run('/usr/bin/osascript', ['-e', script]).then(() => true, () => false);
}

async function requestNormalQuit(processes, executable) {
  const accepted = await askToRestart();
  if (!accepted || stopping) return false;
  await run('/usr/bin/osascript', ['-e', 'tell application id "com.openai.codex" to quit'], { timeout: 20000 });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const current = findCodexProcesses(await processSnapshot(), executable);
    if (current.length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Codex尚未正常退出，已停止启用且未强制结束进程');
}

async function availablePort() {
  const openListeners = await listeners();
  for (let port = 9341; port <= 9441; port += 1) {
    if (openListeners.some((listener) => listener.address.endsWith(`:${port}`))) continue;
    return port;
  }
  throw new Error('9341至9441端口均不可用');
}

async function launchCodex(bundle, port) {
  try {
    await run('/usr/bin/open', ['-na', bundle, '--args',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`]);
    try { await log('codex-launch-opened', `port=${port}`); } catch { /* 日志失败不改变启动结果 */ }
  } catch (error) {
    try {
      await log('codex-launch-failed', `bundle=${bundle} port=${port} ${formatLaunchFailure(error)}`);
    } catch { /* 日志失败不覆盖启动错误 */ }
    throw runtimeError('CODEX_LAUNCH_FAILED');
  }
}

async function waitForTrustedEndpoint(executable, port, timeoutMs = 45000, { signal = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !stopping && !signal?.aborted) {
    const snapshot = await processSnapshot();
    const processes = findCodexProcesses(snapshot, executable);
    const endpoint = await trustedEndpoint(processes, snapshot);
    if (endpoint?.port === port) return endpoint;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  if (stopping || signal?.aborted) {
    const error = new Error('助手正在停止');
    error.code = 'ASSISTANT_STOPPING';
    throw error;
  }
  try { await log('codex-launch-timeout', `port=${port}`); } catch { /* 日志失败不覆盖超时错误 */ }
  throw runtimeError('CDP_TIMEOUT');
}

function notify(message) {
  const safe = String(message).replace(/["\\\u0000-\u001f\u007f]/gu, '').slice(0, 160);
  spawn('/usr/bin/osascript', ['-e', `display notification "${safe}" with title "Codex笔记链接助手"`], {
    stdio: 'ignore',
    detached: true,
  }).unref();
}

// 只向固定的macOS剪贴板命令写入已经由Vault路径策略生成的URI，不经过shell。
function copyTextToClipboard(text) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] });
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error('剪贴板写入超时'));
    }, 5000);
    child.once('error', finish);
    child.once('close', (code) => finish(code === 0 ? null : new Error('剪贴板写入失败')));
    child.stdin.once('error', finish);
    child.stdin.end(text, 'utf8');
  });
}

async function executeLinkAction(payload, port, session, executionContextId, {
  vaultSettingsStore, targetRevision, getCurrentRevision,
}) {
  if (targetRevision !== getCurrentRevision()) return;
  if (typeof payload !== 'string' || payload.length > 8192) return;
  let request;
  try { request = JSON.parse(payload); } catch { return; }
  if (!request || typeof request !== 'object' || Array.isArray(request)) return;
  const keys = Object.keys(request);
  const legacyOpen = keys.length === 1 && keys[0] === 'href';
  const copyRequest = keys.length === 2 && keys.includes('action') && keys.includes('href');
  const tooltipRequest = keys.length === 3 && keys.includes('action') && keys.includes('href')
    && keys.includes('token');
  if ((!legacyOpen && !copyRequest && !tooltipRequest) || typeof request.href !== 'string') return;
  const action = legacyOpen ? 'open' : request.action;
  if (action !== 'open' && action !== 'copy' && action !== 'tooltip') return;
  if (action === 'open' && !legacyOpen) return;
  if (action === 'copy' && !copyRequest) return;
  if (action === 'tooltip' && (!tooltipRequest || typeof request.token !== 'string'
    || !/^tooltip-[1-9]\d{0,11}$/u.test(request.token))) return;
  const now = Date.now();
  if (action === 'open' && now - (openDebounce.get(request.href) ?? 0) < 1200) return;
  const settings = await vaultSettingsStore.read();
  if (!settings.configured || targetRevision !== getCurrentRevision()) return;
  const obsidianUri = await resolveVaultFileHref(request.href, {
    vaultRoot: settings.vaultRoot,
    vaultName: settings.vaultName,
  });
  if (targetRevision !== getCurrentRevision()) return;
  if (!obsidianUri) {
    if (action === 'tooltip') {
      const clearTitle = `window.__codexObsidianLinkAssistantV1?.setTooltip(${JSON.stringify(request.token)}, '')`;
      try { await session.evaluate(clearTitle, executionContextId); } catch {}
      return;
    }
    notify('链接不在指定Vault内，或目标笔记不存在。');
    await log(action === 'copy' ? 'copy-rejected' : 'open-rejected', 'reason=outside-vault-or-missing');
    return;
  }
  if (action === 'tooltip') {
    const setTitle = `window.__codexObsidianLinkAssistantV1?.setTooltip(${JSON.stringify(request.token)}, ${JSON.stringify(obsidianUri)})`;
    try { await session.evaluate(setTitle, executionContextId); } catch {}
    return;
  }
  if (action === 'copy') {
    try {
      await copyTextToClipboard(obsidianUri);
      notify('已复制Obsidian链接。');
      await log('copy-requested', `port=${port}`);
    } catch {
      notify('复制Obsidian链接失败，请检查剪贴板。');
      await log('copy-failed', 'reason=clipboard-write-failed');
    }
    return;
  }
  openDebounce.set(request.href, now);
  if (openDebounce.size > 128) openDebounce.delete(openDebounce.keys().next().value);
  try {
    await run('/usr/bin/open', [obsidianUri], { timeout: 10000 });
    notify('已将笔记交给Obsidian打开。');
    await log('open-requested', `port=${port}`);
  } catch {
    notify('macOS未能打开Obsidian链接，请检查Obsidian安装状态。');
    await log('open-failed', 'reason=open-command-failed');
  }
}

function probeExpression() {
  return `(() => location.protocol === 'app:' && Boolean(
    document.querySelector('[data-testid="app-shell-header-context-menu-surface"]') ||
    document.querySelector('[data-local-conversation-final-assistant]')
  ))()`;
}

async function attachTarget(target, port, vaultRoot, vaultSettingsStore, targetRevision, getCurrentRevision) {
  const session = new CdpSession(target, port);
  const worldName = 'codex-obsidian-link-assistant-v1';
  const bindingName = `openObsidianNote${randomBytes(6).toString('hex')}`;
  const executionContexts = new Set();
  let lastQuotaContextId = null;
  let lastQuotaJson = '';
  let mainFrameId = '';
  let scriptId = null;
  session.on('Runtime.executionContextCreated', ({ context }) => {
    if (context?.name === worldName && context.auxData?.frameId === mainFrameId
      && context.auxData?.isDefault === false) executionContexts.add(context.id);
  });
  session.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
    executionContexts.delete(executionContextId);
  });
  session.on('Runtime.executionContextsCleared', () => executionContexts.clear());
  try {
    await session.open();
    const verified = await session.evaluate(probeExpression());
    if (!verified) {
      session.close();
      return null;
    }
    const tree = await session.send('Page.getFrameTree');
    mainFrameId = tree.frameTree?.frame?.id ?? '';
    if (!mainFrameId) throw new Error('Codex主frame缺失');

    session.on('Runtime.bindingCalled', ({ name, payload, executionContextId }) => {
      if (name !== bindingName || !executionContexts.has(executionContextId)) return;
      void executeLinkAction(payload, port, session, executionContextId, {
        vaultSettingsStore, targetRevision, getCurrentRevision,
      });
    });
    await session.send('Runtime.addBinding', { name: bindingName, executionContextName: worldName });
    const source = `${buildRendererSource({ bindingName, vaultRoot })}\n${buildQuotaRendererSource()}`;
    const registered = await session.send('Page.addScriptToEvaluateOnNewDocument', {
      source,
      worldName,
      includeCommandLineAPI: false,
    });
    scriptId = registered.identifier ?? null;
    const isolated = await session.send('Page.createIsolatedWorld', {
      frameId: mainFrameId,
      worldName,
      grantUniveralAccess: false,
    });
    if (!executionContexts.has(isolated.executionContextId)) executionContexts.add(isolated.executionContextId);
    await session.evaluate(source, isolated.executionContextId);
  } catch (error) {
    const contextId = [...executionContexts][0];
    if (contextId) {
      try { await session.evaluate('window.__codexObsidianLinkAssistantV1?.cleanup?.(); window.__codexQuotaRingsV1?.cleanup?.()', contextId); } catch {}
    }
    if (scriptId) {
      try { await session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }); } catch {}
    }
    try { await session.send('Runtime.removeBinding', { name: bindingName }); } catch {}
    session.close();
    throw error;
  }

  return {
    session,
    async updateQuota(snapshot) {
      const contextId = [...executionContexts][0];
      if (!contextId) return;
      const json = JSON.stringify(snapshot);
      if (contextId === lastQuotaContextId && json === lastQuotaJson) return;
      try {
        await session.evaluate(`window.__codexQuotaRingsV1?.setQuota(${json})`, contextId);
        lastQuotaContextId = contextId;
        lastQuotaJson = json;
      } catch { /* 页面导航时旧context可能失效；下轮supervisor会重试 */ }
    },
    async cleanup() {
      if (executionContexts.size) {
        const contextId = [...executionContexts][0];
        try {
          await session.evaluate('window.__codexObsidianLinkAssistantV1?.cleanup?.(); window.__codexQuotaRingsV1?.cleanup?.()', contextId);
        } catch { /* 页面关闭时CDP无法再访问原上下文 */ }
      }
      if (scriptId) {
        try { await session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }); } catch {}
      }
      try { await session.send('Runtime.removeBinding', { name: bindingName }); } catch {}
      session.close();
    },
  };
}

async function cleanupSessions() {
  if (sessionCleanupPromise) return sessionCleanupPromise;
  sessionCleanupPromise = (async () => {
    for (const [id, record] of [...sessions]) {
      await record.cleanup();
      sessions.delete(id);
    }
  })();
  try { await sessionCleanupPromise; } finally { sessionCleanupPromise = null; }
}

async function stop() {
  stopping = true;
  await cleanupSessions();
}

function waitForInterval(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    let timer;
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

async function supervise(bundle, runtime, port, {
  signal = null, onFirstPass = () => {}, vaultSettingsStore,
  quotaSettingsStore = createQuotaSettingsStore({ stateRoot: ASSISTANT_STATE_ROOT }),
} = {}) {
  await log('assistant-starting', `codex=${await bundleValue(bundle, 'CFBundleShortVersionString')} port=${port}`);
  notify('正在连接Codex页面…');
  const endpoint = await waitForTrustedEndpoint(runtime.executable, port, 45000, { signal });
  let consecutiveErrors = 0;
  let firstPass = false;
  let codexExited = false;
  let lastQuotaPoll = 0;
  let quotaSnapshot = null;
  const cliPath = path.join(bundle, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  while (!stopping && !signal?.aborted) {
    try {
      const snapshot = await processSnapshot();
      if (findCodexProcesses(snapshot, runtime.executable).length === 0) {
        await log('codex-exited', 'assistant-stopping');
        codexExited = true;
        break;
      }
      const current = await listCodexPageTargets(endpoint.port);
      const settings = await vaultSettingsStore.read();
      const targetRevision = vaultSettingsStore.revision;
      const getCurrentRevision = () => vaultSettingsStore.revision;
      const active = new Set(current.map((target) => target.id));
      for (const [id, record] of sessions) {
        if (!active.has(id) || record.session.closed) {
          await record.cleanup();
          sessions.delete(id);
        }
      }
      for (const target of settings.configured ? current : []) {
        if (sessions.has(target.id)) continue;
        try {
          const record = await attachTarget(
            target, endpoint.port, settings.vaultRoot, vaultSettingsStore, targetRevision, getCurrentRevision,
          );
          if (record) sessions.set(target.id, record);
        } catch { await log('target-rejected', 'reason=probe-or-injection-failed'); }
      }
      if (sessions.size) {
        const { refreshMinutes } = await quotaSettingsStore.read();
        if (Date.now() - lastQuotaPoll >= refreshMinutes * 60_000) {
          lastQuotaPoll = Date.now();
          try { quotaSnapshot = await readQuotaSnapshot(cliPath); }
          catch {
            quotaSnapshot = null;
            await appendAssistantLog('quota-read-failed');
          }
        }
        for (const record of sessions.values()) await record.updateQuota(quotaSnapshot);
      }
      if (sessions.size) {
        if (consecutiveErrors) notify('Codex笔记链接已恢复。');
        consecutiveErrors = 0;
      } else {
        consecutiveErrors += 1;
      }
    } catch {
      consecutiveErrors += 1;
      if (consecutiveErrors === 1 || consecutiveErrors % 60 === 0) {
        await log('cdp-probe-failed', `count=${consecutiveErrors}`);
      }
    }
    if (!firstPass) {
      firstPass = true;
      onFirstPass();
    }
    if (consecutiveErrors === 1) notify('暂未识别Codex页面，笔记按钮尚未启用。');
    await waitForInterval(Math.min(5000, 1000 + consecutiveErrors * 500), signal);
  }
  await cleanupSessions();
  return { reason: codexExited ? 'codex-exited' : 'stopped' };
}

async function runAssistant() {
  // 旧CLI入口也必须先过兼容清单，避免绕过菜单App的版本/ASAR闸门。
  const compatibility = await readCompatibilityManifest(COMPATIBILITY_PATH);
  const bundle = await findCodexBundle();
  if (stopping) return;
  const runtime = await verifySignedRuntime(bundle);
  if (stopping) return;
  const installed = await installedCompatibilityFacts(bundle, runtime);
  const compatibilityFailure = compatibilityErrorCode(installed, compatibility);
  if (compatibilityFailure) {
    await log('legacy-compatibility-rejected', `code=${compatibilityFailure}`);
    throw runtimeError(compatibilityFailure);
  }
  const vaultSettingsStore = createVaultSettingsStore({ stateRoot: ASSISTANT_STATE_ROOT });
  const vaultSettings = await vaultSettingsStore.read();
  if (!vaultSettings.configured) throw runtimeError(vaultSettings.errorCode ?? 'VAULT_NOT_CONFIGURED');
  const snapshot = await processSnapshot();
  if (stopping) return;
  let processes = findCodexProcesses(snapshot, runtime.executable);
  let endpoint = await trustedEndpoint(processes, snapshot);
  const mode = classifyCodexLaunchState(processes.length, Boolean(endpoint));

  if (mode === 'ordinary-running') {
    if (stopping) return;
    if (!await requestNormalQuit(processes, runtime.executable)) {
      await log('start-cancelled', 'reason=user-cancelled');
      notify('已取消；Codex未被关闭。');
      return;
    }
    processes = [];
  } else if (processes.length > 1 && !endpoint) {
    throw new Error('检测到多个Codex进程，无法安全判断该连接哪个窗口');
  }

  if (!endpoint) {
    if (stopping) return;
    const port = await availablePort();
    if (stopping) return;
    await log('codex-launch-requested', `port=${port}`);
    if (stopping) return;
    await launchCodex(bundle, port);
    endpoint = await waitForTrustedEndpoint(runtime.executable, port);
  }
  if (stopping) return;
  const selectedPort = endpoint.port;
  await log('cdp-verified', `port=${selectedPort} targets=${endpoint.targets.length}`);
  await supervise(bundle, runtime, selectedPort, { vaultSettingsStore });
}

async function fileSha256(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

async function installedCompatibilityFacts(bundle, runtime) {
  const [version, build, asarSha256] = await Promise.all([
    bundleValue(bundle, 'CFBundleShortVersionString'),
    bundleValue(bundle, 'CFBundleVersion'),
    fileSha256(path.join(bundle, 'Contents/Resources/app.asar')),
  ]);
  return {
    bundleId: 'com.openai.codex',
    teamId: TEAM_ID,
    version,
    build,
    appAsarSha256: asarSha256,
    nodeMajor: runtime.major,
  };
}

function processFingerprint(process, executable, port) {
  if (!process?.processStartTime || !process.command) return null;
  return createHash('sha256').update(JSON.stringify({
    pid: process.pid,
    processStartTime: process.processStartTime,
    executable,
    command: process.command,
    port,
  })).digest('hex');
}

function runtimeState({
  codex, cdp, pageCount = 0, version, build, port = null, launchSource, errorCode = null,
  vaultConfigured = false, vaultRoot = null, vaultName = null, recommendedVaultRoot = null,
  quotaRefreshMinutes = 5, forceCompatible = false,
}) {
  return {
    codex,
    cdp,
    pageCount,
    codexVersion: version ?? null,
    codexBuild: build ?? null,
    port,
    launchSource,
    errorCode,
    vaultConfigured,
    vaultRoot,
    vaultName,
    recommendedVaultRoot,
    quotaRefreshMinutes,
    forceCompatible,
  };
}

async function getOneProcess(executable) {
  const snapshot = await processSnapshot();
  const processes = findCodexProcesses(snapshot, executable);
  if (processes.length > 1) throw runtimeError('PROCESS_AMBIGUOUS');
  return { snapshot, processes };
}

/**
 * 菜单App专用runtime。所有状态变更动作都先复核签名、版本、ASAR和唯一进程身份；
 * inspect只读取状态，不启动/退出Codex、不建立WebSocket或注入页面。
 */
export function createCodexRuntime({
  compatibility,
  vaultSettingsStore = createVaultSettingsStore({ stateRoot: ASSISTANT_STATE_ROOT }),
  quotaSettingsStore = createQuotaSettingsStore({ stateRoot: ASSISTANT_STATE_ROOT }),
  launchOwnershipStore = createLaunchOwnershipStore({ stateRoot: ASSISTANT_STATE_ROOT }),
  onSupervisorExit = null,
} = {}) {
  let managedProcessFingerprint = null;
  let managedSupervisor = null;
  let vaultSettings = null;
  let quotaRefreshMinutes = 5;
  // 一次性强兼容授权的身份键与放行标记，都只存活于当前worker会话内存。
  let forceCompatibilityKey = null;
  let forceCompatibilityActive = false;

  function stateFor(fields) {
    const selectedVaultRoot = vaultSettings?.vaultRoot ?? null;
    return runtimeState({
      ...fields,
      errorCode: fields.errorCode ?? vaultSettings?.errorCode ?? null,
      vaultConfigured: vaultSettings?.configured === true,
      vaultRoot: selectedVaultRoot,
      vaultName: vaultSettings?.vaultName ?? null,
      recommendedVaultRoot: vaultSettings?.recommendedVaultRoot ?? null,
      quotaRefreshMinutes,
      forceCompatible: forceCompatibilityActive,
    });
  }

  async function inspect() {
    vaultSettings = await vaultSettingsStore.read();
    quotaRefreshMinutes = (await quotaSettingsStore.read()).refreshMinutes;
    let bundle;
    try { bundle = await findCodexBundle(); } catch { throw runtimeError('CODEX_NOT_FOUND'); }
    const plistPath = path.join(bundle, 'Contents/Info.plist');
    const asarPath = path.join(bundle, 'Contents/Resources/app.asar');
    const nodePath = path.join(bundle, 'Contents/Resources/cua_node/bin/node');
    const executableName = await bundleValue(bundle, 'CFBundleExecutable');
    const compatibilityFacts = await compatibilityCache.getOrCompute([
      plistPath,
      path.join(bundle, 'Contents/MacOS', executableName),
      nodePath,
      asarPath,
    ], async () => {
      const bundleId = await bundleValue(bundle, 'CFBundleIdentifier');
      const runtime = await verifySignedRuntime(bundle);
      const facts = await installedCompatibilityFacts(bundle, runtime);
      return {
        bundleId,
        runtime,
        version: facts.version,
        build: facts.build,
        asarSha256: facts.appAsarSha256,
      };
    });
    const { bundleId, runtime, version, build, asarSha256 } = compatibilityFacts;
    const installedFacts = {
      bundleId,
      teamId: TEAM_ID,
      version,
      build,
      appAsarSha256: asarSha256,
      nodeMajor: runtime.major,
    };
    // 所有inspect结果都必须携带bundle/runtime，否则启动动作会把undefined传给open。
    // 身份键只在worker内部用于核验本次会话的强兼容授权，不进入UI协议。
    const withBundleRuntime = (fields) => ({
      ...fields, bundle, runtime, compatibilityIdentity: compatibilityIdentityKey(installedFacts),
    });
    // 清单本身不命中时，只有本次会话已授权且身份键仍一致才放行；授权不改变签名与Node下限。
    const listFailure = compatibilityErrorCode(installedFacts, compatibility);
    const compatibilityFailure = listFailure === null ? null : forceCompatibilityErrorCode({
      installed: installedFacts,
      approved: compatibility,
      authorizedKey: forceCompatibilityKey,
    });
    forceCompatibilityActive = listFailure !== null && compatibilityFailure === null;
    if (compatibilityFailure) {
      return withBundleRuntime({
        mode: compatibilityFailure === 'VERSION_UNSUPPORTED' ? 'incompatible' : 'unknown',
        processFingerprint: null,
        restoreAllowed: false,
        state: stateFor({
          codex: 'unknown', cdp: 'unknown', version, build,
          launchSource: 'unknown', errorCode: compatibilityFailure,
        }),
      });
    }

    const snapshot = await processSnapshot();
    const processes = findCodexProcesses(snapshot, runtime.executable);
    if (processes.length > 1) {
      return withBundleRuntime({
        mode: 'ambiguous', processFingerprint: null, restoreAllowed: false,
        state: stateFor({
          codex: 'running', cdp: 'unknown', version, build,
          launchSource: 'unknown', errorCode: 'PROCESS_AMBIGUOUS',
        }),
      });
    }
    if (processes.length === 0) {
      return withBundleRuntime({
        mode: 'not-running', processFingerprint: null, restoreAllowed: false,
        state: stateFor({ codex: 'stopped', cdp: 'closed', version, build, launchSource: 'none' }),
      });
    }

    const [process] = processes;
    const endpoint = await trustedEndpoint(processes, snapshot);
    const configuredPorts = requestedDebuggingPorts(process.command);
    const port = endpoint?.port ?? configuredPorts[0] ?? null;
    const fingerprint = processFingerprint(process, runtime.executable, port);
    if (!fingerprint) {
      return withBundleRuntime({
        mode: 'identity-unknown', processFingerprint: null, restoreAllowed: false,
        state: stateFor({
          codex: 'running', cdp: endpoint ? 'verified' : 'closed', version, build, port,
          launchSource: 'unknown', errorCode: 'PROCESS_IDENTITY_UNAVAILABLE',
        }),
      });
    }
    if (configuredPorts.length > 0 && !endpoint) {
      return withBundleRuntime({
        mode: 'untrusted-cdp', processFingerprint: fingerprint, restoreAllowed: false,
        state: stateFor({
          codex: 'running', cdp: 'unknown', version, build, port,
          launchSource: 'unknown', errorCode: 'CDP_UNTRUSTED',
        }),
      });
    }
    const launchedHere = Boolean(endpoint && (managedProcessFingerprint === fingerprint
      || await isOwnedVerifiedProcess({ endpoint, fingerprint, store: launchOwnershipStore })));
    return {
      ...withBundleRuntime({
        mode: endpoint ? 'cdp-ready' : 'ordinary-running',
        processFingerprint: fingerprint,
        restoreAllowed: launchedHere,
        state: stateFor({
          codex: 'running', cdp: endpoint ? 'verified' : 'closed',
          pageCount: endpoint && managedSupervisor ? sessions.size : 0,
          version, build, port, launchSource: endpoint ? (launchedHere ? 'app' : 'external') : 'external',
        }),
      }),
      endpoint,
    };
  }

  async function startSupervisor(bundle, runtime, port) {
    if (managedSupervisor) return;
    const controller = new AbortController();
    let markReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => { markReady = resolve; rejectReady = reject; });
    const supervisor = { controller, done: null, readyReached: false };
    supervisor.done = supervise(bundle, runtime, port, {
      signal: controller.signal,
      onFirstPass: () => {
        supervisor.readyReached = true;
        markReady();
      },
      vaultSettingsStore,
      quotaSettingsStore,
    }).catch(async (error) => {
      try { await log('supervisor-failed', `code=${error?.code ?? 'unexpected-error'}`); } catch { /* 日志失败不覆盖原错误 */ }
      rejectReady(error);
      throw error;
    }).finally(async () => {
      const wasCurrent = managedSupervisor === supervisor;
      if (wasCurrent) managedSupervisor = null;
      // 主动停止会先清空managedSupervisor；只有仍然当前的supervisor才算Codex意外退出。
      if (wasCurrent && !controller.signal.aborted && supervisor.readyReached) {
        managedProcessFingerprint = null;
        await launchOwnershipStore.forget().catch(() => {});
        try { onSupervisorExit?.({ reason: 'supervisor-exited' }); } catch { /* 状态回调失败不改变退出结果 */ }
      }
    });
    supervisor.done.catch(() => {});
    managedSupervisor = supervisor;
    await Promise.race([ready, supervisor.done.then(() => { throw runtimeError('CDP_UNTRUSTED'); })]);
  }

  async function stopSupervisor() {
    const supervisor = managedSupervisor;
    if (!supervisor) {
      await cleanupSessions();
      return;
    }
    supervisor.controller.abort();
    managedSupervisor = null;
    await supervisor.done.catch(() => {});
    await cleanupSessions();
  }

  async function launchWithCdp(bundle, runtime) {
    if (!bundle || !runtime?.executable) throw runtimeError('STATE_UNAVAILABLE');
    const beforeLaunch = await inspect();
    if (beforeLaunch.mode !== 'not-running') throw runtimeError('PROCESS_CHANGED');
    const port = await availablePort();
    const immediatelyBeforeLaunch = await inspect();
    if (immediatelyBeforeLaunch.mode !== 'not-running') throw runtimeError('PROCESS_CHANGED');
    await log('codex-launch-requested', `port=${port}`);
    await launchCodex(bundle, port);
    const endpoint = await waitForTrustedEndpoint(runtime.executable, port);
    const { processes } = await getOneProcess(runtime.executable);
    const fingerprint = processFingerprint(processes[0], runtime.executable, endpoint.port);
    if (!fingerprint) throw runtimeError('PROCESS_IDENTITY_UNAVAILABLE');
    managedProcessFingerprint = fingerprint;
    // 写盘失败时仍保留本进程内的已验证身份；跨App重启恢复则安全地不可用。
    await launchOwnershipStore.remember(fingerprint).catch(async () => {
      await log('launch-ownership-save-failed');
    });
    await log('cdp-verified', `port=${endpoint.port} source=app`);
    // 启动动作只把Codex带到可验证的CDP状态，注入留给connect动作。
    return await inspect();
  }

  async function quitVerifiedCodex(targetFingerprint, expectedMode) {
    const current = await inspect();
    if (current.mode !== expectedMode || current.processFingerprint !== targetFingerprint) {
      throw runtimeError('PROCESS_CHANGED');
    }
    await run('/usr/bin/osascript', ['-e', 'tell application id "com.openai.codex" to quit'], { timeout: 20000 });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const { processes } = await getOneProcess(current.runtime.executable);
      if (processes.length === 0) return;
      const fingerprint = processFingerprint(processes[0], current.runtime.executable,
        expectedMode === 'cdp-ready' ? current.state.port : null);
      if (fingerprint !== targetFingerprint) throw runtimeError('PROCESS_CHANGED');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw runtimeError('PROCESS_EXIT_TIMEOUT');
  }

  async function waitForCodexProcess(executable, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { processes } = await getOneProcess(executable);
      if (processes.length === 1) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw runtimeError('CODEX_LAUNCH_FAILED');
  }

  async function configureVault({ vaultRoot, wasActive }) {
    const previous = await vaultSettingsStore.read();
    const current = wasActive && managedSupervisor ? await inspect() : null;
    const saved = await vaultSettingsStore.save(vaultRoot);
    vaultSettings = saved;
    if (current && managedSupervisor) {
      await stopSupervisor();
      try {
        await startSupervisor(current.bundle, current.runtime, current.state.port);
      } catch {
        await stopSupervisor();
        try {
          if (!previous.configured) throw runtimeError('VAULT_APPLY_FAILED');
          await vaultSettingsStore.save(previous.vaultRoot);
          vaultSettings = await vaultSettingsStore.read();
          await startSupervisor(current.bundle, current.runtime, current.state.port);
        } catch {
          await stopSupervisor();
          throw runtimeError('VAULT_APPLY_FAILED');
        }
        throw runtimeError('INJECTION_FAILED');
      }
    }
    try { return await inspect(); }
    catch (error) {
      // 配置独立于Codex进程状态；即使Codex不可用，也把已保存配置回报给浮窗。
      return {
        state: stateFor({ codex: 'unknown', cdp: 'unknown', launchSource: 'unknown', errorCode: error?.code }),
      };
    }
  }

  return {
    inspect,
    async configureQuotaRefresh(refreshMinutes) {
      await quotaSettingsStore.save(refreshMinutes);
      quotaRefreshMinutes = refreshMinutes;
    },
    // 强兼容授权只能采纳本机实测算出的身份键，且只针对版本类失败；其余失败原样回报。
    async grantForceCompatibility() {
      const current = await inspect();
      if (current.state.errorCode !== 'VERSION_UNSUPPORTED'
        || typeof current.compatibilityIdentity !== 'string') {
        return current;
      }
      forceCompatibilityKey = current.compatibilityIdentity;
      return inspect();
    },
    async launch({ expectedFingerprint = null } = {}) {
      const current = await inspect();
      if (!current.state.vaultConfigured) throw runtimeError('VAULT_NOT_CONFIGURED');
      if (['ordinary-running', 'ambiguous', 'incompatible', 'identity-unknown', 'untrusted-cdp']
        .includes(current.mode)) {
        throw runtimeError(current.mode === 'ambiguous' ? 'PROCESS_AMBIGUOUS'
          : current.mode === 'incompatible' ? 'VERSION_UNSUPPORTED'
            : current.mode === 'untrusted-cdp' ? 'CDP_UNTRUSTED'
              : current.mode === 'identity-unknown' ? 'PROCESS_IDENTITY_UNAVAILABLE' : 'PROCESS_CHANGED');
      }
      if (current.mode === 'cdp-ready') return current;
      if (expectedFingerprint !== current.processFingerprint) throw runtimeError('PROCESS_CHANGED');
      if (current.mode !== 'not-running') throw runtimeError('STATE_UNAVAILABLE');
      return launchWithCdp(current.bundle, current.runtime);
    },
    async connect() {
      const current = await inspect();
      if (!current.state.vaultConfigured) throw runtimeError('VAULT_NOT_CONFIGURED');
      if (current.mode !== 'cdp-ready') {
        throw runtimeError(current.mode === 'ambiguous' ? 'PROCESS_AMBIGUOUS' : 'CDP_UNTRUSTED');
      }
      await startSupervisor(current.bundle, current.runtime, current.state.port);
      return await inspect();
    },
    async confirmRestart({ targetFingerprint } = {}) {
      const current = await inspect();
      if (current.mode !== 'ordinary-running' || current.processFingerprint !== targetFingerprint) {
        throw runtimeError('PROCESS_CHANGED');
      }
      await quitVerifiedCodex(targetFingerprint, 'ordinary-running');
      managedProcessFingerprint = null;
      await launchOwnershipStore.forget().catch(() => {});
      return launchWithCdp(current.bundle, current.runtime);
    },
    async restoreOrdinary({ targetFingerprint, confirmed } = {}) {
      if (confirmed !== true) throw runtimeError('INVALID_CONFIRMATION');
      // 先确认仍可恢复再撤掉注入，避免目标已变化时先破坏当前增强。
      const before = await inspect();
      const beforeFailure = restorePrecondition(before, targetFingerprint);
      if (beforeFailure) throw runtimeError(beforeFailure);
      await stopSupervisor();
      const after = await inspect();
      const afterFailure = restorePrecondition(after, targetFingerprint);
      if (afterFailure) throw runtimeError(afterFailure);
      await quitVerifiedCodex(targetFingerprint, 'cdp-ready');
      managedProcessFingerprint = null;
      await launchOwnershipStore.forget().catch(() => {});
      await run('/usr/bin/open', ['-a', after.bundle]);
      await waitForCodexProcess(after.runtime.executable);
      return await inspect();
    },
    async pause() {
      await stopSupervisor();
      return await inspect();
    },
    async resume() {
      const current = await inspect();
      if (!current.state.vaultConfigured) throw runtimeError('VAULT_NOT_CONFIGURED');
      if (current.mode !== 'cdp-ready') throw runtimeError('CDP_UNTRUSTED');
      await startSupervisor(current.bundle, current.runtime, current.state.port);
      return await inspect();
    },
    async shutdown() {
      await stopSupervisor();
      return await inspect();
    },
    configureVault,
  };
}

export async function getCurrentProcessStartTime() {
  const { stdout } = await run('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)]);
  if (!stdout) {
    const error = new Error('无法确认助手进程身份');
    error.code = 'PROCESS_IDENTITY_UNAVAILABLE';
    throw error;
  }
  return stdout;
}

async function main() {
  cliLock = await acquireAssistantLock({
    stateRoot: STATE_ROOT,
    pid: process.pid,
    processStartTime: await getCurrentProcessStartTime(),
    token: randomBytes(32).toString('hex'),
  });
  try {
    await runAssistant();
  } finally {
    await cliLock.release();
    cliLock = null;
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  // 信号只触发清理；等待主流程结束后由finally释放共享锁。
  let cliCompletionPromise;
  function handleStopSignal() {
    stopping = true;
    void stop().finally(async () => {
      try { await cliCompletionPromise; } catch { /* 启动失败时main()会先释放锁 */ }
      process.exit(0);
    });
  }
  process.on('SIGINT', handleStopSignal);
  process.on('SIGTERM', handleStopSignal);
  process.on('uncaughtException', (error) => {
    void log('fatal', error?.code ?? 'unexpected-error').finally(async () => {
      await stop();
      notify('助手发生错误，详情保存在本机日志。');
      await cliLock?.release();
      process.exit(1);
    });
  });

  cliCompletionPromise = main();
  cliCompletionPromise.catch(async (error) => {
    if (error?.code === 'ASSISTANT_STOPPING') return;
    await log('startup-failed', error?.code ?? 'precondition-or-startup-failed');
    notify('启动失败，请查看本机日志并按RECOVER.md恢复。');
    await stop();
    process.exitCode = 1;
  });
}
