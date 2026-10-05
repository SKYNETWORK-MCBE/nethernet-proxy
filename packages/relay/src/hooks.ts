import type {
  AfterCallback,
  BeforeCallback,
  Channel,
  Direction,
  PacketSelector,
  PacketSubscriptionOptions,
} from './types';

interface Listeners {
  readonly before: readonly BeforeCallback[];
  readonly after: readonly AfterCallback[];
}
export interface HookSnapshot {
  readonly beforeCount: number;
  readonly afterCount: number;
  readonly packets: ReadonlyMap<number, Listeners>;
}
const empty = (): HookSnapshot => ({ beforeCount: 0, afterCount: 0, packets: new Map() });
const views = () => ({
  c2s: { reliable: empty(), unreliable: empty() },
  s2c: { reliable: empty(), unreliable: empty() },
});

/** Copy-on-write registrations; merged views are cached. Each batch keeps its own snapshot. */
export class PacketHooks {
  private closed = false;
  private views = views();
  private readonly merged = new Map<
    string,
    { global: HookSnapshot; local: HookSnapshot; view: HookSnapshot }
  >();
  constructor(private readonly parent?: PacketHooks) {}
  snapshot(direction: Direction, channel: Channel = 'reliable'): HookSnapshot {
    const local = this.views[direction][channel];
    if (!this.parent) return local;
    const global = this.parent.snapshot(direction, channel);
    if (!local.beforeCount && !local.afterCount) return global;
    if (!global.beforeCount && !global.afterCount) return local;
    const key = `${direction}:${channel}`;
    const cached = this.merged.get(key);
    if (cached?.global === global && cached.local === local) return cached.view;
    const packets = new Map(global.packets);
    for (const [id, listeners] of local.packets) {
      const shared = packets.get(id);
      packets.set(
        id,
        shared
          ? {
              before: [...shared.before, ...listeners.before],
              after: [...shared.after, ...listeners.after],
            }
          : listeners,
      );
    }
    const view = {
      beforeCount: global.beforeCount + local.beforeCount,
      afterCount: global.afterCount + local.afterCount,
      packets,
    };
    this.merged.set(key, { global, local, view });
    return view;
  }
  clear() {
    this.closed = true;
    this.views = views();
    this.merged.clear();
  }
  selector(id: number, { direction, channel }: PacketSubscriptionOptions = {}): PacketSelector {
    if (!Number.isInteger(id) || id < 0 || id > 1023) throw new Error('invalid_packet_id');
    if (direction !== undefined && direction !== 'c2s' && direction !== 's2c')
      throw new Error('invalid_packet_direction');
    if (channel !== undefined && channel !== 'reliable' && channel !== 'unreliable')
      throw new Error('invalid_channel');
    const directions: Direction[] = direction ? [direction] : ['c2s', 's2c'];
    const channels: Channel[] = channel ? [channel] : ['reliable', 'unreliable'];
    const register = (phase: 'before' | 'after', callback: BeforeCallback | AfterCallback) => {
      if (this.closed) throw new Error('proxy_closed');
      if (typeof callback !== 'function' || callback.constructor.name === 'AsyncFunction')
        throw new Error('packet_callback_must_be_synchronous');
      // Unique wrapper so duplicate registrations can be removed independently.
      const entry = (buffer: Buffer, context: Parameters<BeforeCallback>[1]) =>
        callback(buffer, context);
      this.merged.clear();
      for (const dir of directions)
        for (const ch of channels) {
          const view = this.views[dir][ch];
          const packets = new Map(view.packets);
          const listeners = packets.get(id) ?? { before: [], after: [] };
          packets.set(id, { ...listeners, [phase]: [...listeners[phase], entry] });
          this.views[dir][ch] = { ...view, [`${phase}Count`]: view[`${phase}Count`] + 1, packets };
        }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        this.merged.clear();
        for (const dir of directions)
          for (const ch of channels) {
            const view = this.views[dir][ch];
            const packets = new Map(view.packets);
            const listeners = packets.get(id);
            if (!listeners) continue;
            const next = {
              ...listeners,
              [phase]: listeners[phase].filter((item) => item !== entry),
            };
            if (next.before.length || next.after.length) packets.set(id, next);
            else packets.delete(id);
            this.views[dir][ch] = {
              ...view,
              [`${phase}Count`]: view[`${phase}Count`] - 1,
              packets,
            };
          }
      };
    };
    return { before: (cb) => register('before', cb), after: (cb) => register('after', cb) };
  }
}
