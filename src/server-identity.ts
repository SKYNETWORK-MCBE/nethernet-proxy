import { createPrivateKey, createPublicKey, sign, KeyObject } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Identity } from 'nethernet'
import { join } from 'node:path'
import { persistentPrivateKey, proxyCacheDirectory } from './cache-storage'

function encoded(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

// Proxy operator identity-signing key, independent of DTLS and authentication toward the server.
export async function loadServerIdentity(path: string): Promise<Identity> {
  const privateKey = createPrivateKey(await readFile(path))
  return renewServerIdentity({ privateKey, token: '', domain: 'self' })
}

export async function proxyServerIdentity(): Promise<Identity> {
  const override = process.env.PROXY_IDENTITY_KEY ?? process.env.BDS_IDENTITY_KEY
  if (override) return loadServerIdentity(override)
  const privateKey = await persistentPrivateKey(
    join(await proxyCacheDirectory(), 'server-identity.pem'),
  )
  return renewServerIdentity({ privateKey, token: '', domain: 'self' })
}

export function renewServerIdentity(identity: Identity): Identity {
  const privateKey =
    identity.privateKey instanceof KeyObject
      ? identity.privateKey
      : createPrivateKey(identity.privateKey)
  if (
    privateKey.type !== 'private' ||
    privateKey.asymmetricKeyDetails?.namedCurve !== 'secp384r1'
  ) {
    throw new Error('server_identity_requires_p384')
  }
  const publicKey = createPublicKey(privateKey)
  const now = Math.floor(Date.now() / 1000)
  const header = encoded({
    alg: 'ES384',
    x5u: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  })
  const claims = encoded({ cpk: publicKey.export({ format: 'jwk' }), iat: now, exp: now + 60 })
  const input = `${header}.${claims}`
  const signature = sign('sha384', Buffer.from(input), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url')
  return { privateKey, token: `${input}.${signature}`, domain: identity.domain ?? 'self' }
}

export function signSdpIdentity(sdp: string, identity: Identity): string {
  const fingerprints = [...sdp.matchAll(/^a=fingerprint:(\S+)\s+([^\r\n]+)\r?$/gm)].map(
    (match) => ({ algorithm: match[1], digest: match[2] }),
  )
  if (!fingerprints.length) throw new Error('missing_sdp_fingerprint')
  const payload = encoded({ fingerprint: fingerprints })
  const header = encoded({ alg: 'ES384' })
  const signature = sign('sha384', Buffer.from(`${header}.${payload}`), {
    key:
      identity.privateKey instanceof KeyObject
        ? identity.privateKey
        : createPrivateKey(identity.privateKey),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url')
  const assertion = JSON.stringify({
    fingerprints: `${header}..${signature}`,
    token: identity.token,
  })
  const attribute = Buffer.from(
    JSON.stringify({ assertion, idp: { domain: identity.domain ?? 'self', protocol: 'default' } }),
  ).toString('base64')
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n'
  const lines = sdp.split(/\r?\n/).filter((line) => !line.startsWith('a=identity:'))
  const index = lines.findIndex((line) => line.startsWith('m='))
  lines.splice(index < 0 ? lines.length : index, 0, `a=identity:${attribute}`)
  return lines.join(eol)
}
