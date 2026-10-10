import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authStorage } from '../src/auth-storage';

test('auth cache and key survive restart with restricted permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nethernet-auth-test-'));
  const one = await authStorage(directory);
  const cache = one.cache({ cacheName: 'test', username: 'probe' });
  await cache.setCached({ dummy: 'not-a-real-token' });
  await cache.setCachedPartial({ expiry: 123 });
  const two = await authStorage(directory);
  assert.deepEqual(await two.cache({ cacheName: 'test', username: 'probe' }).getCached(), {
    dummy: 'not-a-real-token',
    expiry: 123,
  });
  assert.deepEqual(
    one.publicKey.export({ type: 'spki', format: 'der' }),
    two.publicKey.export({ type: 'spki', format: 'der' }),
  );
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const path of await readdir(directory))
    assert.equal((await stat(join(directory, path))).mode & 0o777, 0o600);
  await two.cache({ cacheName: 'test', username: 'probe' }).reset();
  assert.deepEqual(await two.cache({ cacheName: 'test', username: 'probe' }).getCached(), {});
});
