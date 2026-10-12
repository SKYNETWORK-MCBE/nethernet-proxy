import type { Connection } from 'nethernet';
import {
  encodePayload,
  fragmentPayload,
  decodePayload,
  networkSettings,
  preserveSubclients,
} from './framing';
import type { Compression, FramedPacket } from './framing';
import { PacketHooks } from './hooks';
import type { HookSnapshot } from './hooks';
import type {
  Channel,
  Direction,
  PacketContext,
  PacketSubscriptionOptions,
  RelayLimits,
  SendOptions,
  SendResult,
  ISession,
  SessionPeer,
  SignalingRequest,
} from './types';
import type { VerifiedSdpIdentity } from './sdp-verifier';

interface Stream {
  remaining: number | null;
  bytes: number;
  hooks?: HookSnapshot;
  compression?: Compression;
  decode: boolean;
  frames?: Buffer[];
  parts?: Buffer[];
  queue: Buffer[];
  injected: Buffer[][];
  processing: boolean;
  timer?: NodeJS.Timeout;
}
const stream = (): Stream => ({
  remaining: null,
  bytes: 0,
  decode: false,
  queue: [],
  injected: [],
  processing: false,
});
export interface SessionCallbacks {
  close(reason: string): Promise<void>;
  ready(): void;
  packetError(reason: string, direction: Direction, channel: Channel): void;
}
export const defaultLimits: RelayLimits = {
  maxQueueBytes: 8 * 1024 * 1024,
  maxQueueMessages: 4096,
  maxPayloadBytes: 8 * 1024 * 1024,
  fragmentSize: 10000,
  fragmentTimeoutMs: 20000,
};

