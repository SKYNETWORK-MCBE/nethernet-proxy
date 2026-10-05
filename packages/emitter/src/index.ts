export type EventName<Events> = Extract<keyof Events, string | symbol>;
export type Listener<Arguments extends readonly unknown[]> = (...args: Arguments) => unknown;
export type BeforeListener<Arguments extends readonly unknown[]> = (
  ...args: Arguments
) => boolean | void;
export interface SubscriptionState<Event extends string | symbol> {
  readonly event: Event;
  readonly listeners: number;
  readonly before: number;
  readonly total: number;
}
export interface ListenerErrorContext<Event extends string | symbol> {
  readonly event: Event;
  readonly phase: 'listener' | 'before' | 'subscriptions';
}
export interface EmitterOptions<Event extends string | symbol, Cancellable extends Event> {
  readonly cancellable?: readonly Cancellable[];
  readonly maxListeners?: number;
  readonly onError?: (error: unknown, context: ListenerErrorContext<Event>) => void;
  readonly onSubscriptionChange?: (state: SubscriptionState<Event>) => void;
}

type Callback = (...args: unknown[]) => unknown;
type Phase = 'listeners' | 'before';
interface Entry {
  readonly listener: Callback;
  readonly once: boolean;
  fired: boolean;
}
type ListenerList = readonly Entry[] & { warned?: boolean };
interface EventView {
  before: ListenerList;
  listeners: ListenerList;
}

/** EventEmitter-style subscriptions; emit() returns permission, not listener presence. */
export class Emitter<
  EVENTS extends { [Key in keyof EVENTS]: readonly unknown[] },
  CANCELLABLE extends EventName<EVENTS> = never,
