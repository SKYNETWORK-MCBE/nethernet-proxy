import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'
import { setup, frames, packet } from './helpers/relay'
import { PacketHooks } from '../src/hooks'

test('shared hooks run before session hooks; duplicate registrations, channel filters and snapshot caching', () => {
  const global = new PacketHooks()
  const local = new PacketHooks(global)
  const seen: string[] = []
  global.selector(9).after(() => {
    seen.push('global')
  })
  const stop = local.selector(9, { direction: 'c2s', channel: 'reliable' }).after(() => {
    seen.push('local')
  })
  const view = local.snapshot('c2s', 'reliable')
  assert.equal(local.snapshot('c2s', 'reliable'), view)
  for (const cb of view.packets.get(9)!.after)
    cb(packet(), { connectionId: '1', id: 9, direction: 'c2s', channel: 'reliable' })
  assert.deepEqual(seen, ['global', 'local'])
  assert.equal(local.snapshot('c2s', 'unreliable').afterCount, 1)
  assert.equal(local.snapshot('s2c').afterCount, 1)
  stop()
  stop()
  assert.equal(local.snapshot('c2s').afterCount, 1)
  assert.equal(view.afterCount, 2)
  const cb = () => {}
  const first = local.selector(9).after(cb)
  const second = local.selector(9).after(cb)
  first()
  assert.equal(local.snapshot('c2s').afterCount, 2)
  second()
  assert.throws(() => local.selector(9, { channel: 'invalid' as 'reliable' }), /invalid_channel/)
})

test('session hooks keep the batch snapshot and return only that session/channel to raw after removal', () => {
  const shared = new PacketHooks()
  const a = setup({}, 1n, shared)
  const b = setup({}, 2n, shared)
  let count = 0
  const stop = a.session.packetHandler(9, { direction: 'c2s', channel: 'reliable' }).after(() => {
    count++
  })
  const input = frames([packet(), packet()], 2)
  a.session.receive('c2s', 'reliable', input[0])
  stop()
  for (const frame of input.slice(1)) a.session.receive('c2s', 'reliable', frame)
  assert.equal(count, 2)
  a.negotiate()
  b.negotiate()
  b.session.packetHandler(9, { direction: 'c2s' }).after(() => {})
  const reliableOnly = a.session
    .packetHandler(9, { direction: 'c2s', channel: 'reliable' })
    .after(() => {
      count++
    })
  const opaque = Buffer.from([0, 0xde, 0xad])
  b.session.receive('c2s', 'reliable', opaque)
  a.session.receive('c2s', 'unreliable', opaque)
  assert.deepEqual(a.errors, [])
  assert.deepEqual(b.errors, ['observation_decode_failed'])
  reliableOnly()
  a.session.receive('c2s', 'reliable', opaque)
  assert.equal(a.sent.at(-1)!.frame, opaque)
  assert.deepEqual(a.errors, [])
  const selector = a.session.packetHandler(9)
  a.session.dispose()
  assert.throws(() => selector.after(() => {}), /proxy_closed/)
  assert.throws(() => a.session.packetHandler(9), /session_closed/)
  b.session.dispose()
})
