/*!
 * Lifecycle handling based on SerenityJS (MIT).
 * Copyright (c) 2024 SerenityJS
 * See THIRD_PARTY_NOTICES.md in this package for the sources and full license.
 */
import { Emitter } from '@nethernet-proxy/emitter';
import { Relay, TransportGateway } from '@nethernet-proxy/relay';
import type {
  RelayOptions,
  RelayEvents,
  ISession,
  TransportGatewayOptions,
} from '@nethernet-proxy/relay';
import {
  LoginPacket,
  Packet,
  PlayStatus,
  PlayStatusPacket,
  SetLocalPlayerAsInitializedPacket,
  type ClientData,
} from '@serenityjs/protocol';
import { StartGamePacket } from './protocol';
import { loginIdentity } from './identity';
import type { PlayerIdentity } from './identity';
import { Player } from './player';
import type { InitialPlayerState } from './player';
import type { PlayerJoinEvent, ProxyEvents } from './events';
import { verifyLoginClientData } from './client-data';

export type GatewaySetup =
  | false
  | TransportGatewayOptions
  | TransportGateway
  | ((relay: Relay) => TransportGateway);

export type NetherNetProxyOptions = RelayOptions & {
  gateway?: GatewaySetup;
  requireClientData?: boolean;
  loginTimeoutMs?: number;
  maxPendingLogins?: number;
};

interface ConnectionState {
  readonly session: ISession;
  identity: PlayerIdentity;
  protocol?: number;
  clientData?: ClientData;
  joined: boolean;
  joinNotified: boolean;
  initialized: boolean;
  loginPending: boolean;
  stopLogin?: () => void;
  invalid: boolean;
  initialState?: InitialPlayerState;
  player?: Player;
  readonly hooks: (() => void)[];
}

export class NetherNetProxy extends Emitter<ProxyEvents> {
  readonly relay: Relay;
  readonly gateway?: TransportGateway;
  private readonly connections = new Map<string, ConnectionState>();
  private readonly activePlayers = new Map<string, Player>();
  private stopped = false;
  private shutdown?: Promise<void>;
  private pendingLogins = 0;
  private readonly loginTimeoutMs: number;
  private readonly maxPendingLogins: number;
  readonly requireClientData: boolean;

