import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test, vi } from 'vite-plus/test';
import { Relay, TransportGateway } from '@nethernet-proxy/relay';
import type { ISession, Direction, VerifiedSdpIdentity } from '@nethernet-proxy/relay';
import {
  LoginPacket,
  LoginTokens,
  PlayStatus,
  PlayStatusPacket,
  SetLocalPlayerAsInitializedPacket,
  StartGamePacket,
} from '@serenityjs/protocol';
import { Bossbar, NetherNetProxy } from '../src/index';
import { PlayerSkin } from '../src/index';
import type {
  Player,
  PlayerJoinEvent,
  PlayerLeaveEvent,
  PlayerSkinChangeEvent,
} from '../src/index';
import { loginIdentity } from '../src/identity';
import { setup } from '../../relay/test/helpers/relay';
import { encodePayload, fragmentPayload, uint } from '../../relay/src/framing';
import { serverIdentity, offer } from '../../relay/test/helpers/sdp';
import { Authentication } from '@bedrock-apis/carolina-authentication';
import { verifyLoginClientData } from '../src/client-data';
import { PlayerSkinPacket, readPlayerSkinPacket } from '../src/protocol';
import type { ClientData } from '../src/index';

const clientKeys = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
const serviceKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const originalFetch = globalThis.fetch;
vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
  const address = url instanceof Request ? url.url : typeof url === 'string' ? url : url.href;
  if (address === 'https://authorization.franchise.minecraft-services.net/.well-known/keys')
    return Promise.resolve(
      new Response(
        JSON.stringify({
          keys: [
            {
              ...serviceKeys.publicKey.export({ format: 'jwk' }),
              kid: 'test-service',
              alg: 'RS256',
              use: 'sig',
            },
          ],
        }),
      ),
    );
  return originalFetch(url, options);
});
const deviceData = {
  DeviceModel: 'Test device',
  DeviceOS: 7,
} satisfies Partial<ClientData>;
const signalingIdentity: VerifiedSdpIdentity = {
  sdpSha256: 'digest',
  xuid: '123',
  gamertag: 'TransportName',
  playFabId: 'signaling-playfab',
  publicKeyFingerprint: 'fingerprint',
  issuer: 'issuer',
  expiresAt: Date.now() / 1000 + 600,
};
function signedClient(claims: unknown) {
  const body = `${Buffer.from(JSON.stringify({ alg: 'ES384', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  return `${body}.${sign('sha384', Buffer.from(body), { key: clientKeys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
function signedLogin(claims: unknown = deviceData) {
  const data = `${Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-service' })).toString('base64url')}.${Buffer.from(JSON.stringify({ xname: 'Alice', xid: '123', mid: 'playfab', cpk: clientKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), iss: 'https://authorization.franchise.minecraft-services.net/', aud: 'api://auth-minecraft-services/multiplayer', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')}`;
  const token = `${data}.${sign('RSA-SHA256', Buffer.from(data), serviceKeys.privateKey).toString('base64url')}`;
  const packet = new LoginPacket();
  packet.protocol = 1000;
  packet.tokens = new LoginTokens(
    signedClient(claims),
    JSON.stringify({ AuthenticationType: 0, Token: token }),
  );
  return packet;
}

// Minimal StartGame serialized by Serenity 0.8.21; includes its trailing optional/telemetry fields.
// Derived from SerenityJS (MIT); see ../THIRD_PARTY_NOTICES.md.
const startGameBytes = Buffer.from(
  '0b0e2a000000803f00008042000000400000000000000000000000000000000000000000000000000080010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000000000',
  'hex',
);
const jwt = (claims: unknown) =>
  `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
function login() {
  const packet = new LoginPacket();
  packet.protocol = 1000;
  packet.tokens = new LoginTokens(
    jwt({ secret: 'not exposed' }),
    JSON.stringify({
      AuthenticationType: 0,
      Token: jwt({ xname: 'Alice', xid: '123', secret: 'not exposed' }),
    }),
  );
  return packet.serialize();
}
function success() {
  const packet = new PlayStatusPacket();
  packet.status = PlayStatus.LoginSuccess;
  return packet.serialize();
}
function initialized(runtimeEntityId = 42n) {
  const packet = new SetLocalPlayerAsInitializedPacket();
  packet.runtimeEntityId = runtimeEntityId;
  return packet.serialize();
}
function harness(
  withGateway = false,
  loginOptions: {
    loginTimeoutMs?: number;
    maxPendingLogins?: number;
    requireClientData?: boolean;
  } = {},
) {
  const logs: Record<string, unknown>[] = [];
  const proxy = new NetherNetProxy({
    serverUrl: 'http://127.0.0.1:1',
    clientSideIdentity: serverIdentity,
    gateway: withGateway ? {} : false,
    requireClientData: false,
    ...loginOptions,
    log: (event, fields) => {
      logs.push({ event, ...fields });
    },
  });
  const relay = proxy.relay;
  const sessions = new Map<string, ISession>();
  vi.spyOn(relay, 'sessions', 'get').mockImplementation(() => new Map(sessions));
  const closeRelay = relay.close.bind(relay);
  vi.spyOn(relay, 'close').mockImplementation(async () => {
    for (const session of sessions.values()) await session.close('proxy_stopped');
    await closeRelay();
  });
  const add = (id = 1n, verifiedSignaling?: VerifiedSdpIdentity) => {
    const io = setup({}, id);
    if (verifiedSignaling)
      Object.defineProperty(io.session, 'verifiedSignaling', { value: verifiedSignaling });
    vi.spyOn(io.session, 'close').mockImplementation((reason = 'session_closed') => {
      if (io.session.closed) return Promise.resolve();
      io.session.dispose();
      sessions.delete(io.session.connectionId);
      relay.emit('sessionClose', io.session, reason);
      return Promise.resolve();
    });
    sessions.set(io.session.connectionId, io.session);
    relay.emit('sessionOpen', io.session);
    io.negotiate();
    const inject = (direction: Direction, ...packets: Buffer[]) => {
      const frames = fragmentPayload(
        encodePayload(packets, { algorithm: 'deflate', threshold: 1 }),
        17,
      );
      const offset = io.sent.length;
      for (const frame of frames) io.session.receive(direction, 'reliable', frame);
      for (const [index, frame] of frames.entries())
        assert.equal(io.sent[offset + index].frame, frame);
    };
    return { ...io, inject };
  };
  return { relay, proxy, add, logs };
}

test('real packet observations produce Join → Spawn → Leave; duplicate packets, immutable snapshots and raw recovery', async () => {
  const h = harness();
  const order: string[] = [];
  let joined!: PlayerJoinEvent;
  let player!: Player;
  let left!: PlayerLeaveEvent;
  h.proxy.on('playerJoin', (event) => {
    joined = event;
    assert.equal(h.proxy.players.size, 0);
    order.push('join');
  });
  h.proxy.on('playerSpawn', (event) => {
    player = event.player;
    assert.equal(event.initialSpawn, true);
    assert.equal(h.proxy.getPlayer(player.connectionId), player);
    order.push('spawn');
  });
  h.proxy.on('playerLeave', (event) => {
    left = event;
    assert.equal(h.proxy.players.size, 0);
    assert.ok(event.player && !event.player.isValid);
    order.push('leave');
  });
  const a = h.add();
  a.inject('c2s', login(), login());
  await new Promise((resolve) => setImmediate(resolve));
  a.inject('s2c', success(), success(), startGameBytes, startGameBytes);
  assert.deepEqual(order, ['join']);
  assert.equal(joined.protocol, 1000);
  assert.deepEqual(joined.identity, {
    verified: false,
    name: 'Alice',
    xuid: '123',
    persistentId: undefined,
  });
  assert.ok(!JSON.stringify(joined.identity).includes('secret'));
  a.inject('c2s', initialized(), initialized());
  assert.deepEqual(order, ['join', 'spawn']);
  assert.equal(player.session, joined.session);
  assert.equal(player.identity, joined.identity);
  assert.equal(player.xuid, '123');
  assert.equal(player.name, 'Alice');
  assert.throws(() => player.persistentId, /Failed to read player identity/);
  assert.deepEqual(player.initialState.position, { x: 1, y: 64, z: 2 });
  assert.ok(Object.isFrozen(player.initialState.position));
  const snapshot = h.proxy.players;
  const packet = new SetLocalPlayerAsInitializedPacket(initialized()).deserialize();
  assert.equal(player.send(packet), 'sent');
  assert.equal(player.sendToServer(packet), 'sent');
  // No remaining s2c hook: an opaque, undecodable steady-state frame is relayed without diagnostics.
  // c2s stays observed for PlayerSkin changes, so the same frame is reported but still forwarded.
  const opaque = Buffer.from([0, 0xde, 0xad]);
  a.session.receive('s2c', 'reliable', opaque);
  assert.deepEqual(a.errors, []);
  a.session.receive('c2s', 'reliable', opaque);
  assert.equal(a.session.closed, false);
  const bar = new Bossbar();
  bar.show(player);
  await player.close('bye');
  assert.equal(bar.players.size, 0);
  assert.equal(player.bossbars.size, 0);
  await player.close('again');
  h.relay.emit('sessionClose', a.session, 'duplicate');
  assert.deepEqual(order, ['join', 'spawn', 'leave']);
  assert.equal(left.player, player);
  assert.equal(left.reason, 'bye');
  assert.equal(snapshot.get('1'), player);
  assert.throws(() => player.send(packet), /player_closed/);
  assert.throws(() => player.sendToServer(packet), /player_closed/);
  await h.proxy.close();
});

test('initial spawn does not depend on decoding the unused StartGame tail', async () => {
  const prefix = Buffer.concat([
    startGameBytes.subarray(0, 34),
    Buffer.from('056f6365616e04', 'hex'), // Biome name "ocean", dimension 2; no generator/tail.
  ]);
  assert.throws(() => new StartGamePacket(Buffer.from(prefix)).deserialize());
  for (const tail of [Buffer.alloc(0), Buffer.from([0xff, 0xff, 0xff])]) {
    const h = harness();
    const a = h.add();
    a.inject('s2c', success(), Buffer.concat([prefix, tail]));
    a.inject('c2s', initialized());
    assert.deepEqual(h.proxy.getPlayer('1')?.initialState, {
      entityId: 7n,
      runtimeEntityId: 42n,
      gamemode: 0,
      position: { x: 1, y: 64, z: 2 },
      dimension: 2,
      pitch: 0,
      yaw: 0,
    });
    assert.deepEqual(h.logs, []);
    await h.proxy.close();
  }
});

test('pre-join disconnect, join without spawn, independent sessions and reconnection', async () => {
  const h = harness();
  const leaves: PlayerLeaveEvent[] = [];
  h.proxy.on('playerLeave', (event) => {
    leaves.push(event);
  });
  const a = h.add();
  await a.session.close();
  assert.equal(leaves.length, 0);
  const b = h.add(2n);
  b.inject('s2c', success());
  await b.session.close('before_spawn');
  assert.equal(leaves.length, 1);
  assert.equal(leaves[0].player, undefined);
  const c = h.add(3n);
  const d = h.add(4n);
  c.inject('s2c', success(), startGameBytes);
  c.inject('c2s', initialized());
  d.inject('s2c', success());
  const firstPlayer = h.proxy.getPlayer('3')!;
  await c.session.close();
  assert.equal(d.session.closed, false);
  const reconnect = h.add(3n);
  reconnect.inject('s2c', success(), startGameBytes);
  reconnect.inject('c2s', initialized());
  assert.notEqual(h.proxy.getPlayer('3'), firstPlayer);
  assert.equal(h.proxy.players.size, 1);
  await h.proxy.close();
  assert.equal(h.proxy.players.size, 0);
  assert.equal(leaves.length, 4);
  assert.equal(h.relay.listenerCount('sessionOpen'), 0);
});

test('invalid order, missing state, mismatched runtime IDs and malformed packets never create a Player', async () => {
  const differentStart = new StartGamePacket(Buffer.from(startGameBytes)).deserialize();
  differentStart.runtimeEntityId = 99n;
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
    [['s2c', [success(), startGameBytes.subarray(0, 35)]]],
    [['s2c', [success(), Buffer.concat([startGameBytes.subarray(0, 35), Buffer.from([0x80])])]]],
    [
      ['s2c', [success(), startGameBytes, differentStart.serialize()]],
      ['c2s', [initialized()]],
    ],
  ];
  for (const sequence of sequences) {
    const h = harness();
    const a = h.add();
    for (const [direction, packets] of sequence) a.inject(direction, ...packets);
    assert.equal(h.proxy.players.size, 0);
    assert.equal(a.session.closed, false);
    assert.ok(h.logs.some((log) => log.event === 'player_tracking_error'));
    await h.proxy.close();
  }
  // A missing Initialized alone is not a protocol failure: it remains joined without a Player.
  const h = harness();
  h.add().inject('s2c', success(), startGameBytes);
  assert.equal(h.proxy.players.size, 0);
  await h.proxy.close();
});

test('exceptions and rejected notification promises do not block siblings or teardown; close from listeners is safe', async () => {
  for (const event of ['playerJoin', 'playerSpawn'] as const) {
    const h = harness();
    const a = h.add();
    let leaves = 0;
    h.proxy.on(event, () => {
      throw new Error('secret');
    });
    h.proxy.on(event, () => Promise.reject(new Error('secret')));
    h.proxy.on(event, () => {
      void a.session.close('from_listener');
    });
    h.proxy.on('playerLeave', () => {
      throw new Error('secret');
    });
    h.proxy.on('playerLeave', () => {
      leaves++;
    });
    a.inject('s2c', success(), startGameBytes);
    if (event === 'playerSpawn') a.inject('c2s', initialized());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(leaves, 1);
    assert.equal(h.proxy.players.size, 0);
    assert.ok(a.session.closed);
    assert.ok(!JSON.stringify(h.logs).includes('secret'));
    await h.proxy.close();
  }
  const h = harness();
  const a = h.add();
  h.proxy.on('playerJoin', () => {
    void h.proxy.close();
  });
  a.inject('s2c', success(), startGameBytes);
  assert.ok(a.session.closed);
  const forwarded = a.sent.length;
  a.session.receive('c2s', 'reliable', Buffer.from([0, 0xde]));
  assert.equal(a.sent.length, forwarded);
  const close = h.proxy.close();
  assert.equal(h.proxy.close(), close);
  await close;
  assert.ok(a.session.closed);
  assert.equal(h.proxy.players.size, 0);
});

test('identity decoding remains unverified and does not synthesize absent values', () => {
  const certificate = JSON.stringify({
    chain: [
      jwt({
        extraData: { displayName: 'Offline', identity: 'actual-uuid', secret: 'not exposed' },
      }),
    ],
  });
  assert.deepEqual(loginIdentity(certificate), {
    verified: false,
    name: 'Offline',
    uuid: 'actual-uuid',
    xuid: undefined,
  });
  assert.equal(
    loginIdentity(JSON.stringify({ Token: '', Certificate: certificate })).name,
    'Offline',
  );
  for (const input of [
    'null',
    '{}',
    '{',
    JSON.stringify({ Token: 'invalid' }),
    JSON.stringify({ chain: [jwt({ extraData: null })] }),
  ])
    assert.throws(() => loginIdentity(input));
});

test('subclients are ignored and a matching signaling XUID does not authenticate an unverified Login', async () => {
  const h = harness();
  const a = h.add(1n, signalingIdentity);
  const subclient = (bytes: Buffer) => Buffer.concat([uint(bytes[0] | 1024), bytes.subarray(1)]);
  let joins = 0;
  h.proxy.on('playerJoin', () => {
    joins++;
  });
  a.inject('c2s', subclient(login()));
  a.inject('s2c', subclient(success()), subclient(startGameBytes));
  a.inject('c2s', subclient(initialized()));
  assert.equal(joins, 0);
  assert.equal(h.proxy.players.size, 0);
  a.inject('c2s', login());
  await new Promise((resolve) => setImmediate(resolve));
  a.inject('s2c', success(), startGameBytes);
  a.inject('c2s', initialized());
  const player = h.proxy.getPlayer('1')!;
  assert.equal(joins, 1);
  assert.equal(player.xuid, '123');
  assert.equal(player.name, 'Alice');
  assert.throws(() => player.persistentId, /Failed to read player identity/);
  assert.equal(player.identity.verified, false);
  assert.equal(player.session.verifiedSignaling, signalingIdentity);
  assert.ok(Object.isFrozen(player.identity));
  await h.proxy.close();
});

test('gateway defaults, optional gateway, middleware before terminal handler, factory, listen and close', async () => {
  const options = { serverUrl: 'http://127.0.0.1:1', clientSideIdentity: serverIdentity };
  const proxy = new NetherNetProxy({
    ...options,
    gateway: {
      configure: (gateway) => {
        gateway.use('join', () => new Response('policy', { status: 403 }));
      },
    },
  });
  await proxy.listen(0, '127.0.0.1');
  const address = proxy.gateway!.server!.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/join/1`, {
      method: 'POST',
      headers: { 'content-type': 'application/sdp' },
      body: await offer(),
    });
    assert.equal(response.status, 403);
    assert.equal(await response.text(), 'policy');
  } finally {
    await proxy.close();
  }
  await assert.rejects(proxy.listen(0), /proxy_closed/);
  const disabled = new NetherNetProxy({ ...options, gateway: false });
  await assert.rejects(disabled.listen(0), /gateway_disabled/);
  await disabled.close();
  const factory = new NetherNetProxy({
    ...options,
    gateway: (transport) => new TransportGateway(transport),
  });
  assert.equal(factory.gateway?.relay, factory.relay);
  await factory.close();
  const defaults = new NetherNetProxy(options);
  assert.ok(defaults.gateway);
  await defaults.close();
  const otherRelay = new Relay(options);
  const otherGateway = new TransportGateway(otherRelay);
  assert.throws(
    () => new NetherNetProxy({ ...options, gateway: otherGateway }),
    /gateway_relay_mismatch/,
  );
  await Promise.all([otherGateway.close(), otherRelay.close()]);
});

