import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildQuotaRendererSource } from '../src/quota-renderer.mjs';

test('圆环只绑定Codex导航，并有完整重置时间和清理入口', () => {
  const source = buildQuotaRendererSource();
  assert.doesNotThrow(() => new vm.Script(source));
  assert.match(source, /nav\[aria-label=\\?"应用导航\\?"\]/u);
  assert.match(source, /insertBefore\(host, nav\.lastElementChild\)/u);
  assert.match(source, /dateStyle: 'long'/u);
  assert.match(source, /timeStyle: 'medium'/u);
  assert.match(source, /window\[key\] = \{ cleanup, setQuota \}/u);
});
