export function classifyCodexLaunchState(processCount, trustedCdpEndpoint) {
  if (!Number.isInteger(processCount) || processCount < 0) {
    throw new RangeError('Codex进程数量无效');
  }
  if (processCount === 0) return 'not-running';
  return trustedCdpEndpoint ? 'cdp-ready' : 'ordinary-running';
}