test('gateway teardown failure still closes relay, removes Players and detaches observers', async () => {
  const h = harness(true);
  const a = h.add();
  a.inject('s2c', success(), startGameBytes);
  a.inject('c2s', initialized());
  const player = h.proxy.getPlayer('1')!;
  vi.spyOn(h.proxy.gateway!, 'close').mockRejectedValue(new Error('gateway_close_failed'));
  const closeRelay = vi.spyOn(h.relay, 'close');
  await assert.rejects(h.proxy.close(), /gateway_close_failed/);
  assert.equal(closeRelay.mock.calls.length, 1);
  assert.equal(h.relay.listenerCount('sessionOpen'), 0);
  assert.equal(h.proxy.players.size, 0);
  assert.ok(!player.isValid);
});

test('PoC-style verification preserves Serenity ClientData including skins and nested claims', async () => {
  const data = {
    ...deviceData,
    SkinData: 'large skin',
    extraClaim: { nested: ['preserved'] },
    verified: false,
  };
  const packet = signedLogin(data);
  const result = await verifyLoginClientData(packet.tokens, '123');
  assert.deepEqual(result.identity, {
    verified: true,
    name: 'Alice',
    xuid: '123',
    persistentId: 'playfab',
  });
  assert.deepEqual(result.clientData, data);
  assert.ok(Object.isFrozen(result.clientData));
  assert.equal(result.clientData.SkinData, 'large skin');
  assert.equal(Reflect.set(result.clientData, 'DeviceModel', 'changed'), false);
  await assert.rejects(verifyLoginClientData(packet.tokens, '999'), /identity_xuid_mismatch/);
  const [header, , signature] = packet.tokens.client.split('.');
  packet.tokens.client = `${header}.${Buffer.from(JSON.stringify({ ...deviceData, DeviceOS: 99 })).toString('base64url')}.${signature}`;
  await assert.rejects(verifyLoginClientData(packet.tokens));
  const tampered = signedLogin();
  const identity = JSON.parse(tampered.tokens.identity) as {
    AuthenticationType: number;
    Token: string;
  };
  const [tokenHeader, , tokenSignature] = identity.Token.split('.');
  identity.Token = `${tokenHeader}.${Buffer.from(JSON.stringify({ xname: 'forged', xid: '999' })).toString('base64url')}.${tokenSignature}`;
  tampered.tokens.identity = JSON.stringify(identity);
  await assert.rejects(verifyLoginClientData(tampered.tokens));
  for (const data of [{ DeviceOS: '7' }, { MemoryTier: 1.5 }, { DeviceId: 123 }]) {
    const result = await verifyLoginClientData(signedLogin(data).tokens);
    assert.deepEqual(result.clientData, data);
  }
  const partial = await verifyLoginClientData(signedLogin({ DeviceOS: 0 }).tokens);
  assert.deepEqual(partial.clientData, { DeviceOS: 0 });
});

