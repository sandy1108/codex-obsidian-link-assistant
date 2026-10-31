/**
 * 从Codex命令行提取调试端口。
 * 不要求命令行同时声明监听地址；端点是否真正可信仍由回环监听和进程归属校验决定。
 */
export function requestedDebuggingPorts(command) {
  if (typeof command !== 'string') return [];
  const ports = [];
  for (const match of command.matchAll(/--remote-debugging-port(?:=|\s+)(\d{1,5})(?=\s|$)/gu)) {
    const port = Number(match[1]);
    if (port >= 1024 && port <= 65535 && !ports.includes(port)) ports.push(port);
  }
  return ports;
}
