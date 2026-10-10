import { test, vi } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultCacheDirectory,
  persistentPrivateKey,
  proxyAuthDirectory,
} from '../src/cache-storage';
import { authStorage } from '../src/auth-storage';
import { loadServerIdentity } from '../src/server-identity';

test('proxy operator key persists with restricted permissions and concurrent creation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nethernet-cache-test-'));
  const path = join(root, 'cache', 'server-identity.pem');
  const keys = await Promise.all(Array.from({ length: 4 }, () => persistentPrivateKey(path)));
  const pem = keys[0].export({ type: 'pkcs8', format: 'pem' });
  for (const key of keys) assert.equal(key.export({ type: 'pkcs8', format: 'pem' }), pem);
  assert.equal((await persistentPrivateKey(path)).export({ type: 'pkcs8', format: 'pem' }), pem);
  assert.equal((await stat(join(root, 'cache'))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const identity = await loadServerIdentity(path);
  assert.equal(identity.domain, 'self');
  assert.ok(identity.token);
  const transport = await authStorage(join(root, 'cache', 'auth'));
  assert.notEqual(transport.privateKey.export({ type: 'pkcs8', format: 'pem' }), pem);
});

test('auth uses cache/auth and supports explicit directory and memory-only overrides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nethernet-auth-path-'));
  vi.stubEnv('AUTH_MEMORY_ONLY', undefined);
  vi.stubEnv('PROXY_AUTH_DIR', undefined);
  vi.stubEnv('PROXY_CACHE_DIR', undefined);
  try {
    assert.equal(await proxyAuthDirectory(), join(defaultCacheDirectory, 'auth'));
    vi.stubEnv('PROXY_CACHE_DIR', root);
    assert.equal(await proxyAuthDirectory(), join(root, 'auth'));
    vi.stubEnv('PROXY_AUTH_DIR', join(root, 'account'));
    assert.equal(await proxyAuthDirectory(), join(root, 'account'));
    vi.stubEnv('AUTH_MEMORY_ONLY', '1');
    assert.equal(await proxyAuthDirectory(), undefined);
  } finally {
    vi.unstubAllEnvs();
  }
});

test('corrupt operator key is rejected rather than silently rotated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nethernet-corrupt-key-'));
  const path = join(root, 'server-identity.pem');
  await writeFile(path, 'invalid-test-key');
  await assert.rejects(persistentPrivateKey(path));
  assert.equal(await readFile(path, 'utf8'), 'invalid-test-key');
});
