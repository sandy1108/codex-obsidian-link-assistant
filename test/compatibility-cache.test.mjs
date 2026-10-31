import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCompatibilityCache } from '../src/compatibility-cache.mjs';

test('reuses the computed value until a tracked file changes', async () => {
  const states = new Map();
  const cache = createCompatibilityCache({ statFile: async (file) => states.get(file) ?? null });
  let computes = 0;
  const compute = async () => {
    computes += 1;
    return { value: computes };
  };

  states.set('/app.asar', 'ino:1:size:100');
  assert.deepEqual(await cache.getOrCompute(['/app.asar'], compute), { value: 1 });
  assert.deepEqual(await cache.getOrCompute(['/app.asar'], compute), { value: 1 });
  assert.equal(computes, 1);

  states.set('/app.asar', 'ino:1:size:101');
  assert.deepEqual(await cache.getOrCompute(['/app.asar'], compute), { value: 2 });
  assert.equal(computes, 2);

  states.delete('/app.asar');
  assert.deepEqual(await cache.getOrCompute(['/app.asar'], compute), { value: 3 });
});

test('invalidates when the tracked file set or content metadata changes on disk', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'compatibility-cache-'));
  try {
    const file = path.join(directory, 'app.asar');
    await writeFile(file, 'first');
    const cache = createCompatibilityCache();
    let computes = 0;
    const compute = async () => {
      computes += 1;
      return computes;
    };

    assert.equal(await cache.getOrCompute([file], compute), 1);
    assert.equal(await cache.getOrCompute([file], compute), 1);

    await writeFile(file, 'second-content');
    assert.equal(await cache.getOrCompute([file], compute), 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
