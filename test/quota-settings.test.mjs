import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createQuotaSettingsStore } from '../src/quota-settings.mjs';

test('刷新间隔默认5分钟，保存后读回且拒绝越界', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'quota-settings-'));
  try {
    const store = createQuotaSettingsStore({ stateRoot: root });
    assert.equal((await store.read()).refreshMinutes, 5);
    await store.save(12);
    assert.equal((await store.read()).refreshMinutes, 12);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'quota-settings.json'))), { version: 1, refreshMinutes: 12 });
    await assert.rejects(store.save(0));
    await assert.rejects(store.save(61));
    assert.equal((await store.read()).refreshMinutes, 12);
  } finally { await rm(root, { recursive: true, force: true }); }
});
