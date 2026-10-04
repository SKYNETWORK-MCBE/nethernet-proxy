import { test } from 'vite-plus/test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { SignalType } from 'nethernet'
import type { Client as NetherNetClient, Connection } from 'nethernet'
import { createMinecraftClientTokenVerifier } from 'nethernet-gateway/minecraft'
import {
  ClientEndpoint,
  createServerConnector,
  captureChannels,
  useHttpSignaling,
  trackConnectionClose,
} from '../src/transport'
import { TransportProxy } from '../src/proxy'
import { TransportGateway } from '../src/gateway'
import { createSdpVerifier } from '../src/sdp-verifier'
import { decodePayload, encodePayload, fragmentPayload, Reassembler } from '../src/framing'
import { identity, signingKey, serverIdentity } from './helpers/sdp'
import { packet, frames } from './helpers/relay'
import type { Channel, PacketContext, Session } from '../src/types'

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 20000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('transport_test_timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
async function closeClient(client: NetherNetClient, closed: () => Promise<void>) {
  const socket = new Promise<void>((resolve) => client.socket.once('close', resolve))
  client.close()
  await Promise.all([socket, closed()])
}
interface Player {
  client: NetherNetClient
  echoes: { channel: Channel; frame: Buffer }[]
  readonly connection: Connection
  close(): Promise<void>
}
for (const gatewayMode of [false, true])
  test(
    `authenticated two-player relay and reconnect with real WebRTC (gateway=${gatewayMode})`,
    { timeout: 60000 },
    async () => {
      const baseline = process.getActiveResourcesInfo().filter((name) => name === 'UDPWrap').length
      const serverConnectionCloses: (() => Promise<void>)[] = []
      const serverReceived: { networkId?: bigint; channel: Channel; frame: Buffer }[] = []
      const serverEndpoint = new ClientEndpoint(
        { acceptTimeoutMs: 15000 },
        (connection, networkId) => {
          serverConnectionCloses.push(trackConnectionClose(connection))
          captureChannels(
            connection,
            (channel, frame) => {
              serverReceived.push({ networkId, channel, frame })
              connection[channel]!.send(frame as Buffer<ArrayBuffer>)
            },
            () => {},
          )
        },
      )
      const http = createServer(async (req, res) => {
        if (req.url === '/keys') {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ keys: [signingKey] }))
          return
        }
        const parts: Buffer[] = []
        for await (const part of req) parts.push(part)
        await serverEndpoint.handleOffer(
          {
            type: SignalType.ConnectRequest,
            connectionId: randomBytes(8).readBigUInt64LE(),
            networkId: BigInt(req.url!.split('/').at(-1)!),
            data: Buffer.concat(parts).toString(),
          },
          (signal) => {
            if (signal.type !== SignalType.CandidateAdd && !res.writableEnded) res.end(signal.data)
          },
        )
      })
      await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
      const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
      const proxy = new TransportProxy({
        serverUrl: url,
        clientSideIdentity: serverIdentity,
        verifyOffer: createSdpVerifier({
          verifyClientToken: createMinecraftClientTokenVerifier({ jwksUrl: url + '/keys' }),
        }),
      })
      const opened: Session[] = []
      const ready: Session[] = []
      const closed: string[] = []
      proxy.on('sessionOpen', (session) => {
        opened.push(session)
      })
      proxy.on('sessionReady', (session) => {
        ready.push(session)
      })
      proxy.on('sessionClose', (session) => {
        closed.push(session.connectionId)
      })
      const gateway = gatewayMode ? new TransportGateway(proxy) : undefined
      if (gateway) await gateway.listen(0, '127.0.0.1')
      const clients: Player[] = []
      async function player(): Promise<Player> {
        const echoes: { channel: Channel; frame: Buffer }[] = []
        let connection!: Connection
        let connectionClosed = () => Promise.resolve()
        const client = createServerConnector(
          proxy.clientEndpoint.networkId,
          { identity: await identity(), responseTimeoutMs: 15000, inactivityTimeoutMs: 15000 },
          (createdConnection) => {
            connection = createdConnection
            connectionClosed = trackConnectionClose(createdConnection)
            captureChannels(
              createdConnection,
              (channel, frame) => {
                echoes.push({ channel, frame })
              },
              () => {},
            )
          },
        )
        client.on('error', () => {})
        if (gateway)
          useHttpSignaling(
            client,
            `http://127.0.0.1:${(gateway.server!.address() as AddressInfo).port}`,
          )
        else
          client.signalHandler = (signal) => {
            signal.networkId = client.networkId
            const respond = (reply: typeof signal) => {
              reply.networkId = proxy.clientEndpoint.networkId
              client.handleSignal(reply)
            }
            if (signal.type === SignalType.ConnectRequest) {
              void proxy.clientEndpoint.handleOffer(signal, respond)
              signal.data = 'v=0\r\n'
              signal.connectionId = 666n
              signal.networkId = 777n
            } else if (signal.type === SignalType.CandidateAdd)
              void proxy.clientEndpoint.handleCandidate(signal, respond)
          }
        client.connect()
        const result = {
          client,
          echoes,
          get connection() {
            return connection
          },
          close: () => closeClient(client, connectionClosed),
        }
        clients.push(result)
        await until(
          () =>
            connection?.reliable?.readyState === 'open' &&
            connection?.unreliable?.readyState === 'open',
        )
        return result
      }
      try {
        const [a, b] = await Promise.all([player(), player()])
        await until(() => ready.length === 2)
        assert.equal(opened.length, 2)
        assert.equal(proxy.sessions.size, 2)
        for (const p of [a, b]) {
          const input = frames([packet(999 | 1024, Buffer.from([p === a ? 41 : 42]))], 2)
          for (const frame of input) p.connection.reliable!.send(frame as Buffer<ArrayBuffer>)
          const unreliable = frames([packet(999)])[0]
          p.connection.unreliable!.send(unreliable as Buffer<ArrayBuffer>)
          await until(() => p.echoes.length === input.length + 1)
          assert.deepEqual(
            p.echoes.filter((x) => x.channel === 'reliable').map((x) => x.frame),
            input,
          )
          assert.deepEqual(p.echoes.find((x) => x.channel === 'unreliable')!.frame, unreliable)
        }
        assert.equal(new Set(serverReceived.map((x) => x.networkId)).size, 2)
        const contexts: PacketContext[] = []
        const stop = proxy
          .packetHandler(9, { direction: 'c2s' })
          .before(() => packet(9, Buffer.from([77])))
        proxy.packetHandler(9).after((_, ctx) => {
          contexts.push(ctx)
        })
        for (const p of [a, b]) {
          p.echoes.length = 0
          for (const frame of frames([packet(9 | 1024)]))
            p.connection.reliable!.send(frame as Buffer<ArrayBuffer>)
          await until(() => p.echoes.length === 1)
          assert.deepEqual(
            decodePayload(p.echoes[0].frame.subarray(1)).packets[0].bytes,
            packet(9 | 1024, Buffer.from([77])),
          )
        }
        assert.equal(
          new Set(contexts.filter((x) => x.direction === 'c2s').map((x) => x.connectionId)).size,
          2,
        )
        // The synthetic echo server returns fixture NetworkSettings (not a Bedrock login).
        const active = [...proxy.sessions.values()]
        for (let i = 0; i < active.length; i++) {
          const accepted = proxy.clientEndpoint.connections.get(BigInt(active[i].connectionId))!
          let unexpected = 0
          const original = accepted.rtcConnection.addIceCandidate.bind(accepted.rtcConnection)
          accepted.rtcConnection.addIceCandidate = async () => {
            unexpected++
          }
          await proxy.clientEndpoint.handleCandidate({
            type: SignalType.CandidateAdd,
            connectionId: accepted.address,
            networkId: 777n,
            data: 'foreign',
          })
          assert.equal(unexpected, 0)
          accepted.rtcConnection.addIceCandidate = original
          assert.equal(active[i].verifiedSignaling?.xuid, '123456789')
        }
        for (const [i, p] of [a, b].entries()) {
          const handle = [...proxy.sessions.values()].find(
            (x) => x.networkId === p.client.networkId.toString(),
          )!
          const settings = Buffer.from([1, 0, i, 0]) // Different algorithms on the two sessions.
          p.echoes.length = 0
          p.connection.reliable!.send(frames([packet(143, settings)])[0] as Buffer<ArrayBuffer>)
          await until(() => p.echoes.length === 1)
          p.echoes.length = 0
          assert.equal(handle.server.send(packet(9)), 'sent')
          await until(() => p.echoes.length === 1)
          const returned = decodePayload(p.echoes[0].frame.subarray(1), { compression: true })
          assert.equal(returned.packets[0].body[0], 42) // Injection bypasses before (77).
          assert.equal(p.echoes[0].frame[1], i)
          p.echoes.length = 0
          assert.equal(
            proxy.sendToClient(handle.connectionId, packet(999), { channel: 'unreliable' }),
            'sent',
          )
          await until(() => p.echoes.length === 1)
          assert.equal(p.echoes[0].channel, 'unreliable')
          assert.deepEqual(
            decodePayload(p.echoes[0].frame.subarray(1), { compression: true }).packets[0].bytes,
            packet(999),
          )
        }
        const aSession = [...proxy.sessions.values()].find(
          (x) => x.networkId === a.client.networkId.toString(),
        )!
        await aSession.close('test_one_player_closed')
        assert.equal(proxy.sessions.size, 1)
        assert.ok(aSession.closed)
        assert.equal(closed.length, 1)
        b.echoes.length = 0
        const frame = fragmentPayload(
          encodePayload([packet(9)], { algorithm: 'snappy', threshold: 1 }),
        )[0]
        b.connection.reliable!.send(frame as Buffer<ArrayBuffer>)
        await until(() => b.echoes.length === 1)
        assert.equal(
          decodePayload(b.echoes[0].frame.subarray(1), { compression: true }).packets[0].body[0],
          77,
        )
        stop()
        const c = await player()
        await until(() => ready.length === 3)
        const unnegotiated = frames([packet(9)])[0]
        c.connection.reliable!.send(unnegotiated as Buffer<ArrayBuffer>)
        await until(() => c.echoes.length === 1)
        assert.deepEqual(c.echoes[0].frame, unnegotiated)
        assert.equal(proxy.sessions.size, 2)
      } finally {
        await Promise.all(clients.map((p) => p.close()))
        await gateway?.close()
        await proxy.close()
        serverEndpoint.close()
        await Promise.all(serverConnectionCloses.map((done) => done()))
        http.closeAllConnections()
        await new Promise<void>((resolve) => http.close(() => resolve()))
      }
      assert.equal(proxy.sessions.size, 0)
      await until(
        () =>
          process.getActiveResourcesInfo().filter((name) => name === 'UDPWrap').length <= baseline,
      )
    },
  )

test('session injection compression and framing round-trip is compatible with transport payloads', () => {
  for (const algorithm of ['deflate', 'snappy'] as const) {
    const encoded = fragmentPayload(encodePayload([packet(9)], { algorithm, threshold: 1 }), 2)
    const decoder = new Reassembler()
    let payload: Buffer | null = null
    for (const frame of encoded) payload = decoder.push(frame)
    assert.deepEqual(decodePayload(payload!, { compression: true }).packets[0].bytes, packet(9))
  }
})