/** Per-player relay state. Transport creation/authentication belong to Relay. */
export class ProxySession implements ISession {
  readonly connectionId: string;
  readonly client: SessionPeer;
  readonly server: SessionPeer;
  private streams: Record<Direction, Record<Channel, Stream>> = {
    c2s: { reliable: stream(), unreliable: stream() },
    s2c: { reliable: stream(), unreliable: stream() },
  };
  private compression: { client?: Compression; server?: Compression } = {};
  private ended = false;
  private becameReady = false;
  private pendingBytes = 0;
  private pendingMessages = 0;
  private heldBytes = 0;
  private heldMessages = 0;
  private serverConnection: Connection | null = null;
  private readonly hooks: PacketHooks;
  constructor(
    readonly clientConnection: Connection,
    readonly networkId: string | undefined,
    readonly verifiedSignaling: VerifiedSdpIdentity | undefined,
    readonly signalingRequest: SignalingRequest | undefined,
    hooks: PacketHooks,
    private readonly limits: RelayLimits,
    private readonly callbacks: SessionCallbacks,
  ) {
    this.connectionId = clientConnection.address.toString();
    this.hooks = new PacketHooks(hooks);
    this.client = Object.freeze({
      send: (buffer: Buffer, options?: SendOptions) => this.send('s2c', buffer, options),
    });
    this.server = Object.freeze({
      send: (buffer: Buffer, options?: SendOptions) => this.send('c2s', buffer, options),
    });
  }
  get closed() {
    return this.ended;
  }
  get ready() {
    return this.becameReady && !this.ended;
  }
  get queuedBytes() {
    return this.pendingBytes + this.heldBytes;
  }
  get queuedMessages() {
    return this.pendingMessages + this.heldMessages;
  }
  close(reason = 'session_closed') {
    return this.callbacks.close(reason);
  }
  packetHandler(id: number, options?: PacketSubscriptionOptions) {
    if (this.ended) throw new Error('session_closed');
    return this.hooks.selector(id, options);
  }
  async getPing(peer: 'client' | 'server' = 'client') {
    const connection = peer === 'client' ? this.clientConnection : this.serverConnection;
    if (this.ended || !connection?.rtcConnection) return undefined;
    const stats = await connection.rtcConnection.getStats();
    for (const s of stats.values()) {
      if (s.type === 'candidate-pair' && s.nominated && s.currentRoundTripTime != null)
        return s.currentRoundTripTime * 1000;
    }
    return undefined;
  }
  setServerConnection(serverConnection: Connection) {
    this.serverConnection = serverConnection;
  }
  channelReady(direction: Direction, channel: Channel) {
    if (this.ended) return;
    this.flush(direction, channel);
    if (
      !this.ended &&
      !this.becameReady &&
      this.clientConnection.reliable?.readyState === 'open' &&
      this.clientConnection.unreliable?.readyState === 'open' &&
      this.serverConnection?.reliable?.readyState === 'open' &&
      this.serverConnection.unreliable?.readyState === 'open'
    ) {
      this.becameReady = true;
      this.callbacks.ready();
    }
  }
  private destination(direction: Direction) {
    return direction === 'c2s' ? this.serverConnection : this.clientConnection;
  }
  private bufferedBytes() {
    return (
      (this.clientConnection.reliable?.bufferedAmount ?? 0) +
      (this.clientConnection.unreliable?.bufferedAmount ?? 0) +
      (this.serverConnection?.reliable?.bufferedAmount ?? 0) +
      (this.serverConnection?.unreliable?.bufferedAmount ?? 0)
    );
  }
  private reserve(bytes: number, messages: number) {
    if (
      this.queuedBytes + this.bufferedBytes() + bytes > this.limits.maxQueueBytes ||
      this.queuedMessages + messages > this.limits.maxQueueMessages
    ) {
      void this.close('backpressure_limit');
      throw new Error('backpressure_limit');
    }
  }
  /** Atomically check capacity for a complete output fragment train before accepting it. */
  private submit(direction: Direction, channel: Channel, frames: readonly Buffer[]): SendResult {
    if (this.ended) throw new Error('session_closed');
    const state = this.streams[direction][channel];
    const dc = this.destination(direction)?.[channel];
    const bytes = frames.reduce((sum, frame) => sum + frame.length, 0);
    const queued = state.queue.length > 0 || dc?.readyState !== 'open';
    this.reserve(bytes, queued ? frames.length : 0);
    if (queued) {
      state.queue.push(...frames);
      this.pendingBytes += bytes;
      this.pendingMessages += frames.length;
      return 'queued';
    }
    try {
      for (const frame of frames) dc!.send(frame as Buffer<ArrayBuffer>);
    } catch {
      void this.close('forward_failed');
      throw new Error('forward_failed');
    }
    return 'sent';
  }
  private forward(direction: Direction, channel: Channel, frame: Buffer) {
    // Hot path: no array allocation for each original DataChannel message.
    if (this.ended) throw new Error('session_closed');
    const state = this.streams[direction][channel];
    const dc = this.destination(direction)?.[channel];
    const queued = state.queue.length > 0 || dc?.readyState !== 'open';
    this.reserve(frame.length, queued ? 1 : 0);
    if (queued) {
      state.queue.push(frame);
      this.pendingBytes += frame.length;
      this.pendingMessages++;
    } else {
      try {
        dc!.send(frame as Buffer<ArrayBuffer>);
      } catch {
        void this.close('forward_failed');
        throw new Error('forward_failed');
      }
    }
  }
  private flush(direction: Direction, channel: Channel) {
    const state = this.streams[direction][channel];
    if (this.destination(direction)?.[channel]?.readyState !== 'open') return;
    const frames = state.queue;
    state.queue = [];
    for (const frame of frames) {
      this.pendingBytes -= frame.length;
      this.pendingMessages--;
    }
    try {
      if (frames.length) this.submit(direction, channel, frames);
    } catch {
      /* submit closes the session on failure */
    }
  }
  private send(
    direction: Direction,
    packet: Buffer,
    { channel = 'reliable' }: SendOptions = {},
  ): SendResult {
    if (this.ended) throw new Error('session_closed');
    if (channel !== 'reliable' && channel !== 'unreliable') throw new Error('invalid_channel');
    if (!Buffer.isBuffer(packet) || !packet.length) throw new Error('invalid_packet_buffer');
    const compression = direction === 'c2s' ? this.compression.server : this.compression.client;
    if (!compression) throw new Error('compression_unknown');
    // encodePayload owns the output bytes; subsequent caller mutations cannot affect queued data.
    const frames = fragmentPayload(
      encodePayload([packet], compression, this.limits.maxPayloadBytes),
      this.limits.fragmentSize,
    );
    const state = this.streams[direction][channel];
    if (state.remaining !== null || state.processing) {
      const bytes = frames.reduce((sum, frame) => sum + frame.length, 0);
      this.reserve(bytes, frames.length);
      state.injected.push(frames);
      this.pendingBytes += bytes;
      this.pendingMessages += frames.length;
      return 'queued';
    }
    return this.submit(direction, channel, frames);
  }
  private finishInjections(direction: Direction, channel: Channel) {
    const state = this.streams[direction][channel];
    const pending = state.injected;
    state.injected = [];
    for (const frames of pending) {
      for (const frame of frames) {
        this.pendingBytes -= frame.length;
        this.pendingMessages--;
      }
      if (this.ended) return;
      this.submit(direction, channel, frames);
    }
  }
  private context(id: number, direction: Direction, channel: Channel): PacketContext {
    return Object.freeze({
      connectionId: this.connectionId,
      networkId: this.networkId,
      id,
      direction,
      channel,
    });
  }
  private releaseHeld(state: Stream) {
    if (state.frames)
      for (const frame of state.frames) {
        this.heldBytes -= frame.length;
        this.heldMessages--;
      }
    state.frames = undefined;
  }
  private reset(state: Stream) {
    clearTimeout(state.timer);
    state.timer = undefined;
    this.releaseHeld(state);
    state.remaining = null;
    state.bytes = 0;
    state.parts = undefined;
    state.hooks = undefined;
    state.compression = undefined;
    state.decode = false;
  }
  receive(direction: Direction, channel: Channel, frame: Buffer) {
    if (this.ended) return;
    const state = this.streams[direction][channel];
    try {
      if (frame.length < 2) throw new Error('truncated_fragment');
      if (state.remaining !== null && frame[0] !== state.remaining - 1) {
        // Lost/reordered unreliable fragments are not a reliable-stream protocol violation.
        if (channel === 'reliable') throw new Error('fragment_sequence');
        this.callbacks.packetError('fragment_sequence', direction, channel);
        this.reset(state);
        this.finishInjections(direction, channel);
      }
      if (state.remaining === null) {
        state.hooks = this.hooks.snapshot(direction, channel);
        state.compression = direction === 'c2s' ? this.compression.client : this.compression.server;
        state.decode =
          state.hooks.beforeCount > 0 ||
          state.hooks.afterCount > 0 ||
          (direction === 's2c' && !this.compression.server);
        if (state.decode) state.parts = [];
        if (state.hooks.beforeCount) state.frames = [];
        if (frame[0]) {
          state.timer = setTimeout(() => {
            if (channel === 'reliable') {
              void this.close('fragment_timeout');
              return;
            }
            this.callbacks.packetError('fragment_timeout', direction, channel);
            this.reset(state);
            try {
              this.finishInjections(direction, channel);
            } catch {
              /* output failure already closed the session */
            }
          }, this.limits.fragmentTimeoutMs);
          state.timer.unref();
        }
      }
      state.remaining = frame[0];
      state.bytes += frame.length - 1;
      if (state.bytes > this.limits.maxPayloadBytes) throw new Error('payload_limit');
      if (state.frames) {
        this.reserve(frame.length, 1);
        state.frames.push(frame);
        this.heldBytes += frame.length;
        this.heldMessages++;
      } else this.forward(direction, channel, frame);
      if (this.ended) return;
      state.parts?.push(frame.subarray(1));
      if (state.remaining) return;
      state.processing = true;
      if (state.decode) this.complete(direction, channel, state);
      if (this.ended) return;
      this.reset(state);
      state.processing = false;
      this.finishInjections(direction, channel);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'packet_processing_failed';
      if (!this.ended) {
        this.callbacks.packetError(reason, direction, channel);
        void this.close(reason);
      }
    }
  }
  private complete(direction: Direction, channel: Channel, state: Stream) {
    const view = state.hooks!;
    const parts = state.parts!;
    const payload = parts.length === 1 ? parts[0] : Buffer.concat(parts, state.bytes);
    let packets: FramedPacket[];
    try {
      packets = decodePayload(payload, {
        compression: !!state.compression,
        maxBytes: this.limits.maxPayloadBytes,
      }).packets;
    } catch {
      if (view.beforeCount) throw new Error('before_decode_failed');
      this.callbacks.packetError('observation_decode_failed', direction, channel);
      return;
    }
    let negotiated: Compression | undefined;
    if (direction === 's2c' && !this.compression.server) {
      const settings = packets.find((packet) => packet.id === 143);
      if (settings) negotiated = networkSettings(settings);
    }
    const output: { packet: FramedPacket; bytes: Buffer }[] = [];
    let changed = false;
    for (const packet of packets) {
      let bytes: Buffer | null = packet.bytes;
      const listeners = view.packets.get(packet.id);
      if (listeners?.before.length) {
        const context = this.context(packet.id, direction, channel);
        for (const callback of listeners.before) {
          let result;
          try {
            result = callback(Buffer.from(bytes!), context);
          } catch {
            throw new Error('before_callback_failed');
          }
          if (this.ended) return;
          if (result === null) {
            bytes = null;
            changed = true;
            break;
          }
          if (result !== undefined) {
            if (!Buffer.isBuffer(result)) {
              discardPromise(result);
              throw new Error('invalid_before_result');
            }
            if (result.length > this.limits.maxPayloadBytes) throw new Error('payload_limit');
            bytes = preserveSubclients(result, packet.header);
            changed = true;
          }
        }
      }
      if (bytes) output.push({ packet, bytes });
    }
    // The original NetworkSettings establishes state. Rewriting/dropping it is unsupported.
    if (negotiated) this.compression.server = negotiated;
    if (view.beforeCount) {
      const original = state.frames!;
      this.releaseHeld(state);
      if (!changed) this.submit(direction, channel, original);
      else if (output.length)
        this.submit(
          direction,
          channel,
          fragmentPayload(
            encodePayload(
              output.map((item) => item.bytes),
              state.compression,
              this.limits.maxPayloadBytes,
            ),
            this.limits.fragmentSize,
          ),
        );
    }
    if (this.ended) return;
    if (negotiated) this.compression.client = negotiated;
    if (!view.afterCount) return;
    for (const { packet, bytes } of output) {
      const listeners = view.packets.get(packet.id)?.after;
      if (!listeners?.length) continue;
      const context = this.context(packet.id, direction, channel);
      for (const callback of listeners) {
        if (this.ended) return;
        try {
          const result: unknown = callback(Buffer.from(bytes), context);
          if (isPromise(result)) {
            discardPromise(result);
            this.callbacks.packetError('async_after_result', direction, channel);
          }
        } catch {
          this.callbacks.packetError('after_callback_failed', direction, channel);
        }
      }
    }
  }
  /** Logical teardown, before transport close (which may complete asynchronously). */
  dispose() {
    if (this.ended) return;
    this.ended = true;
    this.hooks.clear();
    for (const dir of ['c2s', 's2c'] as const)
      for (const channel of ['reliable', 'unreliable'] as const) {
        const state = this.streams[dir][channel];
        this.reset(state);
        state.queue = [];
        state.injected = [];
        state.processing = false;
      }
    this.pendingBytes = this.pendingMessages = this.heldBytes = this.heldMessages = 0;
    this.compression = {};
  }
}
function isPromise(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}
function discardPromise(value: unknown) {
  if (isPromise(value)) void Promise.resolve(value).catch(() => {});
}
