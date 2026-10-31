import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProcessSnapshot } from '../src/process-snapshot.mjs';

test('keeps the operating system process start time aligned by PID', () => {
  const snapshot = parseProcessSnapshot(
    '  120  1 /Applications/Codex.app/Contents/MacOS/ChatGPT',
    '  120 /Applications/Codex.app/Contents/MacOS/ChatGPT --remote-debugging-port=9341',
    '  120 Sat Oct 31 12:34:56 2026',
  );
  assert.deepEqual(snapshot, [{
    pid: 120,
    ppid: 1,
    comm: '/Applications/Codex.app/Contents/MacOS/ChatGPT',
    command: '/Applications/Codex.app/Contents/MacOS/ChatGPT --remote-debugging-port=9341',
    processStartTime: 'Sat Oct 31 12:34:56 2026',
  }]);
});
