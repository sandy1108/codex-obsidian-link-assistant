import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLaunchFailure } from '../src/launch-diagnostics.mjs';

test('formats exit status and stderr on one line', () => {
  assert.equal(
    formatLaunchFailure({ code: 1, stderr: 'The application cannot be opened.\nReason: -10814\n' }),
    'exit=1 output="The application cannot be opened. Reason: -10814"',
  );
});

test('formats spawn errors without output', () => {
  assert.equal(formatLaunchFailure({ code: 'ENOENT' }), 'error=ENOENT');
  assert.equal(formatLaunchFailure(null), 'error=unknown');
});

test('truncates oversized output and collapses whitespace', () => {
  const formatted = formatLaunchFailure({ code: 2, stderr: `a\t\tb\n${'x'.repeat(500)}` });
  assert.ok(formatted.startsWith('exit=2 output="a b '));
  assert.ok(formatted.length < 460);
  assert.ok(!formatted.includes('\n'));
});
