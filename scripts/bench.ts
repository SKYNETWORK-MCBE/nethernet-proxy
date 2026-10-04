import { performance } from 'node:perf_hooks'
import type { Connection } from 'nethernet'
import { ProxySession, defaultLimits } from '../src/session'
import { PacketHooks } from '../src/hooks'
import { encodePayload, fragmentPayload, uint } from '../src/framing'

const iterations = Number(process.env.BENCH_ITERATIONS ?? 20000)
if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error('invalid_bench_iterations')
let random = 42
const bodies = Array.from({ length: 16 }, () => {
  const body = Buffer.alloc(128)
  for (let i = 0; i < body.length; i++) {
    random ^= random << 13
    random ^= random >>> 17
    random ^= random << 5
    body[i] = random & 255
  }
  return Buffer.concat([uint(9), body])
})
const input = fragmentPayload(encodePayload(bodies, { algorithm: 'deflate', threshold: 1 }))
const originals = new Set(input)
for (const mode of ['raw', 'after', 'before-pass', 'before-rewrite'] as const) {
  let frames = 0
  let originalFrames = 0
  const endpoint = {
    address: 1n,
    reliable: {
      readyState: 'open',
      bufferedAmount: 0,
      send: (frame: Buffer) => {
        frames++
        if (originals.has(frame)) originalFrames++
      },
    },
    unreliable: { readyState: 'open', bufferedAmount: 0 },
  } as unknown as Connection
  const hooks = new PacketHooks()
  const session = new ProxySession(endpoint, undefined, undefined, hooks, defaultLimits, {
    close: (reason) => {
      throw new Error(reason)
    },
    ready: () => {},
    packetError: (reason) => {
      throw new Error(reason)
    },
  })
  session.setServerConnection(endpoint)
  const settings = Buffer.concat([uint(143), Buffer.from([1, 0, 0, 0])])
  for (const frame of fragmentPayload(encodePayload([settings])))
    session.receive('s2c', 'reliable', frame)
  if (mode === 'after') hooks.selector(9, { direction: 'c2s' }).after(() => {})
  if (mode === 'before-pass') hooks.selector(9, { direction: 'c2s' }).before(() => {})
  if (mode === 'before-rewrite') hooks.selector(9, { direction: 'c2s' }).before((buffer) => buffer)
  const run = (count: number) => {
    for (let i = 0; i < count; i++)
      for (const frame of input) session.receive('c2s', 'reliable', frame)
  }
  run(1000)
  frames = originalFrames = 0
  const cpu = process.cpuUsage()
  const start = performance.now()
  run(iterations)
  const elapsedMs = performance.now() - start
  const usage = process.cpuUsage(cpu)
  console.log(
    JSON.stringify({
      mode,
      iterations,
      packetsPerBatch: bodies.length,
      payloadBytes: input.reduce((sum, frame) => sum + frame.length, 0),
      elapsedMs,
      nsPerBatch: (elapsedMs * 1e6) / iterations,
      batchesPerSecond: (iterations * 1000) / elapsedMs,
      cpuMs: (usage.user + usage.system) / 1000,
      outputFrames: frames,
      originalFrames,
      scope: 'synchronous_js_relay_with_noop_DataChannel_not_network_RTT',
      node: process.version,
    }),
  )
  session.dispose()
}
