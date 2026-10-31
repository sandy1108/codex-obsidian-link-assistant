import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCodexRuntime } from '../src/main.mjs';

// inspect的每个分支都必须携带bundle/runtime，否则launch会把undefined传给open。
test('inspect carries bundle and signed runtime on the observed mode', async () => {
  const compatibility = JSON.parse(await readFile(
    new URL('../macOSApp/Resources/compatibility.json', import.meta.url), 'utf8',
  ));
  const runtime = createCodexRuntime({
    compatibility,
    vaultSettingsStore: {
      async read() {
        return {
          configured: true,
          errorCode: null,
          vaultRoot: '/tmp/vault',
          vaultName: 'vault',
          recommendedVaultRoot: '/tmp/vault',
        };
      },
    },
  });

  let inspected;
  try {
    inspected = await runtime.inspect();
  } catch (error) {
    if (error?.code === 'CODEX_NOT_FOUND') return;
    throw error;
  }

  assert.ok([
    'not-running', 'ordinary-running', 'cdp-ready', 'untrusted-cdp',
    'ambiguous', 'identity-unknown', 'incompatible', 'unknown',
  ].includes(inspected.mode), `unexpected mode: ${inspected.mode}`);
  assert.equal(typeof inspected.bundle, 'string');
  assert.ok(inspected.bundle.length > 0);
  assert.equal(typeof inspected.runtime?.executable, 'string');
  assert.ok(inspected.runtime.executable.length > 0);
});
