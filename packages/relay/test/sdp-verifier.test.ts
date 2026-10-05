import { test, beforeAll as before, afterAll as after } from 'vite-plus/test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { generateKeyPairSync } from 'node:crypto'
import { createMinecraftClientTokenVerifier } from 'nethernet-gateway/minecraft'
import { SignalStructure, SignalType } from 'nethernet'
import { createSdpVerifier, sdpHash } from '../src/sdp-verifier'
import { signSdpIdentity } from '../src/server-identity'
import { Relay } from '../src/relay'
import { identity, offer, signingKey, plainSdp, serverIdentity } from './helpers/sdp'

const http = createServer((_, res) => {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ keys: [signingKey] }))
})
let verify: ReturnType<typeof createSdpVerifier>
before(async () => {
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  verify = createSdpVerifier({
    verifyClientToken: createMinecraftClientTokenVerifier({
      jwksUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}/keys`,
    }),
  })
})
after(async () => {
  http.closeAllConnections()
  await new Promise<void>((resolve) => http.close(() => resolve()))
})

test('gateway functions validate signed token, fingerprint binding and immutable SDP digest', async () => {
  const sdp = await offer()
  const result = await verify(sdp)
  assert.equal(result.xuid, '123456789')
  assert.equal(result.gamertag, 'Test Player')
  assert.equal(result.playFabId, 'test-playfab')
  assert.equal(result.sdpSha256, sdpHash(sdp))
  assert.equal(result.publicKeyFingerprint.length, 64)
  assert.ok(Object.isFrozen(result))
  assert.ok(!JSON.stringify(result).includes('token'))
  assert.ok(!JSON.stringify(result).includes('assertion'))
})

for (const [name, claims] of [
  ['expired', { exp: 1 }],
  ['future nbf', { nbf: Math.floor(Date.now() / 1000) + 3600 }],
  ['wrong issuer', { iss: 'https://attacker.invalid/' }],
  ['wrong audience', { aud: 'other' }],
  ['missing expiry', { exp: undefined }],
  ['missing iat', { iat: undefined }],
  ['invalid XUID', { xid: 'not-an-xuid' }],
  ['numeric XUID', { xid: 123456789 }],
] as const)
  test(`reject ${name} token before accepting offer`, async () => {
    await assert.rejects(verify(await offer(claims)), /identity_verification_failed/)
  })

test('reject forged JWT even if SDP signature is valid', async () => {
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
  await assert.rejects(
    verify(signSdpIdentity(plainSdp, await identity({}, other.privateKey))),
    /identity_verification_failed/,
  )
})
test('accept legacy SPKI cpk as well as JWK cpk', async () => {
  const id = await identity()
  const { clientKeys } = await import('./helpers/sdp')
  const sdp = signSdpIdentity(
    plainSdp,
    await identity({
      cpk: clientKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    }),
  )
  assert.equal(
    (await verify(sdp)).publicKeyFingerprint,
    (await verify(signSdpIdentity(plainSdp, id))).publicKeyFingerprint,
  )
})
test('reject fingerprint replacement or wrong token cpk', async () => {
  const sdp = await offer()
  await assert.rejects(verify(sdp.replace('AA:AA', 'BB:BB')), /identity_verification_failed/)
  const other = generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
  await assert.rejects(
    verify(await offer({ cpk: other.publicKey.export({ format: 'jwk' }) })),
    /identity_verification_failed/,
  )
})
test('reject absent, duplicated or media-level SDP identity', async () => {
  await assert.rejects(verify(plainSdp), /identity_verification_failed/)
  const sdp = await offer()
  const line = sdp.split('\r\n').find((value) => value.startsWith('a=identity:'))!
  await assert.rejects(
    verify(sdp.replace(line, `${line}\r\n${line}`)),
    /identity_verification_failed/,
  )
  await assert.rejects(
    verify(sdp.replace(`${line}\r\n`, '') + line + '\r\n'),
    /identity_verification_failed/,
  )
  // HTTP size policy belongs to the gateway, not this identity adapter.
  const padded = (await offer()) + `a=x-padding:${'x'.repeat(256 * 1024)}\r\n`
  assert.equal((await verify(padded)).sdpSha256, sdpHash(padded))
})
test('reject missing fingerprints and unsupported client key curve', async () => {
  await assert.rejects(
    verify((await offer()).replace(/^a=fingerprint:.*\r\n/m, '')),
    /identity_verification_failed/,
  )
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  await assert.rejects(
    verify(await offer({ cpk: other.publicKey.export({ format: 'jwk' }) })),
    /identity_verification_failed/,
  )
})
test('unsigned offer creates no client connection, server connector or session', async () => {
  const logs: { event: string; fields: Record<string, unknown> }[] = []
  const relay = new Relay({
    clientSideIdentity: serverIdentity,
    serverUrl: 'http://127.0.0.1:1',
    log: (event, fields) => logs.push({ event, fields }),
  })
  const replies: SignalStructure[] = []
  try {
    await relay.clientEndpoint.handleOffer(
      new SignalStructure(SignalType.ConnectRequest, 1n, plainSdp, 2n),
      (reply) => replies.push(reply),
    )
    assert.equal(relay.clientEndpoint.connections.size, 0)
    assert.equal(relay.sessions.size, 0)
    assert.equal(replies[0].type, SignalType.ConnectError)
    assert.equal(replies[0].data, '37')
    assert.equal(logs[0].event, 'signaling_rejected')
  } finally {
    await relay.close()
  }
})
test('verified result for different SDP is rejected at transport boundary', async () => {
  const valid = await verify(await offer())
  const relay = new Relay({
    clientSideIdentity: serverIdentity,
    serverUrl: 'http://127.0.0.1:1',
    verifyOffer: async () => valid,
  })
  const replies: SignalStructure[] = []
  try {
    await relay.clientEndpoint.handleOffer(
      new SignalStructure(SignalType.ConnectRequest, 1n, plainSdp, 2n),
      (reply) => replies.push(reply),
    )
    assert.equal(relay.sessions.size, 0)
    assert.equal(relay.clientEndpoint.connections.size, 0)
    assert.equal(replies[0].data, '37')
  } finally {
    await relay.close()
  }
})
test('concurrent verification is bounded and failures do not leak exception text', async () => {
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const limited = createSdpVerifier({
    maxConcurrent: 1,
    verifyClientToken: async () => {
      await blocked
      throw new Error('secret-token-content')
    },
  })
  const sdp = await offer()
  const first = limited(sdp)
  await assert.rejects(limited(sdp), /verification_busy/)
  release()
  await assert.rejects(
    first,
    (error) => error instanceof Error && error.message === 'identity_verification_failed',
  )
})
