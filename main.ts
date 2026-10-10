import type { AddressInfo } from 'node:net';
import {
  NetherNetProxy,
  proxyServerIdentity,
  authenticateTransport,
} from './packages/proxy/src/index';

const serverUrl = process.env.BDS_URL ?? 'http://127.0.0.1:19132';
const webrtcBackend = process.env.PROXY_WEBRTC_BACKEND ?? 'werift';
if (webrtcBackend !== 'werift' && webrtcBackend !== 'wrtc')
  throw new Error('invalid_webrtc_backend');
const clientSideIdentity = await proxyServerIdentity();
const status = await fetch(new URL('/v1/join', serverUrl), { signal: AbortSignal.timeout(5000) });
if (!status.ok) throw new Error('server_status_failed');
const serverSideIdentity = await authenticateTransport(String((await status.json()).version));
const proxy = new NetherNetProxy({
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

proxy.on('playerJoin', ({ connectionId, identity }) =>
  console.log(JSON.stringify({ event: 'player_join', connectionId, identity })),
);

proxy.on('playerSpawn', ({ player }) => {
  console.log(JSON.stringify({ event: 'player_spawn', connectionId: player.connectionId }));
  console.log(player.identity)
  setInterval(() => {
    const message = `Hello, ${player.name}! (xuid=${player.xuid}, pfid=${player.persistentId})`;
    player.sendMessage(message);
    player.onScreenDisplay.setJukeboxPopup('This is JukeboxPopup');
    player.onScreenDisplay.setToolTip('This is ToolTip');
    player.onScreenDisplay.setToast('This is Toast', 'This is the message of the toast');
  }, 5_000)
});

proxy.on('playerLeave', ({ connectionId, reason }) =>
  console.log(JSON.stringify({ event: 'player_leave', connectionId, reason })),
);

try {
  await proxy.listen(Number(process.env.PROXY_PORT ?? 19134), '0.0.0.0');
} catch (error) {
  await proxy.close();
  throw error;
}
console.log(
  `NetherNet gateway: http://127.0.0.1:${(proxy.gateway!.server!.address() as AddressInfo).port}`,
);
async function stop() {
  await proxy.close();
}
process.once('SIGINT', () => {
  void stop();
});
process.once('SIGTERM', () => {
  void stop();
});
