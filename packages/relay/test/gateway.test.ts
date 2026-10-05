import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { TransportGateway } from '../src/gateway';
import type { TransportGatewayOptions } from '../src/gateway';
import { Relay } from '../src/relay';
import { sdpHash } from '../src/sdp-verifier';
import { offer, serverIdentity } from './helpers/sdp';

async function setup(
  offerTimeoutMs = 25000,
  configure?: TransportGatewayOptions['configure'],
  serverUrl = 'http://127.0.0.1:1',
) {
  let release!: () => void;
  let entered!: () => void;
  const verifying = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const relay = new Relay({
    clientSideIdentity: serverIdentity,
    serverUrl,
    verifyOffer: async (sdp) => {
      entered();
      await gate;
      return Object.freeze({
        sdpSha256: sdpHash(sdp),
        xuid: '123456789',
        gamertag: 'Test Player',
        playFabId: 'test-playfab',
        publicKeyFingerprint: 'test',
        issuer: 'test',
        expiresAt: Date.now() / 1000 + 600,
      });
    },
  });
  const gateway = new TransportGateway(relay, { offerTimeoutMs, configure });
  await gateway.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(gateway.server!.address() as AddressInfo).port}`;
  return {
    proxy: relay,
    gateway,
    url,
    release,
    verifying,
    async close() {
      release();
      gateway.server!.closeAllConnections();
      await gateway.close();
      await relay.close();
    },
  };
}

test('info uses standard gateway forwarding without a custom header policy', async () => {
  let callerHeader: string | undefined;
  const server = createServer((req, res) => {
    callerHeader = req.headers['x-test-caller'] as string | undefined;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ name: 'Test BDS' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const context = await setup(
    25000,
    undefined,
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  );
  try {
    const response = await fetch(context.url + '/v1/join', {
      headers: { 'x-test-caller': 'preserved' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { name: 'Test BDS' });
    assert.equal(callerHeader, 'preserved');
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('gateway policy middleware can reject before the terminal transport handler', async () => {
  const context = await setup(25000, (gateway) => {
    gateway.use('join', () => new Response(null, { status: 403 }));
  });
  try {
    const response = await fetch(context.url + '/v1/join/123', {
      method: 'POST',
      headers: { 'content-type': 'application/sdp' },
      body: await offer(),
    });
    assert.equal(response.status, 403);
    assert.equal(context.proxy.sessions.size, 0);
    assert.equal(context.proxy.clientEndpoint.connections.size, 0);
  } finally {
    await context.close();
  }
});

test('gateway rejects invalid HTTP offers before transport allocation', async () => {
  const context = await setup();
  try {
    const signedOffer = await offer();
    for (const [path, body, contentType, status] of [
      ['/v1/join/18446744073709551616', signedOffer, 'application/sdp', 400],
      ['/v1/join/not-a-uint64', signedOffer, 'application/sdp', 400],
      ['/v1/join/123', 'x'.repeat(1024 * 1024 + 1), 'application/sdp', 413],
      ['/v1/join/123', 'v=0\r\n', 'application/sdp', 401],
    ] as const) {
      const response = await fetch(context.url + path, {
        method: 'POST',
        headers: { 'content-type': contentType },
        body,
      });
      assert.equal(response.status, status);
      await response.text();
    }
    assert.equal(context.proxy.sessions.size, 0);
    assert.equal(context.proxy.clientEndpoint.connections.size, 0);
  } finally {
    await context.close();
  }
});

test('gateway HTTP policy is retained and timeout cancels delayed admission', async () => {
  const context = await setup(100);
  try {
    const response = await fetch(context.url + '/v1/join/123', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: await offer(),
    });
    assert.equal(response.status, 504);
    context.release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(context.proxy.sessions.size, 0);
    assert.equal(context.proxy.clientEndpoint.connections.size, 0);
  } finally {
    await context.close();
  }
});

test('gateway HTTP disconnect cancels admission during verification', async () => {
  const context = await setup();
  const controller = new AbortController();
  try {
    const pending = fetch(context.url + '/v1/join/123', {
      method: 'POST',
      headers: { 'content-type': 'application/sdp' },
      body: await offer(),
      signal: controller.signal,
    }).catch(() => undefined);
    await context.verifying;
    controller.abort();
    await pending;
    // Let the server observe socket closure before releasing verification.
    await new Promise((resolve) => setTimeout(resolve, 50));
    context.release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(context.proxy.sessions.size, 0);
    assert.equal(context.proxy.clientEndpoint.connections.size, 0);
  } finally {
    await context.close();
  }
});

test('gateway close cancels outstanding verification instead of waiting for offer timeout', async () => {
  const context = await setup();
  const pending = fetch(context.url + '/v1/join/123', {
    method: 'POST',
    body: await offer(),
  }).catch(() => undefined);
  await context.verifying;
  try {
    await context.gateway.close();
    await pending;
    context.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(context.proxy.sessions.size, 0);
    assert.equal(context.proxy.clientEndpoint.connections.size, 0);
  } finally {
    await context.proxy.close();
  }
});
