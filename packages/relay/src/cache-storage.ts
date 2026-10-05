import { chmod, link, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createPrivateKey, generateKeyPairSync, randomUUID } from 'node:crypto';

// Installed packages may be read-only; persistent credentials belong to the caller.
export const defaultCacheDirectory = resolve(process.cwd(), 'cache');

export async function secureDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function proxyCacheDirectory() {
  const directory = process.env.PROXY_CACHE_DIR ?? defaultCacheDirectory;
  await secureDirectory(directory);
  return directory;
}

export async function proxyAuthDirectory() {
  if (process.env.AUTH_MEMORY_ONLY === '1') return undefined;
  if (process.env.PROXY_AUTH_DIR) return process.env.PROXY_AUTH_DIR;
  const directory = await proxyCacheDirectory();
  return join(directory, 'auth');
}

/** Publish a complete key atomically; concurrent initializers reuse the winner. */
export async function persistentPrivateKey(path: string) {
  await secureDirectory(dirname(path));
  if (!(await exists(path))) {
    const key = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey;
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, key.export({ type: 'pkcs8', format: 'pem' }), {
        mode: 0o600,
        flag: 'wx',
      });
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  await chmod(path, 0o600);
  const key = createPrivateKey(await readFile(path));
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'secp384r1')
    throw new Error('identity_key_requires_p384');
  return key;
}
