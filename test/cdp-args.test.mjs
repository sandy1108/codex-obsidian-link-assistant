import test from 'node:test';
import assert from 'node:assert/strict';
import { requestedDebuggingPorts } from '../src/cdp-args.mjs';

test('reads a debugging port even when the address flag is absent', () => {
  assert.deepEqual(
    requestedDebuggingPorts('/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9341'),
    [9341],
  );
  assert.deepEqual(
    requestedDebuggingPorts('Codex --remote-debugging-port 9342 --other-flag'),
    [9342],
  );
});

test('deduplicates multiple ports and ignores out-of-range values', () => {
  assert.deepEqual(
    requestedDebuggingPorts('Codex --remote-debugging-port=9341 --remote-debugging-port=9341'),
    [9341],
  );
  assert.deepEqual(requestedDebuggingPorts('Codex --remote-debugging-port=80'), []);
  assert.deepEqual(requestedDebuggingPorts('Codex --remote-debugging-port=70000'), []);
});

test('ignores unrelated flags and non-string commands', () => {
  assert.deepEqual(requestedDebuggingPorts('Codex --remote-debugging-pipe'), []);
  assert.deepEqual(requestedDebuggingPorts('Codex --remote-debugging-portx=9341'), []);
  assert.deepEqual(requestedDebuggingPorts(null), []);
  assert.deepEqual(requestedDebuggingPorts(undefined), []);
});
