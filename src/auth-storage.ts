import { mkdir, chmod, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto'
import { persistentPrivateKey } from './cache-storage'
import type { CacheFactory } from 'prismarine-auth'

// One trusted local directory per proxy account. Never reads unrelated profiles.
export async function authStorage(directory?: string) {
  if (directory) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
  }
  const values = new Map<string, Record<string, unknown>>()
  const name = (cacheName: string) =>
    join(directory!, `${Buffer.from(cacheName).toString('hex')}.json`)
  async function get(cacheName: string) {
    if (!values.has(cacheName)) {
      let value: Record<string, unknown> = {}
      if (directory) {
        try {
          const parsed: unknown = JSON.parse(await readFile(name(cacheName), 'utf8'))
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error('invalid_auth_cache')
          value = parsed as Record<string, unknown>
          await chmod(name(cacheName), 0o600)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw new Error('auth_cache_read_failed')
        }
      }
      values.set(cacheName, value)
    }
    return values.get(cacheName)!
  }
  async function set(cacheName: string, value: Record<string, unknown>) {
    values.set(cacheName, value)
    if (!directory) return
    const temp = `${name(cacheName)}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    await rename(temp, name(cacheName))
  }
  const cache: CacheFactory = ({ cacheName }) => ({
    async reset() {
      await set(cacheName, {})
    },
    getCached: () => get(cacheName),
    setCached: (value) => set(cacheName, value),
    async setCachedPartial(value) {
      await set(cacheName, { ...(await get(cacheName)), ...value })
    },
  })
  let privateKey
  if (directory) {
    privateKey = await persistentPrivateKey(join(directory, 'transport-key.pem'))
  } else privateKey = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey
  if (privateKey.asymmetricKeyDetails?.namedCurve !== 'secp384r1')
    throw new Error('transport_key_requires_p384')
  return { cache, privateKey, publicKey: createPublicKey(privateKey) }
}