test('client data verification supports only online authentication', async () => {
  for (const identity of [
    JSON.stringify({ chain: [] }),
    JSON.stringify({ AuthenticationType: 2, Token: '', Certificate: '{"chain":[]}' }),
    JSON.stringify({ AuthenticationType: 1, Token: '' }),
  ])
    await assert.rejects(
      verifyLoginClientData(new LoginTokens(signedClient(deviceData), identity)),
    );
  await assert.rejects(verifyLoginClientData(signedLogin(null).tokens), /missing_client_data/);
});

test('LoginSuccess and Initialized can arrive before verification; forwarding continues and Join precedes Spawn', async () => {
  const h = harness(false, { requireClientData: undefined });
  const a = h.add(1n, signalingIdentity);
  const order: string[] = [];
  let joined!: PlayerJoinEvent;
  const ready = new Promise<void>((resolve) => {
    h.proxy.on('playerJoin', (event) => {
      joined = event;
      assert.equal(h.proxy.players.size, 0);
      order.push('join');
    });
    h.proxy.on('playerSpawn', () => {
      order.push('spawn');
      resolve();
    });
  });
  h.proxy.on('playerLeave', (event) => {
    assert.equal(event.clientData, joined.clientData);
    order.push('leave');
  });
  a.inject('c2s', signedLogin().serialize());
  a.inject('s2c', success(), startGameBytes);
  a.inject('c2s', initialized(), initialized());
  assert.deepEqual(order, []);
  // Completed packet tracking is already raw even while metadata verification is pending.
  a.session.receive('s2c', 'reliable', Buffer.from([0, 0xde, 0xad]));
  assert.deepEqual(a.errors, []);
  await ready;
  const player = h.proxy.getPlayer('1')!;
  assert.deepEqual(order, ['join', 'spawn']);
  assert.deepEqual(joined.clientData, deviceData);
  assert.equal(player.clientData, joined.clientData);
  assert.equal(player.identity, joined.identity);
  assert.equal(player.identity.verified, true);
  assert.equal(player.xuid, '123');
  assert.equal(player.name, 'Alice');
  assert.equal(player.persistentId, 'playfab');
  await a.session.close();
  assert.deepEqual(order, ['join', 'spawn', 'leave']);
  await h.proxy.close();
});

