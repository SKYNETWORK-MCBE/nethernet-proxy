import type {
  AfterCallback,
  BeforeCallback,
  Direction,
  PacketSelector,
  PacketSubscriptionOptions,
} from './types'

interface Listeners {
  readonly before: readonly BeforeCallback[]
  readonly after: readonly AfterCallback[]
}
export interface HookSnapshot {
  readonly beforeCount: number
  readonly afterCount: number
  readonly packets: ReadonlyMap<number, Listeners>
}
const empty = (): HookSnapshot => ({ beforeCount: 0, afterCount: 0, packets: new Map() })

/** Copy-on-write on registration only. Each input batch keeps its immutable snapshot. */
export class PacketHooks {
  private closed = false
  private views: Record<Direction, HookSnapshot> = { c2s: empty(), s2c: empty() }
  snapshot(direction: Direction) {
    return this.views[direction]
  }
  clear() {
    this.closed = true
    this.views = { c2s: empty(), s2c: empty() }
  }
  selector(id: number, { direction }: PacketSubscriptionOptions = {}): PacketSelector {
    if (!Number.isInteger(id) || id < 0 || id > 1023) throw new Error('invalid_packet_id')
    if (direction !== undefined && direction !== 'c2s' && direction !== 's2c')
      throw new Error('invalid_packet_direction')
    const directions: Direction[] = direction ? [direction] : ['c2s', 's2c']
    const register = (phase: 'before' | 'after', callback: BeforeCallback | AfterCallback) => {
      if (this.closed) throw new Error('proxy_closed')
      if (typeof callback !== 'function' || callback.constructor.name === 'AsyncFunction')
        throw new Error('packet_callback_must_be_synchronous')
      // Unique wrapper so duplicate registrations can be removed independently.
      const entry = (buffer: Buffer, context: Parameters<BeforeCallback>[1]) =>
        callback(buffer, context)
      for (const dir of directions) {
        const view = this.views[dir]
        const packets = new Map(view.packets)
        const listeners = packets.get(id) ?? { before: [], after: [] }
        packets.set(id, { ...listeners, [phase]: [...listeners[phase], entry] })
        this.views[dir] = { ...view, [`${phase}Count`]: view[`${phase}Count`] + 1, packets }
      }
      let active = true
      return () => {
        if (!active) return
        active = false
        for (const dir of directions) {
          const view = this.views[dir]
          const packets = new Map(view.packets)
          const listeners = packets.get(id)
          if (!listeners) continue
          const next = { ...listeners, [phase]: listeners[phase].filter((item) => item !== entry) }
          if (next.before.length || next.after.length) packets.set(id, next)
          else packets.delete(id)
          this.views[dir] = { ...view, [`${phase}Count`]: view[`${phase}Count`] - 1, packets }
        }
      }
    }
    return { before: (cb) => register('before', cb), after: (cb) => register('after', cb) }
  }
}
