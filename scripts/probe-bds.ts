import type { AddressInfo } from 'node:net'
import type { Client as NetherNetClient, Connection, Identity } from 'nethernet'
import { Packet } from '@serenityjs/protocol'
import {
  TransportProxy,
  TransportGateway,
  authenticateTransport,
  proxyServerIdentity,
} from '../src/index'
import {
  createServerConnector,
  captureChannels,
  useHttpSignaling,
  trackConnectionClose,
} from '../src/transport'
import { decodePayload, encodePayload, fragmentPayload, Reassembler, uint } from '../src/framing'

const url = process.env.BDS_URL ?? 'http://127.0.0.1:19132'
const status = await fetch(new URL('/v1/join', url), { signal: AbortSignal.timeout(5000) })
if (!status.ok) throw new Error('server_status_failed')
const info = await status.json()
const protocol = Number(
  process.env.PROTOCOL_VERSION ?? info.ProtocolVersion ?? info.protocolVersion ?? info.protocol,
)
if (!Number.isSafeInteger(protocol)) throw new Error('missing_protocol')
const body = Buffer.alloc(4)
body.writeInt32BE(protocol)
const request = Buffer.concat([uint(Packet.RequestNetworkSettings), body])
const authenticated = process.argv.includes('--auth')
const identity = authenticated ? await authenticateTransport(String(info.version)) : undefined
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 25000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('probe_timeout')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
interface Peer {
  client: NetherNetClient
  close(): Promise<void>
  settings: boolean
  readonly connection?: Connection
}
function peer(target: URL | string, transportIdentity?: Identity): Peer {
  const reassembly = new Map<string, Reassembler>()
  let connection: Connection | undefined
  let finish = () => Promise.resolve()
  const state: Peer = {
    client: createServerConnector(
      0n,
      { identity: transportIdentity, responseTimeoutMs: 20000, inactivityTimeoutMs: 20000 },
      (createdConnection) => {
        connection = createdConnection
        finish = trackConnectionClose(createdConnection)
        captureChannels(
          createdConnection,
          (channel, frame) => {
            if (!reassembly.has(channel)) reassembly.set(channel, new Reassembler())
            const payload = reassembly.get(channel)!.push(frame)
            if (!payload) return
            const packets = decodePayload(payload, { compression: state.settings }).packets
            for (const packet of packets) {
              if (packet.id === Packet.NetworkSettings) state.settings = true
              console.log(JSON.stringify({ event: 'probe_packet', id: packet.id, channel }))
            }
          },
          (channel) => {
            if (channel === 'reliable')
              for (const frame of fragmentPayload(encodePayload([request])))
                createdConnection.reliable!.send(frame as Buffer<ArrayBuffer>)
          },
        )
      },
    ),
    settings: false,
    get connection() {
      return connection
    },
    close: async () => {
      const socket = new Promise<void>((resolve) => state.client.socket.once('close', resolve))
      state.client.close()
      await Promise.all([socket, finish()])
    },
  }
  state.client.on('error', () => console.log(JSON.stringify({ event: 'probe_transport_error' })))
  useHttpSignaling(state.client, target)
  return state
}
if (!identity) {
  const direct = peer(url)
  let reason = ''
  direct.client.on('disconnect', (_, value) => {
    reason = value
  })
  try {
    direct.client.connect()
    await until(() => !!reason || direct.settings)
    console.log(
      JSON.stringify({
        event: 'unauthenticated_probe',
        rejected: reason === 'connecterror:37',
        reason,
        sendsLogin: false,
      }),
    )
    if (reason !== 'connecterror:37') throw new Error('unexpected_unsigned_admission')
  } finally {
    await direct.close()
  }
} else {
  const proxy = new TransportProxy({
    serverUrl: url,
    serverSideIdentity: identity,
    clientSideIdentity: await proxyServerIdentity(),
  })
  const gateway = new TransportGateway(proxy)
  const peers: Peer[] = []
  proxy.packetHandler(Packet.NetworkSettings, { direction: 's2c' }).after(() => {})
  try {
    await gateway.listen(0, '127.0.0.1')
    const target = `http://127.0.0.1:${(gateway.server!.address() as AddressInfo).port}`
    for (let i = 0; i < 2; i++) {
      const client = peer(target, identity)
      peers.push(client)
      client.client.connect()
    }
    await until(
      () => peers.every((p) => p.settings) && [...proxy.sessions.values()].every((s) => s.ready),
    )
    if (proxy.sessions.size !== 2) throw new Error('session_count_mismatch')
    const first = [...proxy.sessions.values()][0]
    await first.close('probe_one_session_closed')
    if ([...proxy.sessions.values()].length !== 1) throw new Error('session_isolation_failed')
    console.log(
      JSON.stringify({
        event: 'relay_probe',
        players: 2,
        settingsReceived: true,
        oneSessionClosedOtherAlive: true,
        sendsLogin: false,
      }),
    )
  } finally {
    await Promise.all(peers.map((p) => p.close()))
    await gateway.close()
    await proxy.close()
  }
}