test('optional client data falls back to a shared empty object on verification failure', async () => {
  const h = harness();
  const a = h.add();
  const joined = new Promise<PlayerJoinEvent>((resolve) => h.proxy.once('playerJoin', resolve));
  const packet = signedLogin({ ...deviceData, secret: 'never log me' });
  const [header, payload] = packet.tokens.client.split('.');
  packet.tokens.client = `${header}.${payload}.${Buffer.alloc(96).toString('base64url')}`;
  a.inject('c2s', packet.serialize());
  a.inject('s2c', success(), startGameBytes);
  a.inject('c2s', initialized());
  const event = await joined;
  assert.deepEqual(event.clientData, {});
  assert.equal(h.proxy.getPlayer('1')?.clientData, event.clientData);
  h.proxy.on('playerLeave', (left) => assert.equal(left.clientData, event.clientData));
  assert.ok(h.proxy.getPlayer('1'));
  assert.ok(h.logs.some((log) => log.reason === 'login_verification_failed'));
  assert.ok(!JSON.stringify(h.logs).includes('never log me'));
  assert.equal(a.session.closed, false);
  await h.proxy.close();
});

test('authenticated XUID mismatches close before client JWT verification even when client data is optional', async () => {
  for (const requireClientData of [false, true]) {
    const h = harness(false, { requireClientData });
    const a = h.add(1n, { ...signalingIdentity, xuid: '999' });
    const events: string[] = [];
    for (const event of ['playerJoin', 'playerSpawn', 'playerLeave'] as const)
      h.proxy.on(event, () => {
        events.push(event);
      });
    const packet = signedLogin();
    packet.tokens.client = 'invalid-client-jwt';
    a.inject('c2s', packet.serialize());
    a.inject('s2c', success(), startGameBytes);
    a.inject('c2s', initialized());
    await vi.waitFor(() => assert.ok(a.session.closed));
    assert.deepEqual(events, []);
    assert.equal(h.proxy.players.size, 0);
    assert.ok(h.logs.some((log) => log.reason === 'identity_xuid_mismatch'));
    await h.proxy.close();
  }
});

