import assert from 'node:assert/strict'
import { test, vi } from 'vite-plus/test'
import { Relay, TransportGateway } from '@nethernet-proxy/relay'
import type { Session, Direction, VerifiedSdpIdentity } from '@nethernet-proxy/relay'
import {
  LoginPacket,
  LoginTokens,
  PlayStatus,
  PlayStatusPacket,
  SetLocalPlayerAsInitializedPacket,
  StartGamePacket,
} from '@serenityjs/protocol'
import { NetherNetProxy } from '../src/index'
import type { Player, PlayerJoinEvent, PlayerLeaveEvent } from '../src/index'
import { loginIdentity } from '../src/identity'
import { setup } from '../../relay/test/helpers/relay'
import { encodePayload, fragmentPayload, uint } from '../../relay/src/framing'
import { serverIdentity, offer } from '../../relay/test/helpers/sdp'

// Minimal StartGame serialized by Serenity 0.8.21; includes its trailing optional/telemetry fields.
const startGameBytes = Buffer.from(
  '0b0e2a000000803f00008042000000400000000000000000000000000000000000000000000000000080010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000000000',
  'hex',
)
const jwt = (claims: unknown) =>
  `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
function login() {
  const packet = new LoginPacket()
  packet.protocol = 1000
  packet.tokens = new LoginTokens(
    jwt({ secret: 'not exposed' }),
    JSON.stringify({
      AuthenticationType: 0,
      Token: jwt({ xname: 'Alice', xid: '123', secret: 'not exposed' }),
    }),
  )
  return packet.serialize()
}
function success() {
  const packet = new PlayStatusPacket()
  packet.status = PlayStatus.LoginSuccess
  return packet.serialize()
}
function initialized(runtimeEntityId = 42n) {
  const packet = new SetLocalPlayerAsInitializedPacket()
  packet.runtimeEntityId = runtimeEntityId
  return packet.serialize()
}
function harness(withGateway = false) {
  const logs: Record<string, unknown>[] = []
  const relay = new Relay({
    serverUrl: 'http://127.0.0.1:1',
    clientSideIdentity: serverIdentity,
    log: (event, fields) => {
      logs.push({ event, ...fields })
    },
  })
  const sessions = new Map<string, Session>()
  vi.spyOn(relay, 'sessions', 'get').mockImplementation(() => new Map(sessions))
  const closeRelay = relay.close.bind(relay)
  vi.spyOn(relay, 'close').mockImplementation(async () => {
    for (const session of sessions.values()) await session.close('proxy_stopped')
    await closeRelay()
  })
  const proxy = new NetherNetProxy({ relay, gateway: withGateway ? {} : false })
  const add = (id = 1n, verifiedSignaling?: VerifiedSdpIdentity) => {
    const io = setup({}, id)
    if (verifiedSignaling)
      Object.defineProperty(io.session, 'verifiedSignaling', { value: verifiedSignaling })
    vi.spyOn(io.session, 'close').mockImplementation((reason = 'session_closed') => {
      if (io.session.closed) return Promise.resolve()
      io.session.dispose()
      sessions.delete(io.session.connectionId)
      relay.emit('sessionClose', io.session, reason)
      return Promise.resolve()
    })
    sessions.set(io.session.connectionId, io.session)
    relay.emit('sessionOpen', io.session)
    io.negotiate()
    const inject = (direction: Direction, ...packets: Buffer[]) => {
      const frames = fragmentPayload(
        encodePayload(packets, { algorithm: 'deflate', threshold: 1 }),
        17,
      )
      const offset = io.sent.length
      for (const frame of frames) io.session.receive(direction, 'reliable', frame)
      for (const [index, frame] of frames.entries())
        assert.equal(io.sent[offset + index].frame, frame)
    }
    return { ...io, inject }
  }
  return { relay, proxy, add, logs }
}

test('real packet observations produce Join → Spawn → Leave; duplicate packets, immutable snapshots and raw recovery', async () => {
  const h = harness()
  const order: string[] = []
  let joined!: PlayerJoinEvent
  let player!: Player
  let left!: PlayerLeaveEvent
  h.proxy.on('playerJoin', (event) => {
    joined = event
    assert.equal(h.proxy.players.size, 0)
    order.push('join')
  })
  h.proxy.on('playerSpawn', (event) => {
    player = event.player
    assert.equal(event.initialSpawn, true)
    assert.equal(h.proxy.getPlayer(player.connectionId), player)
    order.push('spawn')
  })
  h.proxy.on('playerLeave', (event) => {
    left = event
    assert.equal(h.proxy.players.size, 0)
    assert.ok(event.player?.closed)
    order.push('leave')
  })
  const a = h.add()
  a.inject('c2s', login(), login())
  a.inject('s2c', success(), success(), startGameBytes, startGameBytes)
  assert.deepEqual(order, ['join'])
  assert.equal(joined.protocol, 1000)
  assert.deepEqual(joined.identity.login, {
    source: 'login',
    verified: false,
    name: 'Alice',
    xuid: '123',
  })
  assert.ok(!JSON.stringify(joined.identity).includes('secret'))
  a.inject('c2s', initialized(), initialized())
  assert.deepEqual(order, ['join', 'spawn'])
  assert.equal(player.session, joined.session)
  assert.equal(player.identity, joined.identity)
  assert.deepEqual(player.initialState.position, { x: 1, y: 64, z: 2 })
  assert.ok(Object.isFrozen(player.initialState.position))
  const snapshot = h.proxy.players
  assert.equal(player.send(initialized()), 'sent')
  assert.equal(player.sendToServer(initialized()), 'sent')
  // No remaining hook: an opaque, undecodable steady-state frame is relayed without diagnostics.
  const opaque = Buffer.from([0, 0xde, 0xad])
  a.session.receive('c2s', 'reliable', opaque)
  a.session.receive('s2c', 'reliable', opaque)
  assert.deepEqual(a.errors, [])
  await player.close('bye')
  await player.close('again')
  h.relay.emit('sessionClose', a.session, 'duplicate')
  assert.deepEqual(order, ['join', 'spawn', 'leave'])
  assert.equal(left.player, player)
  assert.equal(left.reason, 'bye')
  assert.equal(snapshot.get('1'), player)
  assert.throws(() => player.send(initialized()), /player_closed/)
  assert.throws(() => player.sendToServer(initialized()), /player_closed/)
  await h.proxy.close()
})

test('pre-join disconnect, join without spawn, independent sessions and reconnection', async () => {
  const h = harness()
  const leaves: PlayerLeaveEvent[] = []
  h.proxy.on('playerLeave', (event) => {
    leaves.push(event)
  })
  const a = h.add()
  await a.session.close()
  assert.equal(leaves.length, 0)
  const b = h.add(2n)
  b.inject('s2c', success())
  await b.session.close('before_spawn')
  assert.equal(leaves.length, 1)
  assert.equal(leaves[0].player, undefined)
  const c = h.add(3n)
  const d = h.add(4n)
  c.inject('s2c', success(), startGameBytes)
  c.inject('c2s', initialized())
  d.inject('s2c', success())
  const firstPlayer = h.proxy.getPlayer('3')!
  await c.session.close()
  assert.equal(d.session.closed, false)
  const reconnect = h.add(3n)
  reconnect.inject('s2c', success(), startGameBytes)
  reconnect.inject('c2s', initialized())
  assert.notEqual(h.proxy.getPlayer('3'), firstPlayer)
  assert.equal(h.proxy.players.size, 1)
  await h.proxy.close()
  assert.equal(h.proxy.players.size, 0)
  assert.equal(leaves.length, 4)
  assert.equal(h.relay.listenerCount('sessionOpen'), 0)
})

test('invalid order, missing state, mismatched runtime IDs and malformed packets never create a Player', async () => {
  const differentStart = new StartGamePacket(Buffer.from(startGameBytes)).deserialize()
  differentStart.runtimeEntityId = 99n
  const sequences: [Direction, Buffer[]][][] = [
    [
      ['s2c', [startGameBytes, success()]],
      ['c2s', [initialized()]],
    ],
    [
      ['c2s', [initialized()]],
      ['s2c', [success(), startGameBytes]],
    ],
    [
      ['s2c', [success()]],
      ['c2s', [initialized()]],
    ],
    [
      ['s2c', [success(), startGameBytes]],
      ['c2s', [initialized(99n)]],
    ],
    [['s2c', [success(), uint(11)]]],
    [
      ['s2c', [success(), startGameBytes, differentStart.serialize()]],
      ['c2s', [initialized()]],
    ],
  ]
  for (const sequence of sequences) {
    const h = harness()
    const a = h.add()
    for (const [direction, packets] of sequence) a.inject(direction, ...packets)
    assert.equal(h.proxy.players.size, 0)
    assert.equal(a.session.closed, false)
    assert.ok(h.logs.some((log) => log.event === 'player_tracking_error'))
    await h.proxy.close()
  }
  // A missing Initialized alone is not a protocol failure: it remains joined without a Player.
  const h = harness()
  h.add().inject('s2c', success(), startGameBytes)
  assert.equal(h.proxy.players.size, 0)
  await h.proxy.close()
})

test('exceptions and rejected notification promises do not block siblings or teardown; close from listeners is safe', async () => {
  for (const event of ['playerJoin', 'playerSpawn'] as const) {
    const h = harness()
    const a = h.add()
    let leaves = 0
    h.proxy.on(event, () => {
      throw new Error('secret')
    })
    h.proxy.on(event, () => Promise.reject(new Error('secret')))
    h.proxy.on(event, () => {
      void a.session.close('from_listener')
    })
    h.proxy.on('playerLeave', () => {
      throw new Error('secret')
    })
    h.proxy.on('playerLeave', () => {
      leaves++
    })
    a.inject('s2c', success(), startGameBytes)
    if (event === 'playerSpawn') a.inject('c2s', initialized())
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(leaves, 1)
    assert.equal(h.proxy.players.size, 0)
    assert.ok(a.session.closed)
    assert.ok(!JSON.stringify(h.logs).includes('secret'))
    await h.proxy.close()
  }
  const h = harness()
  const a = h.add()
  h.proxy.on('playerJoin', () => {
    void h.proxy.close()
  })
  a.inject('s2c', success(), startGameBytes)
  assert.ok(a.session.closed)
  const forwarded = a.sent.length
  a.session.receive('c2s', 'reliable', Buffer.from([0, 0xde]))
  assert.equal(a.sent.length, forwarded)
  const close = h.proxy.close()
  assert.equal(h.proxy.close(), close)
  await close
  assert.ok(a.session.closed)
  assert.equal(h.proxy.players.size, 0)
})

test('identity decoding separates source/verification and does not synthesize absent values', () => {
  const certificate = JSON.stringify({
    chain: [
      jwt({
        extraData: { displayName: 'Offline', identity: 'actual-uuid', secret: 'not exposed' },
      }),
    ],
  })
  assert.deepEqual(loginIdentity(certificate), {
    source: 'login',
    verified: false,
    name: 'Offline',
    uuid: 'actual-uuid',
    xuid: undefined,
  })
  assert.equal(
    loginIdentity(JSON.stringify({ Token: '', Certificate: certificate })).name,
    'Offline',
  )
  for (const input of [
    'null',
    '{}',
    '{',
    JSON.stringify({ Token: 'invalid' }),
    JSON.stringify({ chain: [jwt({ extraData: null })] }),
  ])
    assert.throws(() => loginIdentity(input))
})

test('subclient packets do not initialize the main Player; transport and login identity remain separate', async () => {
  const h = harness()
  const a = h.add(1n, {
    sdpSha256: 'digest',
    xuid: '999',
    gamertag: 'TransportName',
    playFabId: 'playfab',
    publicKeyFingerprint: 'fingerprint',
    issuer: 'issuer',
    expiresAt: Date.now() / 1000 + 600,
  })
  const subclient = (bytes: Buffer) => Buffer.concat([uint(bytes[0] | 1024), bytes.subarray(1)])
  let joins = 0
  h.proxy.on('playerJoin', () => {
    joins++
  })
  a.inject('c2s', subclient(login()))
  a.inject('s2c', subclient(success()), subclient(startGameBytes))
  a.inject('c2s', subclient(initialized()))
  assert.equal(joins, 0)
  assert.equal(h.proxy.players.size, 0)
  a.inject('c2s', login())
  a.inject('s2c', success(), startGameBytes)
  a.inject('c2s', initialized())
  const player = h.proxy.getPlayer('1')!
  assert.equal(joins, 1)
  assert.equal(player.identity.login?.xuid, '123')
  assert.deepEqual(player.identity.transport, {
    source: 'signaling',
    verified: true,
    name: 'TransportName',
    xuid: '999',
    playFabId: 'playfab',
  })
  assert.ok(Object.isFrozen(player.identity.transport))
  await h.proxy.close()
})

test('gateway defaults, optional gateway, middleware before terminal handler, injection, listen and close', async () => {
  const options = { serverUrl: 'http://127.0.0.1:1', clientSideIdentity: serverIdentity }
  const proxy = new NetherNetProxy({
    ...options,
    gateway: {
      configure: (gateway) => {
        gateway.use('join', () => new Response('policy', { status: 403 }))
      },
    },
  })
  await proxy.listen(0, '127.0.0.1')
  const address = proxy.gateway!.server!.address() as { port: number }
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/join/1`, {
      method: 'POST',
      headers: { 'content-type': 'application/sdp' },
      body: await offer(),
    })
    assert.equal(response.status, 403)
    assert.equal(await response.text(), 'policy')
  } finally {
    await proxy.close()
  }
  await assert.rejects(proxy.listen(0), /proxy_closed/)
  const disabled = new NetherNetProxy({ ...options, gateway: false })
  await assert.rejects(disabled.listen(0), /gateway_disabled/)
  await disabled.close()
  const relay = new Relay(options)
  const gateway = new TransportGateway(relay)
  const injected = new NetherNetProxy({ relay, gateway })
  assert.equal(injected.gateway, gateway)
  await injected.close()
  const factory = new NetherNetProxy({
    ...options,
    gateway: (transport) => new TransportGateway(transport),
  })
  assert.equal(factory.gateway?.relay, factory.relay)
  await factory.close()
  const defaults = new NetherNetProxy(options)
  assert.ok(defaults.gateway)
  await defaults.close()
  const otherRelay = new Relay(options)
  const otherGateway = new TransportGateway(otherRelay)
  assert.throws(
    () => new NetherNetProxy({ relay, gateway: otherGateway }),
    /gateway_relay_mismatch/,
  )
  await Promise.all([otherGateway.close(), otherRelay.close()])
})

test('gateway teardown failure still closes relay, removes Players and detaches observers', async () => {
  const h = harness(true)
  const a = h.add()
  a.inject('s2c', success(), startGameBytes)
  a.inject('c2s', initialized())
  const player = h.proxy.getPlayer('1')!
  vi.spyOn(h.proxy.gateway!, 'close').mockRejectedValue(new Error('gateway_close_failed'))
  const closeRelay = vi.spyOn(h.relay, 'close')
  await assert.rejects(h.proxy.close(), /gateway_close_failed/)
  assert.equal(closeRelay.mock.calls.length, 1)
  assert.equal(h.relay.listenerCount('sessionOpen'), 0)
  assert.equal(h.proxy.players.size, 0)
  assert.ok(player.closed)
})
