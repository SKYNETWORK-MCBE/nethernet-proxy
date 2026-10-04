import type { Client as NetherNetClient, Connection, Server as NetherNetServer } from 'nethernet'
import type { Channel } from './types'

// nethernet@1.1.2's encapsulated/send API loses channel and message boundaries.
// Install at Connection creation, before channels can receive their first message.
// openConnection/connected may be too late; library owns creation,
// ICE/DTLS/SCTP, fragmentation for normal send(), and close/error lifecycle.
export function captureChannels(
  connection: Connection,
  receive: (channel: Channel, frame: Buffer) => void,
  ready: (channel: Channel) => void,
) {
  const setChannels = connection.setChannels.bind(connection)
  const capture = (reliable = connection.reliable, unreliable = connection.unreliable) => {
    for (const [name, channel] of [
      ['reliable', reliable],
      ['unreliable', unreliable],
    ] as const) {
      if (!channel) continue
      // Replace high-level reassembly with raw capture; do not double-consume data.
      // ArrayBuffer ownership is retained by its Buffer view. No extra relay copy.
      channel.onmessage = (event) =>
        receive(name, Buffer.isBuffer(event.data) ? event.data : Buffer.from(event.data))
      const onopen = channel.onopen
      channel.onopen = (event) => {
        onopen?.call(channel, event)
        ready(name)
      }
      if (channel.readyState === 'open') ready(name)
    }
  }
  connection.setChannels = (reliable, unreliable) => {
    setChannels(reliable, unreliable)
    capture(reliable ?? null, unreliable ?? null)
  }
  capture()
}

/** SDK Server/Client hooks: nethernet@1.1.2 has no Connection-created event. */
export function onServerConnectionCreated(
  server: NetherNetServer,
  attach: (connection: Connection) => void,
) {
  const register = server.connections.set.bind(server.connections)
  server.connections.set = (id, connection) => {
    const existing = server.connections.get(id)
    const result = register(id, connection)
    if (existing !== connection) attach(connection)
    return result
  }
}

export function onClientConnectionCreated(
  client: NetherNetClient,
  attach: (connection: Connection) => void,
) {
  let connection = client.connection
  Object.defineProperty(client, 'connection', {
    configurable: true,
    enumerable: true,
    get: () => connection,
    set: (value: Connection | null | undefined) => {
      const previous = connection
      connection = value
      if (value && value !== previous) attach(value)
    },
  })
  if (connection) attach(connection)
}
