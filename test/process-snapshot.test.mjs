import test from 'node:test';
import assert from 'node:assert/strict';
import { isExecutableProcess, parseProcessSnapshot } from '../src/process-snapshot.mjs';

test('keeps executable paths and launch arguments containing spaces intact', () => {
  const processes = parseProcessSnapshot(
    '  120  1 /Applications/Codex App.app/Contents/MacOS/Codex',
    '  120 /Applications/Codex App.app/Contents/MacOS/Codex --remote-debugging-address=127.0.0.1 --remote-debugging-port=9341',
  );
  assert.deepEqual(processes, [{
    pid: 120,
    ppid: 1,
    comm: '/Applications/Codex App.app/Contents/MacOS/Codex',
    command: '/Applications/Codex App.app/Contents/MacOS/Codex --remote-debugging-address=127.0.0.1 --remote-debugging-port=9341',
  }]);
});

test('ignores malformed process rows and leaves missing command lines empty', () => {
  assert.deepEqual(parseProcessSnapshot('garbage\n2 1 /bin/example', ''), [
    { pid: 2, ppid: 1, comm: '/bin/example', command: '' },
  ]);
});

test('matches the full executable path even when macOS comm is truncated', () => {
  const [process] = parseProcessSnapshot(
    '31560 1 /Applications/Co',
    '31560 /Applications/Codex.app/Contents/MacOS/ChatGPT',
  );
  assert.equal(isExecutableProcess(process, '/Applications/Codex.app/Contents/MacOS/ChatGPT'), true);
  assert.equal(isExecutableProcess(process, '/Applications/Codex.app/Contents/MacOS/Other'), false);
});