test('a late authenticated XUID mismatch still closes an active session after optional metadata timeout', async () => {
  const pending = Promise.withResolvers<typeof deviceData>();
  const verify = vi.spyOn(Authentication, 'verify').mockImplementationOnce(() => pending.promise);
  const h = harness(false, { loginTimeoutMs: 150 });
  const a = h.add(1n, signalingIdentity);
  try {
    a.inject('c2s', signedLogin().serialize());
    a.inject('s2c', success(), startGameBytes);
    a.inject('c2s', initialized());
    await vi.waitFor(() => assert.ok(h.proxy.getPlayer('1')));
    pending.reject(new Error('identity_xuid_mismatch'));
    await vi.waitFor(() => assert.ok(a.session.closed));
    assert.equal(h.proxy.players.size, 0);
    assert.ok(h.logs.some((log) => log.reason === 'identity_xuid_mismatch'));
  } finally {
    pending.resolve(deviceData);
    await h.proxy.close();
    verify.mockRestore();
  }
});

test('client data is required by default; verification failure, unsupported or missing Login closes without player events', async () => {
  const offline = signedLogin();
  offline.tokens.identity = JSON.stringify({
    AuthenticationType: 2,
    Token: '',
    Certificate: '{"chain":[]}',
  });
  for (const loginPacket of [login(), offline.serialize(), Buffer.from([1]), undefined]) {
    const h = harness(false, { requireClientData: undefined });
    const a = h.add();
    const events: string[] = [];
    for (const name of ['playerJoin', 'playerSpawn', 'playerLeave'] as const)
      h.proxy.on(name, () => {
        events.push(name);
      });
    if (loginPacket) a.inject('c2s', loginPacket);
    if (!a.session.closed) a.inject('s2c', success(), startGameBytes);
    await vi.waitFor(() => assert.ok(a.session.closed));
    assert.deepEqual(events, []);
    assert.equal(h.proxy.players.size, 0);
    await h.proxy.close();
  }
});

