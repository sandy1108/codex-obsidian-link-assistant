import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { CdpSession, listCodexPageTargets } from './cdp-client.mjs';
import { resolveVaultFileHref } from './uri-policy.mjs';
import { buildRendererSource } from './renderer-patch.mjs';
import { classifyCodexLaunchState } from './launch-policy.mjs';
import { isExecutableProcess, parseProcessSnapshot } from './process-snapshot.mjs';
import { acquireAssistantLock } from './single-instance-lock.mjs';
import { compatibilityErrorCode } from './compatibility-policy.mjs';
import { isDirectExecution } from './entry-point.mjs';

const execFileAsync = promisify(execFile);
function runtimeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
const TEAM_ID = '2DC432GLL2';
const VAULT_NAME = 'ExampleVault';
const VAULT_ROOT = '/Users/example/ExampleVault';
export const ASSISTANT_STATE_ROOT = path.join(os.homedir(), 'Library/Application Support/CodexObsidianLinkAssistant');
const STATE_ROOT = ASSISTANT_STATE_ROOT;
const LOG_PATH = path.join(STATE_ROOT, 'assistant.log');
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

async function run(file, args, options = {}) {
  const { stdout = '', stderr = '' } = await execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 10000,
    maxBuffer: 1024 * 1024,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function log(event, detail = '') {
  await mkdir(STATE_ROOT, { recursive: true, mode: 0o700 });
  const line = `${new Date().toISOString()} ${event}${detail ? ` ${detail}` : ''}\n`;
  await appendFile(LOG_PATH, line, { mode: 0o600 });
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

function requestedPorts(command) {
  const match = command.match(/--remote-debugging-port(?:=|\s+)(\d{1,5})(?:\s|$)/u);
  if (!match || !command.includes('--remote-debugging-address=127.0.0.1')) return [];
  const port = Number(match[1]);
  return port >= 1024 && port <= 65535 ? [port] : [];
}

async function trustedEndpoint(processes, snapshot) {
  if (processes.length !== 1) return null;
  const [process] = processes;
  const ports = requestedPorts(process.command);
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
  await run('/usr/bin/open', ['-na', bundle, '--args',
    '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`]);
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

async function executeLinkAction(payload, port, session, executionContextId) {
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
  const obsidianUri = await resolveVaultFileHref(request.href, { vaultRoot: VAULT_ROOT, vaultName: VAULT_NAME });
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

async function attachTarget(target, port, vaultFileUrlPrefix) {
  const session = new CdpSession(target, port);
  const worldName = 'codex-obsidian-link-assistant-v1';
  const bindingName = `openObsidianNote${randomBytes(6).toString('hex')}`;
  const executionContexts = new Set();
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
      void executeLinkAction(payload, port, session, executionContextId);
    });
    await session.send('Runtime.addBinding', { name: bindingName, executionContextName: worldName });
    const source = buildRendererSource({ bindingName, vaultFileUrlPrefix });
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
      try { await session.evaluate('window.__codexObsidianLinkAssistantV1?.cleanup?.()', contextId); } catch {}
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
    async cleanup() {
      if (executionContexts.size) {
        const contextId = [...executionContexts][0];
        try {
          await session.evaluate('window.__codexObsidianLinkAssistantV1?.cleanup?.()', contextId);
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

async function supervise(bundle, runtime, port, { signal = null, onFirstPass = () => {} } = {}) {
  const vaultRoot = await realpath(VAULT_ROOT);
  const vaultFileUrlPrefix = new URL(`file://${vaultRoot.replace(/\/$/u, '')}/`).href;
  await log('assistant-starting', `codex=${await bundleValue(bundle, 'CFBundleShortVersionString')} port=${port}`);
  notify('正在连接Codex页面…');
  const endpoint = await waitForTrustedEndpoint(runtime.executable, port, 45000, { signal });
  let consecutiveErrors = 0;
  let firstPass = false;
  while (!stopping && !signal?.aborted) {
    try {
      const snapshot = await processSnapshot();
      if (findCodexProcesses(snapshot, runtime.executable).length === 0) {
        await log('codex-exited', 'assistant-stopping');
        break;
      }
      const current = await listCodexPageTargets(endpoint.port);
      const active = new Set(current.map((target) => target.id));
      for (const [id, record] of sessions) {
        if (!active.has(id) || record.session.closed) {
          await record.cleanup();
          sessions.delete(id);
        }
      }
      for (const target of current) {
        if (sessions.has(target.id)) continue;
        try {
          const record = await attachTarget(target, endpoint.port, vaultFileUrlPrefix);
          if (record) sessions.set(target.id, record);
        } catch { await log('target-rejected', 'reason=probe-or-injection-failed'); }
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
}

async function runAssistant() {
  const bundle = await findCodexBundle();
  if (stopping) return;
  const runtime = await verifySignedRuntime(bundle);
  if (stopping) return;
  const vaultRoot = await realpath(VAULT_ROOT);
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
  const vaultFileUrlPrefix = new URL(`file://${vaultRoot.replace(/\/$/u, '')}/`).href;
  await log('cdp-verified', `port=${selectedPort} targets=${endpoint.targets.length}`);
  await supervise(bundle, runtime, selectedPort);
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

function runtimeState({ codex, cdp, pageCount = 0, version, build, port = null, launchSource, errorCode = null }) {
  return {
    codex,
    cdp,
    pageCount,
    codexVersion: version ?? null,
    codexBuild: build ?? null,
    port,
    launchSource,
    errorCode,
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
export function createCodexRuntime({ compatibility } = {}) {
  let managedProcessFingerprint = null;
  let managedSupervisor = null;

  async function inspect() {
    let bundle;
    try { bundle = await findCodexBundle(); } catch { throw runtimeError('CODEX_NOT_FOUND'); }
    const bundleId = await bundleValue(bundle, 'CFBundleIdentifier');
    const runtime = await verifySignedRuntime(bundle);
    const [version, build, asarSha256] = await Promise.all([
      bundleValue(bundle, 'CFBundleShortVersionString'),
      bundleValue(bundle, 'CFBundleVersion'),
      fileSha256(path.join(bundle, 'Contents/Resources/app.asar')),
    ]);
    const compatibilityFailure = compatibilityErrorCode({
      bundleId,
      teamId: TEAM_ID,
      version,
      build,
      appAsarSha256: asarSha256,
      nodeMajor: runtime.major,
    }, compatibility);
    if (compatibilityFailure) {
      return {
        mode: compatibilityFailure === 'VERSION_UNSUPPORTED' ? 'incompatible' : 'unknown',
        processFingerprint: null,
        restoreAllowed: false,
        state: runtimeState({
          codex: 'unknown', cdp: 'unknown', version, build,
          launchSource: 'unknown', errorCode: compatibilityFailure,
        }),
      };
    }

    const snapshot = await processSnapshot();
    const processes = findCodexProcesses(snapshot, runtime.executable);
    if (processes.length > 1) {
      return {
        mode: 'ambiguous', processFingerprint: null, restoreAllowed: false,
        state: runtimeState({
          codex: 'running', cdp: 'unknown', version, build,
          launchSource: 'unknown', errorCode: 'PROCESS_AMBIGUOUS',
        }),
      };
    }
    if (processes.length === 0) {
      return {
        mode: 'not-running', processFingerprint: null, restoreAllowed: false,
        state: runtimeState({ codex: 'stopped', cdp: 'closed', version, build, launchSource: 'none' }),
      };
    }

    const [process] = processes;
    const endpoint = await trustedEndpoint(processes, snapshot);
    const configuredPorts = requestedPorts(process.command);
    const port = endpoint?.port ?? configuredPorts[0] ?? null;
    const fingerprint = processFingerprint(process, runtime.executable, port);
    if (!fingerprint) {
      return {
        mode: 'identity-unknown', processFingerprint: null, restoreAllowed: false,
        state: runtimeState({
          codex: 'running', cdp: endpoint ? 'verified' : 'closed', version, build, port,
          launchSource: 'unknown', errorCode: 'PROCESS_IDENTITY_UNAVAILABLE',
        }),
      };
    }
    if (configuredPorts.length > 0 && !endpoint) {
      return {
        mode: 'untrusted-cdp', processFingerprint: fingerprint, restoreAllowed: false,
        state: runtimeState({
          codex: 'running', cdp: 'unknown', version, build, port,
          launchSource: 'unknown', errorCode: 'CDP_UNTRUSTED',
        }),
      };
    }
    const launchedHere = Boolean(endpoint && managedProcessFingerprint === fingerprint);
    return {
      mode: endpoint ? 'cdp-ready' : 'ordinary-running',
      processFingerprint: fingerprint,
      restoreAllowed: launchedHere,
      state: runtimeState({
        codex: 'running', cdp: endpoint ? 'verified' : 'closed',
        pageCount: endpoint && managedSupervisor ? sessions.size : 0,
        version, build, port, launchSource: endpoint ? (launchedHere ? 'app' : 'external') : 'external',
      }),
      bundle,
      runtime,
      endpoint,
    };
  }

  async function startSupervisor(bundle, runtime, port) {
    if (managedSupervisor) return;
    const controller = new AbortController();
    let markReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => { markReady = resolve; rejectReady = reject; });
    const supervisor = { controller, done: null };
    supervisor.done = supervise(bundle, runtime, port, {
      signal: controller.signal,
      onFirstPass: markReady,
    }).catch((error) => {
      rejectReady(error);
      throw error;
    }).finally(() => {
      if (managedSupervisor === supervisor) managedSupervisor = null;
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

  async function launchEnhanced(bundle, runtime, expectedMode = 'not-running') {
    const beforeLaunch = await inspect();
    if (beforeLaunch.mode !== expectedMode) throw runtimeError('PROCESS_CHANGED');
    const port = await availablePort();
    const immediatelyBeforeLaunch = await inspect();
    if (immediatelyBeforeLaunch.mode !== expectedMode) throw runtimeError('PROCESS_CHANGED');
    await log('codex-launch-requested', `port=${port}`);
    await launchCodex(bundle, port);
    const endpoint = await waitForTrustedEndpoint(runtime.executable, port);
    const { processes } = await getOneProcess(runtime.executable);
    const fingerprint = processFingerprint(processes[0], runtime.executable, endpoint.port);
    if (!fingerprint) throw runtimeError('PROCESS_IDENTITY_UNAVAILABLE');
    managedProcessFingerprint = fingerprint;
    await startSupervisor(bundle, runtime, endpoint.port);
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

  return {
    inspect,
    async enable({ expectedFingerprint = null } = {}) {
      const current = await inspect();
      if (current.mode === 'ordinary-running' || current.mode === 'ambiguous'
        || current.mode === 'incompatible' || current.mode === 'identity-unknown'
        || current.mode === 'untrusted-cdp') {
        throw runtimeError(current.mode === 'ambiguous' ? 'PROCESS_AMBIGUOUS'
          : current.mode === 'incompatible' ? 'VERSION_UNSUPPORTED'
            : current.mode === 'untrusted-cdp' ? 'CDP_UNTRUSTED' : 'PROCESS_CHANGED');
      }
      if (expectedFingerprint !== current.processFingerprint) throw runtimeError('PROCESS_CHANGED');
      if (current.mode === 'not-running') return launchEnhanced(current.bundle, current.runtime);
      if (current.mode !== 'cdp-ready') throw runtimeError('STATE_UNAVAILABLE');
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
      return launchEnhanced(current.bundle, current.runtime);
    },
    async restoreOrdinary({ targetFingerprint, confirmed } = {}) {
      if (confirmed !== true) throw runtimeError('INVALID_CONFIRMATION');
      await stopSupervisor();
      const current = await inspect();
      if (current.mode !== 'cdp-ready' || !current.restoreAllowed
        || current.processFingerprint !== targetFingerprint) throw runtimeError('PROCESS_CHANGED');
      await quitVerifiedCodex(targetFingerprint, 'cdp-ready');
      managedProcessFingerprint = null;
      await run('/usr/bin/open', ['-a', current.bundle]);
      await waitForCodexProcess(current.runtime.executable);
      return await inspect();
    },
    async pause() {
      await stopSupervisor();
      return await inspect();
    },
    async resume() {
      const current = await inspect();
      if (current.mode !== 'cdp-ready') throw runtimeError('CDP_UNTRUSTED');
      await startSupervisor(current.bundle, current.runtime, current.state.port);
      return await inspect();
    },
    async shutdown() {
      await stopSupervisor();
      return await inspect();
    },
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
