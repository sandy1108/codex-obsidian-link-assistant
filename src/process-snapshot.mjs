/** 将两次 ps 输出按 PID 合并；路径及参数正文保留空格，避免错误识别应用实例。 */
export function parseProcessSnapshot(identityRows, commandRows, startTimeRows = '') {
  const commands = new Map();
  for (const line of String(commandRows).split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/u);
    if (match) commands.set(Number(match[1]), match[2]);
  }
  const startTimes = new Map();
  for (const line of String(startTimeRows).split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/u);
    if (match) startTimes.set(Number(match[1]), match[2].trim());
  }
  return String(identityRows).split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u);
    if (!match) return [];
    const pid = Number(match[1]);
    const process = { pid, ppid: Number(match[2]), comm: match[3].trim(), command: commands.get(pid) ?? '' };
    const processStartTime = startTimes.get(pid);
    if (processStartTime) process.processStartTime = processStartTime;
    return [process];
  });
}

/** macOS ps 的 comm 列可能截断，进程身份必须比对完整 command 的可执行路径前缀。 */
export function isExecutableProcess(process, executable) {
  return typeof process?.command === 'string'
    && (process.command === executable || process.command.startsWith(`${executable} `));
}