test('close or stop during client verification cannot emit late events or affect a reconnected Player', async () => {
  for (const requireClientData of [false, true])
    for (const accepted of [false, true]) {
      const pending = Promise.withResolvers<typeof deviceData>();
      const entered = Promise.withResolvers<void>();
      const verify = vi.spyOn(Authentication, 'verify').mockImplementationOnce(() => {
        entered.resolve();
        return pending.promise;
      });
      const h = harness(false, { requireClientData });
      const a = h.add();
      const order: string[] = [];
      h.proxy.on('playerJoin', (event) => {
        assert.deepEqual(event.clientData, {});
        order.push('join');
      });
      h.proxy.on('playerSpawn', () => {
        order.push('spawn');
      });
      h.proxy.on('playerLeave', () => {
        order.push('leave');
      });
      try {
        a.inject('c2s', signedLogin().serialize());
        await entered.promise;
        if (accepted) a.inject('s2c', success(), startGameBytes);
        if (accepted) await h.proxy.close();
        else await a.session.close();
        assert.deepEqual(order, accepted && !requireClientData ? ['join', 'leave'] : []);
        const reconnect = accepted ? undefined : h.add();
        if (reconnect && !requireClientData) {
          reconnect.inject('s2c', success(), startGameBytes);
          reconnect.inject('c2s', initialized());
        }
        const before = [...order];
        if (requireClientData) pending.reject(new Error('identity_xuid_mismatch'));
        else pending.resolve(deviceData);
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(order, before);
        assert.deepEqual(
          h.proxy.getPlayer('1')?.clientData,
          reconnect && !requireClientData ? {} : undefined,
        );
      } finally {
        pending.resolve(deviceData);
        await h.proxy.close();
        verify.mockRestore();
      }
    }
});

