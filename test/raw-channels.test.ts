import { test } from 'vite-plus/test'
import assert from 'node:assert/strict'
import type { Client as NetherNetClient, Connection, Server as NetherNetServer } from 'nethernet'
import {
  captureChannels,
  onClientConnectionCreated,
  onServerConnectionCreated,
} from '../src/raw-channels'

test('raw capture binds existing channels and preserves library open/close/error handlers', () => {
  const calls: string[] = []
  const closed = () => calls.push('closed')
  const error = () => calls.push('error')
  const channel = () => ({
    readyState: 'open',
    onmessage: null,
    onopen: () => calls.push('library-open'),
    onclose: closed,
    onerror: error,
  })
  const connection = {
    reliable: channel(),
    unreliable: channel(),
    setChannels() {},
  } as unknown as Connection
  const received: Buffer[] = []
  captureChannels(
    connection,
    (name, bytes) => {
      calls.push(name)
      received.push(bytes)
    },
    (name) => calls.push(`ready:${name}`),
  )
  assert.deepEqual(calls, ['ready:reliable', 'ready:unreliable'])
  for (const dc of [connection.reliable!, connection.unreliable!]) {
    assert.equal(dc.onclose, closed)
    assert.equal(dc.onerror, error)
    const event = { data: Buffer.from([0, 42]) } as MessageEvent
    dc.onmessage!.call(dc, event)
    dc.onopen!.call(dc, new Event('open'))
  }
  assert.deepEqual(received, [Buffer.from([0, 42]), Buffer.from([0, 42])])
  assert.deepEqual(calls.slice(2), [
    'reliable',
    'library-open',
    'ready:reliable',
    'unreliable',
    'library-open',
    'ready:unreliable',
  ])
})

test('raw capture retains Buffer/ArrayBuffer storage without a relay copy', () => {
  const dc = { readyState: 'connecting' } as RTCDataChannel
  const connection = { reliable: dc, unreliable: null, setChannels() {} } as unknown as Connection
  const received: Buffer[] = []
  captureChannels(
    connection,
    (_, bytes) => {
      received.push(bytes)
    },
    () => {},
  )
  const buffer = Buffer.from([0, 42])
  dc.onmessage!.call(dc, { data: buffer } as MessageEvent)
  assert.equal(received[0], buffer)
  const array = Uint8Array.from([0, 43]).buffer
  dc.onmessage!.call(dc, { data: array } as MessageEvent)
  assert.equal(received[1].buffer, array)
})

for (const side of ['server', 'client'] as const) {
  test(`early ${side} hook captures first Reliable message before both channels/connect event`, () => {
    const received: Buffer[] = []
    const ready: string[] = []
    let attaches = 0
    const attach = (connection: Connection) => {
      attaches++
      captureChannels(
        connection,
        (_, bytes) => received.push(bytes),
        (channel) => ready.push(channel),
      )
    }
    const connection = {
      address: 123n,
      reliable: null,
      unreliable: null,
      setChannels(
        this: Connection,
        reliable?: RTCDataChannel | null,
        unreliable?: RTCDataChannel | null,
      ) {
        if (reliable) {
          this.reliable = reliable
          reliable.onmessage = () => {
            throw new Error('message reached late library reassembly')
          }
          reliable.onopen = () => {}
        }
        if (unreliable) this.unreliable = unreliable
      },
    } as unknown as Connection
    if (side === 'server') {
      const server = { connections: new Map<bigint, Connection>() } as NetherNetServer
      onServerConnectionCreated(server, attach)
      server.connections.set(123n, connection)
      server.connections.set(123n, connection)
    } else {
      const client = {} as NetherNetClient
      onClientConnectionCreated(client, attach)
      client.connection = connection
      client.connection = connection
    }
    assert.equal(attaches, 1)
    const reliable = { readyState: 'open' } as RTCDataChannel
    connection.setChannels(reliable)
    const initialRequest = Buffer.from([0, 6, 0xc1, 1, 0, 0, 8, 0x91])
    reliable.onmessage!.call(reliable, { data: initialRequest } as MessageEvent)
    assert.deepEqual(received, [initialRequest])
    assert.equal(connection.unreliable, null)
    connection.setChannels(null, { readyState: 'open' } as RTCDataChannel)
    assert.deepEqual(ready, ['reliable', 'unreliable'])
  })
}