> {
  private readonly views = new Map<EventName<EVENTS>, EventView>();
  private readonly cancellable: ReadonlySet<EventName<EVENTS>>;
  private readonly maxListeners: number;
  private changes: readonly ((state: SubscriptionState<EventName<EVENTS>>) => void)[] = [];
  private readonly pendingChanges: SubscriptionState<EventName<EVENTS>>[] = [];
  private notifyingChanges = false;

  constructor(private readonly options: EmitterOptions<EventName<EVENTS>, CANCELLABLE> = {}) {
    this.cancellable = new Set(options.cancellable);
    this.maxListeners = options.maxListeners ?? 10;
    if (typeof this.maxListeners !== 'number') throw new TypeError('max_listeners_must_be_number');
    if (Number.isNaN(this.maxListeners) || this.maxListeners < 0)
      throw new RangeError('invalid_max_listeners');
    if (options.onSubscriptionChange) this.onSubscriptionChange(options.onSubscriptionChange);
  }

  on<Key extends EventName<EVENTS>>(event: Key, listener: Listener<EVENTS[Key]>): this {
    this.checkListener(listener);
    return this.add(event, 'listeners', listener, false);
  }

  once<Key extends EventName<EVENTS>>(event: Key, listener: Listener<EVENTS[Key]>): this {
    this.checkListener(listener);
    return this.add(event, 'listeners', listener, true);
  }

  off<Key extends EventName<EVENTS>>(event: Key, listener: Listener<EVENTS[Key]>): this {
    this.checkListener(listener);
    return this.remove(event, 'listeners', listener);
  }

  before<Key extends CANCELLABLE>(event: Key, listener: BeforeListener<EVENTS[Key]>): this {
    this.checkBefore(event, listener);
    return this.add(event, 'before', listener, false);
  }

  onceBefore<Key extends CANCELLABLE>(event: Key, listener: BeforeListener<EVENTS[Key]>): this {
    this.checkBefore(event, listener);
    return this.add(event, 'before', listener, true);
  }

  offBefore<Key extends CANCELLABLE>(event: Key, listener: BeforeListener<EVENTS[Key]>): this {
    this.checkListener(listener);
    return this.remove(event, 'before', listener);
  }

  /** Both phases are snapshotted before dispatch. Cancellation skips notification listeners. */
  emit<Key extends EventName<EVENTS>>(event: Key, ...args: EVENTS[Key]): boolean {
    const view = this.views.get(event);
    if (!view) return true;
    const { before, listeners } = view;
    for (const entry of before)
      if (this.invoke(entry.listener, args, event, 'before', entry) === false) return false;
    for (const entry of listeners) this.invoke(entry.listener, args, event, 'listener', entry);
    return true;
  }

  listenerCount(event: EventName<EVENTS>): number {
    return this.views.get(event)?.listeners.length ?? 0;
  }

  beforeCount(event: EventName<EVENTS>): number {
    return this.views.get(event)?.before.length ?? 0;
  }

  hasListeners(event: EventName<EVENTS>): boolean {
    return this.listenerCount(event) + this.beforeCount(event) > 0;
  }

  subscriptions(event: EventName<EVENTS>): SubscriptionState<EventName<EVENTS>> {
    const listeners = this.listenerCount(event);
    const before = this.beforeCount(event);
    return Object.freeze({ event, listeners, before, total: listeners + before });
  }

  eventNames(): EventName<EVENTS>[] {
    return [...this.views.keys()];
  }

  /** Normal listeners only. Use clear() to remove both phases. */
  removeAllListeners(event?: EventName<EVENTS>): this {
    return this.removeAll('listeners', event);
  }

  removeAllBefore(event?: CANCELLABLE): this {
    return this.removeAll('before', event);
  }

  clear(): this {
    this.removeAllListeners();
    this.removeAllBefore();
    return this;
  }

  /** Fires synchronously after real registration/removal, including once consumption; no replay. */
  onSubscriptionChange(
    listener: (state: SubscriptionState<EventName<EVENTS>>) => void,
  ): () => void {
    this.checkListener(listener);
    if (listener.constructor.name === 'AsyncFunction')
      throw new TypeError('subscription_callback_must_be_synchronous');
    // A unique entry allows duplicate subscriptions to be removed independently.
    const entry = (state: SubscriptionState<EventName<EVENTS>>) => listener(state);
    this.changes = [...this.changes, entry];
    return () => {
      this.changes = this.changes.filter((callback) => callback !== entry);
    };
  }

  private checkListener(listener: unknown): asserts listener is Callback {
    if (typeof listener !== 'function') throw new TypeError('listener_must_be_function');
  }

  private checkBefore(event: EventName<EVENTS>, listener: unknown): asserts listener is Callback {
    if (!this.cancellable.has(event)) throw new TypeError('event_not_cancellable');
    this.checkListener(listener);
    if (listener.constructor.name === 'AsyncFunction')
      throw new TypeError('before_callback_must_be_synchronous');
  }

  private add(event: EventName<EVENTS>, phase: Phase, listener: Callback, once: boolean): this {
    let view = this.views.get(event);
    if (!view) {
      view = { before: [], listeners: [] };
      this.views.set(event, view);
    }
    const listeners: ListenerList = [...view[phase], { listener, once, fired: false }];
    listeners.warned = view[phase].warned;
    view[phase] = listeners;
    if (
      this.maxListeners &&
      listeners.length > Math.max(1, this.maxListeners) &&
      !listeners.warned
    ) {
      listeners.warned = true;
      process.emitWarning(
        Object.assign(
          new Error(`Possible Emitter memory leak: ${listeners.length} ${String(event)} ${phase}`),
          {
            name: 'MaxListenersExceededWarning',
            emitter: this,
            type: event,
            count: listeners.length,
          },
        ),
      );
    }
    this.changed(event);
    return this;
  }

  private remove(event: EventName<EVENTS>, phase: Phase, listener: Callback | Entry): this {
    const view = this.views.get(event);
    if (!view) return this;
    const listeners = view[phase];
    for (let index = listeners.length - 1; index >= 0; index--) {
      const entry = listeners[index];
      if (entry.listener !== listener && entry !== listener) continue;
      const next: ListenerList = listeners.toSpliced(index, 1);
      if (next.length > 1) next.warned = listeners.warned;
      view[phase] = next;
      if (!view.before.length && !view.listeners.length) this.views.delete(event);
      this.changed(event);
      break;
    }
    return this;
  }

  private removeAll(phase: Phase, event?: EventName<EVENTS>): this {
    // Keep the original entries: removal observers may register new ones with the same callback.
    // ponytail: O(n²) removal; add a bulk path if large listener sets need it.
    const views = event === undefined ? [...this.views] : [[event, this.views.get(event)] as const];
    for (const [name, view] of views) {
      const listeners = view?.[phase] ?? [];
      for (let index = listeners.length - 1; index >= 0; index--)
        this.remove(name, phase, listeners[index]);
    }
    return this;
  }

  private changed(event: EventName<EVENTS>) {
    if (!this.changes.length) return;
    this.pendingChanges.push(this.subscriptions(event));
    if (this.notifyingChanges) return;
    this.notifyingChanges = true;
    try {
      // Serialize reentrant changes so every observer sees the same transition order.
      for (let index = 0; index < this.pendingChanges.length; index++) {
        const state = this.pendingChanges[index];
        const changes = this.changes;
        for (const listener of changes)
          this.invoke(listener as Callback, [state], state.event, 'subscriptions');
      }
    } finally {
      this.pendingChanges.length = 0;
      this.notifyingChanges = false;
    }
  }

  private invoke(
    listener: Callback,
    args: readonly unknown[],
    event: EventName<EVENTS>,
    phase: ListenerErrorContext<EventName<EVENTS>>['phase'],
    entry?: Entry,
  ): unknown {
    if (entry?.once) {
      if (entry.fired) return;
      entry.fired = true;
      this.remove(event, phase === 'before' ? 'before' : 'listeners', entry);
    }
    let result: unknown;
    try {
      result = Reflect.apply(listener, this, args);
      if (isPromise(result)) {
        if (phase !== 'listener') {
          void Promise.resolve(result).catch(() => {});
          throw new TypeError(`${phase}_callback_must_be_synchronous`);
        }
        // Normal notification listeners are not awaited, as with EventEmitter.
        const context = Object.freeze({ event, phase });
        void Promise.resolve(result).catch((error: unknown) => {
          if (this.options.onError) this.options.onError(error, context);
          else
            process.nextTick(() => {
              throw error;
            });
        });
      } else if (phase === 'before' && result !== undefined && typeof result !== 'boolean') {
        throw new TypeError('invalid_before_result');
      }
    } catch (error) {
      if (!this.options.onError) throw error;
      this.options.onError(error, Object.freeze({ event, phase }));
      return phase === 'before' ? false : undefined;
    }
    return result;
  }
}

function isPromise(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}