test('verification deadlines and concurrency limits bound metadata waiting without holding game traffic', async () => {
  for (const requireClientData of [false, true]) {
    const pending = Promise.withResolvers<typeof deviceData>();
    const entered = Promise.withResolvers<void>();
    const verify = vi.spyOn(Authentication, 'verify').mockImplementationOnce(() => {
      entered.resolve();
      return pending.promise;
    });
    const h = harness(false, { loginTimeoutMs: 150, maxPendingLogins: 1, requireClientData });
    try {
      const a = h.add();
      a.inject('c2s', signedLogin().serialize());
      await entered.promise;
      const b = h.add(2n);
      b.inject('c2s', signedLogin().serialize());
      if (requireClientData) assert.ok(b.session.closed);
      else {
        b.inject('s2c', success(), startGameBytes);
        b.inject('c2s', initialized());
        assert.ok(h.proxy.getPlayer('2'));
        assert.deepEqual(h.proxy.getPlayer('2')!.clientData, {});
      }
      a.inject('s2c', success(), startGameBytes);
      a.inject('c2s', initialized());
      assert.equal(h.proxy.getPlayer('1'), undefined);
      await vi.waitFor(
        () => assert.ok(requireClientData ? a.session.closed : h.proxy.getPlayer('1')),
        { timeout: 1000 },
      );
      assert.deepEqual(h.proxy.getPlayer('1')?.clientData, requireClientData ? undefined : {});
      assert.ok(h.logs.some((log) => log.reason === 'login_verification_timeout'));
      const c = h.add(3n);
      c.inject('c2s', signedLogin().serialize());
      assert.equal(h.logs.filter((log) => log.reason === 'login_verification_busy').length, 2);
      pending.resolve(deviceData);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(h.proxy.getPlayer('1')?.clientData, requireClientData ? undefined : {});
      const d = h.add(4n);
      const joined = new Promise<Player['clientData']>((resolve) =>
        h.proxy.once('playerJoin', (event) => resolve(event.clientData)),
      );
      d.inject('c2s', signedLogin().serialize());
      d.inject('s2c', success());
      assert.equal((await joined).DeviceModel, deviceData.DeviceModel);
    } finally {
      pending.resolve(deviceData);
      await h.proxy.close();
      verify.mockRestore();
    }
  }
});

test('invalid login verification limits are rejected before allocating a relay', () => {
  const options = { serverUrl: 'http://127.0.0.1:1', clientSideIdentity: serverIdentity };
  for (const value of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER])
    assert.throws(
      () => new NetherNetProxy({ ...options, loginTimeoutMs: value }),
      /invalid_login_limits/,
    );
  for (const value of [0, -1, 1.5, Infinity])
    assert.throws(
      () => new NetherNetProxy({ ...options, maxPendingLogins: value }),
      /invalid_login_limits/,
    );
});

const skinData = {
  ...deviceData,
  AnimatedImageData: [],
  ArmSize: 'wide',
  CapeData: '',
  CapeId: '',
  CapeImageHeight: 0,
  CapeImageWidth: 0,
  CapeOnClassicSkin: false,
  OverrideSkin: false,
  PersonaPieces: [],
  PersonaSkin: false,
  PieceTintColors: [],
  PremiumSkin: false,
  SkinAnimationData: '',
  SkinColor: '#0',
  SkinData: Buffer.alloc(64 * 64 * 4, 1).toString('base64'),
  SkinGeometryData: Buffer.from('{"format_version":"1.12.0"}').toString('base64'),
  SkinGeometryDataEngineVersion: Buffer.from('1.0.0').toString('base64'),
  SkinId: 'login-skin',
  SkinImageHeight: 64,
  SkinImageWidth: 64,
  SkinResourcePatch: Buffer.from('{}').toString('base64'),
  TrustedSkin: true,
} satisfies Partial<ClientData>;
const varuint = (value: number) => {
  const bytes: number[] = [];
  do {
    bytes.push((value & 0x7f) | (value > 0x7f ? 0x80 : 0));
    value >>>= 7;
  } while (value);
  return Buffer.from(bytes);
};
const u32 = (value: number) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
};
const bytes = (value: Buffer | string) => {
  const data = Buffer.from(value);
  return Buffer.concat([varuint(data.length), data]);
};
// Current (1.26.x) layout per gophertunnel; SerenityJS 0.8.21 still encodes the pre-1.20 one.
function skinPacket(id: string, width = 64, data = Buffer.alloc(width * 64 * 4, 2)) {
  return Buffer.concat([
    varuint(93),
    Buffer.from('0807060504030201100f0e0d0c0b0a09', 'hex'),
    bytes(id),
    bytes(''),
    bytes('{}'),
    u32(width),
    u32(64),
    bytes(data),
    varuint(1), // animation
    u32(1),
    u32(1),
    bytes(Buffer.alloc(4)),
    varuint(1),
    Buffer.from([0, 0, 0x80, 0x3f]),
    varuint(0),
    u32(0), // cape
    u32(0),
    bytes(''),
    bytes('{"format_version":"1.12.0"}'),
    bytes('1.0.0'),
    bytes(''),
    bytes(''),
    bytes(id),
    Buffer.from([1]), // wide
    Buffer.from([0x62, 0x7b, 0xb3, 0xff]),
    varuint(1), // persona piece
    bytes('piece'),
    u32(3),
    Buffer.alloc(16),
    Buffer.from([1]),
    bytes(''),
    varuint(1), // tint
    bytes('hair'),
    Buffer.alloc(16),
    Buffer.from([0, 0, 0, 0, 0]),
    bytes('true'),
    bytes('hash'),
    bytes('new'),
    bytes('old'),
  ]);
}