  constructor(options: NetherNetProxyOptions) {
    // Fixed diagnostics only: consumer errors can include tokens or packet bodies.
    super({
      onError: (_error, context) =>
        this.relay.log('event_listener_failed', { event: context.event, phase: context.phase }),
    });
    this.loginTimeoutMs = options.loginTimeoutMs ?? 5000;
    this.maxPendingLogins = options.maxPendingLogins ?? 8;
    this.requireClientData = options.requireClientData !== false;
    if (
      ![this.loginTimeoutMs, this.maxPendingLogins].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      ) ||
      this.loginTimeoutMs > 2_147_483_647
    )
      throw new Error('invalid_login_limits');
    this.relay = new Relay(options);
    const setup = options.gateway;
    try {
      this.gateway =
        setup === false
          ? undefined
          : setup instanceof TransportGateway
            ? setup
            : typeof setup === 'function'
              ? setup(this.relay)
              : new TransportGateway(this.relay, setup);
      if (this.gateway && this.gateway.relay !== this.relay)
        throw new Error('gateway_relay_mismatch');
    } catch (error) {
      void this.relay.close();
      throw error;
    }
    this.relay.prependListener('sessionOpen', this.open);
    this.relay.prependListener('sessionClose', this.leave);
    this.relay.on('sessionReady', this.ready);
    this.relay.on('packetError', this.packetError);
    this.relay.on('signalingRejected', this.signalingRejected);
    for (const session of this.relay.sessions.values()) this.open(session);
  }

  get players(): ReadonlyMap<string, Player> {
    return new Map(this.activePlayers);
  }

  get sessions() {
    return this.relay.sessions;
  }
  
  get closed() {
    return this.stopped;
  }

  getPlayer(connectionId: string | bigint) {
    return this.activePlayers.get(String(connectionId));
  }

  packetHandler(...args: Parameters<Relay['packetHandler']>) {
    return this.relay.packetHandler(...args);
  }

  async listen(port: number, host?: string) {
    if (this.stopped) throw new Error('proxy_closed');
    if (!this.gateway) throw new Error('gateway_disabled');
    return this.gateway.listen(port, host);
  }

  private readonly open = (session: ISession) => {
    if (this.stopped || session.closed || this.connections.has(session.connectionId)) return;
    const state: ConnectionState = {
      session,
      identity: Object.freeze({ verified: false }),
      joined: false,
      joinNotified: false,
      initialized: false,
      loginPending: false,
      invalid: false,
      hooks: [],
    };
    this.connections.set(session.connectionId, state);
    const observe = (id: number, direction: 'c2s' | 's2c', callback: (buffer: Buffer) => void) => {
      state.hooks.push(
        session.packetHandler(id, { direction, channel: 'reliable' }).after((buffer) => {
          if (
            this.stopped ||
            session.closed ||
            state.player ||
            this.connections.get(session.connectionId) !== state
          )
            return;
          // Initial implementation is main-player only; ignore subclient packets.
          let header = 0;
          for (let index = 0; index < 3; index++) {
            header |= (buffer[index] & 0x7f) << (index * 7);
            if (!(buffer[index] & 0x80)) break;
          }
          if (header & 0x3c00) return;
          try {
            callback(buffer);
          } catch {
            this.fail(state, 'lifecycle_decode_failed', id);
          }
        }),
      );
    };
    observe(Packet.Login, 'c2s', (buffer) => {
      if (state.protocol !== undefined || state.joined) return;
      const packet = new LoginPacket(buffer).deserialize();
      state.protocol = packet.protocol;
      try {
        state.identity = loginIdentity(packet.tokens.identity);
      } catch {
        this.relay.log('player_tracking_error', {
          connectionId: session.connectionId,
          reason: 'invalid_login_identity',
        });
      }
      this.readClientData(state, packet.tokens);
    });
    observe(Packet.PlayStatus, 's2c', (buffer) => {
      if (
        state.joined ||
        new PlayStatusPacket(buffer).deserialize().status !== PlayStatus.LoginSuccess
      )
        return;
      state.joined = true;
      if (this.requireClientData && !state.loginPending && !state.clientData)
        return this.clientDataFailed(state, 'client_data_required');
      if (state.invalid) this.unhook(state);
      this.notifyJoin(state);
    });
    observe(Packet.StartGame, 's2c', (buffer) => {
      if (state.invalid) return;
      if (!state.joined)
        return this.fail(state, 'start_game_before_login_success', Packet.StartGame);
      const packet = new StartGamePacket(buffer).deserialize();
      // BinaryStream's varint readers treat EOF as zero rather than throwing.
      if (packet.offset > buffer.length) throw new Error('truncated_start_game');
      if (state.initialState) {
        if (state.initialState.runtimeEntityId !== packet.runtimeEntityId)
          this.fail(state, 'runtime_entity_id_mismatch', Packet.StartGame);
        return;
      }
      const position = {
        x: packet.playerPosition.x,
        y: packet.playerPosition.y,
        z: packet.playerPosition.z,
      };
      if (
        packet.runtimeEntityId < 0n ||
        ![position.x, position.y, position.z, packet.pitch, packet.yaw].every(Number.isFinite)
      )
        return this.fail(state, 'invalid_start_game', Packet.StartGame);
      state.initialState = Object.freeze({
        entityId: packet.entityId,
        runtimeEntityId: packet.runtimeEntityId,
        gamemode: packet.playerGamemode,
        position: Object.freeze(position),
        dimension: packet.dimension,
        pitch: packet.pitch,
        yaw: packet.yaw,
      });
    });
    observe(Packet.SetLocalPlayerAsInitialized, 'c2s', (buffer) => {
      if (state.invalid || state.initialized) return;
      if (!state.joined || !state.initialState)
        return this.fail(
          state,
          'initialized_before_start_game',
          Packet.SetLocalPlayerAsInitialized,
        );
      const packet = new SetLocalPlayerAsInitializedPacket(buffer).deserialize();
      if (packet.runtimeEntityId !== state.initialState.runtimeEntityId)
        return this.fail(state, 'runtime_entity_id_mismatch', Packet.SetLocalPlayerAsInitialized);
      state.initialized = true;
      this.unhook(state);
      this.spawn(state);
    });
    this.emit('sessionOpen', session);
  };

  private readClientData(state: ConnectionState, tokens: LoginPacket['tokens']) {
    if (this.pendingLogins >= this.maxPendingLogins) {
      this.clientDataFailed(state, 'login_verification_busy');
      return;
    }
    state.loginPending = true;
    this.pendingLogins++;
    const finish = (
      result?: Awaited<ReturnType<typeof verifyLoginClientData>>,
      reason?: string,
    ) => {
      if (
        this.stopped ||
        state.session.closed ||
        this.connections.get(state.session.connectionId) !== state
      )
        return;
      // A late authenticated mismatch still rejects this session; other late results are ignored.
      if (!state.loginPending && reason !== 'identity_xuid_mismatch') return;
      state.stopLogin?.();
      if (reason) {
        this.clientDataFailed(state, reason);
        if (this.requireClientData || reason === 'identity_xuid_mismatch') return;
      }
      if (result) {
        state.clientData = result.clientData;
        state.identity = result.identity;
      }
      this.notifyJoin(state);
      this.spawn(state);
    };
    const timer = setTimeout(
      () => finish(undefined, 'login_verification_timeout'),
      this.loginTimeoutMs,
    );
    timer.unref();
    state.stopLogin = () => {
      clearTimeout(timer);
      state.loginPending = false;
      state.stopLogin = undefined;
    };
    // Keep the slot until underlying work settles, even after timeout/close; reconnects cannot bypass the cap.
    void verifyLoginClientData(tokens, state.session.verifiedSignaling?.xuid).then(
      (result) => {
        this.pendingLogins--;
        finish(result);
      },
      (error) => {
        this.pendingLogins--;
        finish(
          undefined,
          error instanceof Error && error.message === 'identity_xuid_mismatch'
            ? 'identity_xuid_mismatch'
            : 'login_verification_failed',
        );
      },
    );
  }

  private clientDataFailed(state: ConnectionState, reason: string) {
    this.relay.log('player_tracking_error', { connectionId: state.session.connectionId, reason });
    if (this.requireClientData || reason === 'identity_xuid_mismatch')
      void state.session.close(reason);
  }

  private notifyJoin(state: ConnectionState) {
    if (
      !state.joined ||
      state.joinNotified ||
      state.loginPending ||
      (this.requireClientData && !state.clientData)
    )
      return;
    state.joinNotified = true;
    this.emit('playerJoin', this.joinEvent(state));
  }

  private spawn(state: ConnectionState) {
    if (
      !state.joinNotified ||
      !state.initialized ||
      !state.initialState ||
      state.invalid ||
      state.player ||
      this.stopped ||
      state.session.closed ||
      this.connections.get(state.session.connectionId) !== state
    )
      return;
    state.player = new Player(
      this,
      state.session,
      state.identity,
      state.initialState,
      state.protocol,
      this.joinEvent(state).clientData,
    );
    this.activePlayers.set(state.session.connectionId, state.player);
    this.emit('playerSpawn', Object.freeze({ player: state.player, initialSpawn: true }));
  }

  private fail(state: ConnectionState, reason: string, id: number) {
    state.invalid = true;
    if (state.joined) this.unhook(state);
    this.relay.log('player_tracking_error', {
      connectionId: state.session.connectionId,
      reason,
      id,
    });
    if (this.requireClientData && id === Packet.Login) void state.session.close(reason);
  }

  private unhook(state: ConnectionState) {
    for (const stop of state.hooks.splice(0)) stop();
  }

  private joinEvent(state: ConnectionState): PlayerJoinEvent {
    return Object.freeze({
      connectionId: state.session.connectionId,
      session: state.session,
      identity: state.identity,
      protocol: state.protocol,
      clientData: (state.clientData ??= {} as ClientData), // fallback for failed verification; consumer can check identity.verified
    });
  }

  private readonly leave = (session: ISession, reason: string) => {
    const state = this.connections.get(session.connectionId);
    if (!state || state.session !== session) return;
    this.connections.delete(session.connectionId);
    this.activePlayers.delete(session.connectionId);
    this.unhook(state);
    state.stopLogin?.();
    if (reason !== 'identity_xuid_mismatch') this.notifyJoin(state);
    if (state.joinNotified) {
      this.emit(
        'playerLeave',
        Object.freeze({ ...this.joinEvent(state), player: state.player, reason }),
      );
    }
    this.emit('sessionClose', session, reason);
  };

  private readonly ready = (...args: RelayEvents['sessionReady']) => {
    this.emit('sessionReady', ...args);
  };

  private readonly packetError = (...args: RelayEvents['packetError']) => {
    this.emit('packetError', ...args);
  };
  
  private readonly signalingRejected = (...args: RelayEvents['signalingRejected']) => {
    this.emit('signalingRejected', ...args);
  };

  close(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.stopped = true;
    const completion = Promise.withResolvers<void>();
    this.shutdown = completion.promise;
    // Start both teardowns even if one fails; install shutdown before reentrant leave listeners.
    void Promise.allSettled([
      new Promise<void>((resolve) => resolve(this.gateway?.close())),
      new Promise<void>((resolve) => resolve(this.relay.close())),
    ]).then((results) => {
      for (const state of this.connections.values()) this.leave(state.session, 'proxy_stopped');
      this.relay.off('sessionOpen', this.open);
      this.relay.off('sessionClose', this.leave);
      this.relay.off('sessionReady', this.ready);
      this.relay.off('packetError', this.packetError);
      this.relay.off('signalingRejected', this.signalingRejected);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') completion.reject(failed.reason);
      else completion.resolve();
    });
    return this.shutdown;
  }
}
