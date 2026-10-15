import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignalStructure, SignalType } from 'nethernet';
import { Relay } from '../src/relay';
import type { ISession } from '../src/types';
import { serverIdentity, plainSdp } from './helpers/sdp';
import { sdpHash } from '../src/sdp-verifier';
import { createServerConnector, trackConnectionClose } from '../src/transport';
import { identity } from './helpers/sdp';

const signal = (id: bigint) => new SignalStructure(SignalType.ConnectRequest, id, plainSdp, 2n);
test('pending admission, timeout and relay shutdown release reservations without allocating peers', async () => {
  const reasons: string[] = [];
  const relay = new Relay({
    serverUrl: 'http://127.0.0.1:1',
    clientSideIdentity: serverIdentity,
    maxPendingOffers: 1,
    offerTimeoutMs: 30,
    verifyOffer: () => new Promise(() => {}),
  });
  relay.on('signalingRejected', (_, reason) => {
    reasons.push(reason);
  });
  const replies: string[] = [];
  const first = relay.clientEndpoint.handleOffer(signal(1n), (reply) => {
    replies.push(reply.data);
  });
  await relay.clientEndpoint.handleOffer(signal(2n), (reply) => {
    replies.push(reply.data);
  });
  assert.deepEqual(reasons, ['admission_limit']);
  await first;
  assert.deepEqual(reasons, ['admission_limit', 'offer_timeout']);
  assert.equal(relay.sessions.size, 0);
  assert.equal(relay.clientEndpoint.connections.size, 0);
  const third = relay.clientEndpoint.handleOffer(signal(3n), () => {});
  await relay.close();
  await third;
  assert.equal(reasons.length, 2);
});
test('abort and close during verification cannot create a late session, even if verifier later resolves', async () => {
  let release!: (
    result: Awaited<ReturnType<NonNullable<ConstructorParameters<typeof Relay>[0]['verifyOffer']>>>,
  ) => void;
  const relay = new Relay({
    serverUrl: 'http://127.0.0.1:1',
    clientSideIdentity: serverIdentity,
    verifyOffer: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const controller = new AbortController();
  const offer = relay.clientEndpoint.handleOffer(
    signal(1n),
    () => assert.fail('aborted request must not respond'),
    undefined,
    controller.signal,
  );
  controller.abort();
  await offer;
  release({
    sdpSha256: sdpHash(plainSdp),
    xuid: '1',
    gamertag: 'test',
    playFabId: 'test',
    publicKeyFingerprint: 'test',
    issuer: 'test',
    expiresAt: Date.now() / 1000 + 600,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(relay.sessions.size, 0);
  assert.equal(relay.clientEndpoint.connections.size, 0);
  await relay.close();
});

test('SDP size and session limits are enforced before peer allocation', async () => {
  let verifies = 0;
  const reasons: string[] = [];
  const relay = new Relay({
    serverUrl: 'http://127.0.0.1:1',
    clientSideIdentity: serverIdentity,
    maxSessions: 1,
    maxPendingOffers: 2,
    verifyOffer: () => {
      verifies++;
      return new Promise(() => {});
    },
  });
  relay.on('signalingRejected', (_, reason) => {
    reasons.push(reason);
  });
  try {
    const oversized = signal(1n);
    oversized.data = 'v=0\r\n' + 'x'.repeat(256 * 1024);
    await relay.clientEndpoint.handleOffer(oversized, () => {});
    assert.equal(verifies, 0);
    const pending = relay.clientEndpoint.handleOffer(signal(2n), () => {});
    await relay.clientEndpoint.handleOffer(signal(3n), () => {});
    assert.equal(verifies, 1);
    assert.deepEqual(reasons, ['sdp_limit', 'admission_limit']);
    await relay.close();
    await pending;
  } finally {
    await relay.close();
  }
});

test(
  'repeated server HTTP failures close both peers and sockets, including failures during client negotiation',
  { timeout: 20000 },
  async () => {
    const baseline = process.getActiveResourcesInfo().filter((name) => name === 'UDPWrap').length;
    const http = createServer((_, res) => {
      res.writeHead(503);
      res.end();
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const relay = new Relay({
      serverUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
      clientSideIdentity: serverIdentity,
      verifyOffer: async (sdp) => ({
        sdpSha256: sdpHash(sdp),
        xuid: '1',
        gamertag: 'test',
        playFabId: 'test',
        publicKeyFingerprint: 'test',
        issuer: 'test',
        expiresAt: Date.now() / 1000 + 600,
      }),
    });
    let opened = 0;
    let closed = 0;
    let ready = 0;
    relay.on('sessionOpen', () => {
      opened++;
    });
    relay.on('sessionClose', (session) => {
      closed++;
      assert.ok(session.closed);
    });
    relay.on('sessionReady', () => {
      ready++;
    });
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('server_failure_timeout');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    try {
      for (let i = 0; i < 3; i++) {
        let peerClosed = () => Promise.resolve();
        const client = createServerConnector(
          relay.clientEndpoint.networkId,
          { identity: await identity(), responseTimeoutMs: 1000, inactivityTimeoutMs: 1000 },
          (connection) => {
            peerClosed = trackConnectionClose(connection);
          },
        );
        client.on('error', () => {});
        client.signalHandler = (request) => {
          request.networkId = client.networkId;
          if (request.type !== SignalType.ConnectRequest) return;
          void relay.clientEndpoint.handleOffer(request, (reply) => {
            reply.networkId = relay.clientEndpoint.networkId;
            client.handleSignal(reply);
          });
        };
        try {
          client.connect();
          await until(() => closed === i + 1);
          assert.equal(relay.sessions.size, 0);
          assert.equal(relay.clientEndpoint.connections.size, 0);
        } finally {
          const socketClosed = new Promise<void>((resolve) => client.socket.once('close', resolve));
          client.close();
          await Promise.all([socketClosed, peerClosed()]);
        }
      }
      assert.equal(opened, 3);
      assert.equal(closed, 3);
      assert.equal(ready, 0);
    } finally {
      await relay.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
    await until(
      () =>
        process.getActiveResourcesInfo().filter((name) => name === 'UDPWrap').length <= baseline,
    );
  },
);

test('signaling request passed with the offer is exposed on the session', { timeout: 20000 }, async () => {
  const http = createServer((_, res) => {
    res.writeHead(503);
    res.end();
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const relay = new Relay({
    serverUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    clientSideIdentity: serverIdentity,
    verifyOffer: async (sdp) => ({
      sdpSha256: sdpHash(sdp),
      xuid: '1',
      gamertag: 'test',
      playFabId: 'test',
      publicKeyFingerprint: 'test',
      issuer: 'test',
      expiresAt: Date.now() / 1000 + 600,
    }),
  });
  const request = { headers: new Headers({ 'x-real-ip': '203.0.113.1' }), remoteAddress: '127.0.0.1' };
  const opened = new Promise<ISession>((resolve) => relay.on('sessionOpen', resolve));
  const closed = new Promise<void>((resolve) => relay.on('sessionClose', () => resolve()));
  let peerClosed = () => Promise.resolve();
  const client = createServerConnector(
    relay.clientEndpoint.networkId,
    { identity: await identity(), responseTimeoutMs: 1000, inactivityTimeoutMs: 1000 },
    (connection) => {
      peerClosed = trackConnectionClose(connection);
    },
  );
  client.on('error', () => {});
  client.signalHandler = (signal) => {
    signal.networkId = client.networkId;
    if (signal.type !== SignalType.ConnectRequest) return;
    void relay.clientEndpoint.handleOffer(
      signal,
      (reply) => {
        reply.networkId = relay.clientEndpoint.networkId;
        client.handleSignal(reply);
      },
      undefined,
      undefined,
      request,
    );
  };
  try {
    client.connect();
    const session = await opened;
    assert.equal(session.signalingRequest, request);
    assert.equal(session.signalingRequest?.headers.get('x-real-ip'), '203.0.113.1');
    await closed;
  } finally {
    const socketClosed = new Promise<void>((resolve) => client.socket.once('close', resolve));
    client.close();
    await Promise.all([socketClosed, peerClosed()]);
    await relay.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});