test('PlayerSkin validates image sizes and exposes login skin fields', () => {
  const skin = PlayerSkin.fromClientData(skinData as unknown as ClientData);
  assert.equal(skin.id, 'login-skin');
  assert.equal(skin.armSize, 'wide');
  assert.equal(skin.skinImage.width, 64);
  assert.deepEqual(skin.getGeometry(), { format_version: '1.12.0' });
  assert.ok(Object.isFrozen(skin));
  assert.throws(() => skin.toPng(), /not_implemented/);
  assert.throws(
    () => PlayerSkin.fromClientData({ ...skinData, SkinImageWidth: 32 } as unknown as ClientData),
    /invalid_skin/,
  );
  assert.throws(() => PlayerSkin.fromClientData(deviceData as ClientData));
});

test('PlayerSkin packets decode the current layout and fail fast on stale or truncated data', () => {
  const packet = readPlayerSkinPacket(skinPacket('wire'));
  assert.equal(packet.uuid, '01020304-0506-0708-090a-0b0c0d0e0f10');
  assert.equal(packet.skinName, 'new');
  assert.equal(packet.oldSkinName, 'old');
  assert.equal(packet.skin.identifier, 'wire');
  assert.equal(packet.skin.armSize, 'wide');
  assert.equal(packet.skin.skinColor, '#ffb37b62');
  assert.equal(packet.skin.animations[0].frames, 1);
  assert.equal(packet.skin.personaPieces[0].type, 'persona_skin');
  assert.equal(packet.skin.tintPieces[0].type, 'persona_hair');
  assert.equal(packet.skin.tintPieces[0].colors.length, 4);
  assert.equal(packet.skin.isTrusted, true);
  assert.equal(packet.skin.profileHash, 'hash');
  assert.equal(new PlayerSkin(packet.skin).getGeometry() instanceof Object, true);
  // read -> write はバイト単位で元に戻る。
  const written = new PlayerSkinPacket();
  Object.assign(written, packet);
  assert.deepEqual(Buffer.from(written.serialize()), skinPacket('wire'));
  // A huge element count must not loop over zero-filled reads (the 0.8.21 decoder hung here).
  const huge = skinPacket('wire');
  const animations = huge.indexOf(Buffer.concat([varuint(1), u32(1), u32(1)]), 60);
  huge[animations] = 0xff;
  const started = performance.now();
  assert.throws(() => readPlayerSkinPacket(huge), /truncated_packet|VarInt exceeds/);
  const full = skinPacket('wire');
  for (const length of [1, 17, 40, full.length - 1])
    assert.throws(() => readPlayerSkinPacket(full.subarray(0, length)), /truncated_packet/);
  assert.ok(performance.now() - started < 100);
});

test('login skin is the initial Player.skin; c2s PlayerSkin updates it before and after spawn', async () => {
  const h = harness(false, { requireClientData: undefined });
  const a = h.add(1n, signalingIdentity);
  const changes: PlayerSkinChangeEvent[] = [];
  h.proxy.on('playerSkinChange', (event) => {
    changes.push(event);
  });
  const spawned = new Promise<Player>((resolve) =>
    h.proxy.once('playerSpawn', (event) => resolve(event.player)),
  );
  a.inject('c2s', signedLogin(skinData).serialize());
  a.inject('s2c', success(), startGameBytes);
  a.inject('c2s', initialized());
  const player = await spawned;
  assert.equal(player.skin?.id, 'login-skin');
  const login = player.skin;
  a.inject('c2s', skinPacket('changed'));
  assert.equal(player.skin?.id, 'changed');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].player, player);
  assert.equal(changes[0].previous, login);
  assert.equal(changes[0].skin, player.skin);
  // Subclient packets and malformed skins are ignored without closing the session.
  const subclient = skinPacket('subclient');
  subclient[1] |= 0x04; // senderSubClientId = 1 in the header varint's second byte
  a.inject('c2s', Buffer.concat([Buffer.from([subclient[0] | 0x80]), subclient.subarray(1)]));
  a.inject('c2s', skinPacket('broken', 64, Buffer.alloc(3)));
  assert.equal(player.skin?.id, 'changed');
  assert.equal(changes.length, 1);
  assert.ok(h.logs.some((log) => log.reason === 'invalid_skin'));
  assert.equal(a.session.closed, false);
  await h.proxy.close();

  // A change during login verification wins over the login skin.
  const early = harness(false, { requireClientData: undefined });
  const b = early.add(1n, signalingIdentity);
  const earlySpawn = new Promise<Player>((resolve) =>
    early.proxy.once('playerSpawn', (event) => resolve(event.player)),
  );
  b.inject('c2s', signedLogin(skinData).serialize(), skinPacket('early'));
  b.inject('s2c', success(), startGameBytes);
  b.inject('c2s', initialized());
  assert.equal((await earlySpawn).skin?.id, 'early');
  await early.proxy.close();
});
