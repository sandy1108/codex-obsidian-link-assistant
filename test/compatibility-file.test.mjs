import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_COMPATIBILITY_BYTES, readCompatibilityManifest } from '../src/compatibility-file.mjs';

async function withDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-compatibility-'));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('reads a valid compatibility manifest', async () => {
  await withDirectory(async (directory) => {
    const manifestPath = path.join(directory, 'compatibility.json');
    const manifest = { bundleId: 'com.openai.codex', version: '1.2.3' };
    await writeFile(manifestPath, JSON.stringify(manifest));
    assert.deepEqual(await readCompatibilityManifest(manifestPath), manifest);
  });
});

test('fails closed for missing, malformed, oversized, and symlinked manifests', async () => {
  await withDirectory(async (directory) => {
    const missing = path.join(directory, 'missing.json');
    await assert.rejects(readCompatibilityManifest(missing), (error) => error.code === 'COMPATIBILITY_MISSING');

    const malformed = path.join(directory, 'malformed.json');
    await writeFile(malformed, '{broken');
    await assert.rejects(readCompatibilityManifest(malformed), (error) => error.code === 'COMPATIBILITY_MISSING');

    const oversized = path.join(directory, 'oversized.json');
    await writeFile(oversized, 'x'.repeat(MAX_COMPATIBILITY_BYTES + 1));
    await assert.rejects(readCompatibilityManifest(oversized), (error) => error.code === 'COMPATIBILITY_MISSING');

    const target = path.join(directory, 'target.json');
    await writeFile(target, '{"bundleId":"com.openai.codex"}');
    const linked = path.join(directory, 'linked.json');
    await symlink(target, linked);
    await assert.rejects(readCompatibilityManifest(linked), (error) => error.code === 'COMPATIBILITY_MISSING');
  });
});
