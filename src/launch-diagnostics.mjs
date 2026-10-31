const MAX_DETAIL_LENGTH = 400;

/** 把open/spawn失败整理为单行日志摘要；只写入本机日志，不进入UI协议。 */
export function formatLaunchFailure(error) {
  const code = error?.code;
  const status = typeof code === 'number'
    ? `exit=${code}`
    : `error=${typeof code === 'string' && code ? code : 'unknown'}`;
  const output = [error?.stderr, error?.stdout]
    .filter((value) => typeof value === 'string' && value.trim())
    .join(' ')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, MAX_DETAIL_LENGTH);
  return output ? `${status} output=${JSON.stringify(output)}` : status;
}
