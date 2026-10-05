import type { AddressInfo } from 'node:net';
import { Relay, TransportGateway, proxyServerIdentity, authenticateTransport } from './src/index';

const serverUrl = process.env.BDS_URL ?? 'http://127.0.0.1:19132';
const webrtcBackend = process.env.PROXY_WEBRTC_BACKEND ?? 'werift';
if (webrtcBackend !== 'werift' && webrtcBackend !== 'wrtc')
  throw new Error('invalid_webrtc_backend');
const clientSideIdentity = await proxyServerIdentity();
const status = await fetch(new URL('/v1/join', serverUrl), { signal: AbortSignal.timeout(5000) });
if (!status.ok) throw new Error('server_status_failed');
const serverSideIdentity = await authenticateTransport(String((await status.json()).version));
const proxy = new Relay({
  serverUrl,
  clientSideIdentity,
  serverSideIdentity,
  webrtcBackend,
  log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
});
proxy.on('sessionOpen', (session) =>
  console.log(JSON.stringify({ event: 'session_open', connectionId: session.connectionId })),
);
proxy.on('sessionReady', (session) =>
  console.log(JSON.stringify({ event: 'session_ready', connectionId: session.connectionId })),
);
proxy.on('sessionClose', (session, reason) =>
  console.log(
    JSON.stringify({ event: 'session_close', connectionId: session.connectionId, reason }),
  ),
);
const gateway = new TransportGateway(proxy);
try {
  await gateway.listen(Number(process.env.PROXY_PORT ?? 19134), '0.0.0.0');
} catch (error) {
  await proxy.close();
  throw error;
}
console.log(
  `NetherNet gateway: http://127.0.0.1:${(gateway.server!.address() as AddressInfo).port}`,
);
async function stop() {
  gateway.server?.closeAllConnections();
  await Promise.all([gateway.close(), proxy.close()]);
}
process.once('SIGINT', () => {
  void stop();
});
process.once('SIGTERM', () => {
  void stop();
});
