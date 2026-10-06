import { EventEmitter } from 'node:events';
import type { Client as NetherNetClient, Connection } from 'nethernet';
import {
  ClientEndpoint,
  createServerConnector,
  useHttpSignaling,
  captureChannels,
  trackConnectionClose,
} from './transport';
import { PacketHooks } from './hooks';
import { ProxySession, defaultLimits } from './session';
import { createSdpVerifier } from './sdp-verifier';
import type { VerifiedSdpIdentity } from './sdp-verifier';
import type {
  PacketSubscriptionOptions,
  RelayEvents,
  RelayOptions,
  SendOptions,
  ISession,
  RelayLimits,
  Log,
} from './types';

interface Runtime {
  session: ProxySession;
  serverConnector?: NetherNetClient;
  clientConnectionClosed: () => Promise<void>;
  serverConnectionClosed?: () => Promise<void>;
}
export class Relay extends EventEmitter<RelayEvents> {
  readonly serverUrl: URL;
  readonly clientEndpoint: ClientEndpoint;
  readonly log: Log;
  private readonly hooks = new PacketHooks();
  private readonly active = new Map<bigint, Runtime>();
  private readonly limits: RelayLimits;
  private readonly options: RelayOptions;
  private readonly closing = new Map<bigint, Promise<void>>();
  private stopped = false;
  private shutdown?: Promise<void>;
  constructor(options: RelayOptions) {
    super();
    const {
      serverUrl,
      clientSideIdentity,
      verifyOffer = createSdpVerifier(),
      maxSessions = 128,
      maxPendingOffers = 8,
      offerTimeoutMs = 20000,
      log = () => {},
      ...rest
    } = options;
    const url = new URL(serverUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('invalid_server_url');
    if (!clientSideIdentity) throw new Error('client_side_identity_required');
    this.serverUrl = url;
    this.options = options;
    this.log = (event, fields) => {
      try {
        log(event, fields);
      } catch {
        /* diagnostics must not break relay */
      }
    };
    this.limits = { ...defaultLimits };
    for (const key of Object.keys(defaultLimits) as (keyof RelayLimits)[]) {
      const value = options[key] ?? defaultLimits[key];
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid_${key}`);
      this.limits[key] = value;
    }
    if (this.limits.fragmentSize > 10000) throw new Error('invalid_fragmentSize');
    for (const value of [maxSessions, maxPendingOffers, offerTimeoutMs])
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('invalid_admission_limits');
    this.clientEndpoint = new ClientEndpoint(
      {
        ...rest,
        webrtcBackend: options.webrtcBackend ?? 'werift',
        acceptTimeoutMs: options.acceptTimeoutMs ?? 20000,
      },
      (connection, networkId, verified) => this.attach(connection, networkId, verified),
    );
    this.clientEndpoint.identity = clientSideIdentity;
    this.clientEndpoint.offerVerifier = verifyOffer;
    this.clientEndpoint.maxSessions = maxSessions;
    this.clientEndpoint.maxPendingOffers = maxPendingOffers;
    this.clientEndpoint.offerTimeoutMs = offerTimeoutMs;
    this.clientEndpoint.onOfferRejected = (signal, reason) => {
      this.log('signaling_rejected', { connectionId: signal.connectionId.toString(), reason });
      this.notify('signalingRejected', signal.connectionId.toString(), reason);
    };
    this.clientEndpoint.on('closeConnection', (id, reason) => {
      void this.closeSession(id, reason);
    });
  }
  /** Read-only snapshot of public session handles; transport internals are not exposed here. */
  get sessions(): ReadonlyMap<string, ISession> {
    return new Map([...this.active.values()].map(({ session }) => [session.connectionId, session]));
  }
  packetHandler(id: number, options?: PacketSubscriptionOptions) {
    if (this.stopped) throw new Error('proxy_closed');
    return this.hooks.selector(id, options);
  }
  sendToClient(connectionId: string | bigint, packet: Buffer, options?: SendOptions) {
    return this.lookup(connectionId).client.send(packet, options);
  }
  sendToServer(connectionId: string | bigint, packet: Buffer, options?: SendOptions) {
    return this.lookup(connectionId).server.send(packet, options);
  }
  private lookup(id: string | bigint) {
    const runtime = this.active.get(BigInt(id));
    if (!runtime) throw new Error('unknown_connection');
    return runtime.session;
  }
  private notify<K extends keyof RelayEvents>(event: K, ...args: RelayEvents[K]) {
    // Normal EventEmitter listener order/once/off, but a consumer exception must not leak sockets.
    try {
      this.emit(event, ...(args as K extends keyof RelayEvents ? RelayEvents[K] : never));
    } catch {
      this.log('event_listener_failed', { event });
    }
  }
  private attach(clientConnection: Connection, networkId?: bigint, verified?: VerifiedSdpIdentity) {
    const id = clientConnection.address;
    const runtime: Runtime = {
      session: new ProxySession(
        clientConnection,
        networkId?.toString(),
        verified,
        this.hooks,
        this.limits,
        {
          close: (reason) => this.closeSession(id, reason),
          ready: () => this.notify('sessionReady', runtime.session),
          packetError: (reason, direction, channel) => {
            this.log('packet_error', { connectionId: id.toString(), reason, direction, channel });
            this.notify('packetError', runtime.session, reason, direction, channel);
          },
        },
      ),
      clientConnectionClosed: trackConnectionClose(clientConnection),
    };
    this.active.set(id, runtime);
    captureChannels(
      clientConnection,
      (channel, frame) => runtime.session.receive('c2s', channel, frame),
      (channel) => runtime.session.channelReady('s2c', channel),
    );
    this.notify('sessionOpen', runtime.session);
    if (this.stopped || runtime.session.closed) {
      void this.closeSession(id, 'proxy_closed');
      return;
    }
    try {
      const serverConnector = createServerConnector(
        0n,
        {
          responseTimeoutMs: 20000,
          inactivityTimeoutMs: 20000,
          ...this.options.serverOptions,
          identity: this.options.serverSideIdentity,
          webrtcBackend: this.options.webrtcBackend ?? 'werift',
        },
        (serverConnection) => {
          runtime.serverConnectionClosed = trackConnectionClose(serverConnection);
          runtime.session.setServerConnection(serverConnection);
          captureChannels(
            serverConnection,
            (channel, frame) => runtime.session.receive('s2c', channel, frame),
            (channel) => runtime.session.channelReady('c2s', channel),
          );
        },
      );
      runtime.serverConnector = serverConnector;
      serverConnector.on('error', () => {
        void this.closeSession(id, 'server_transport_failed');
      });
      serverConnector.on('disconnect', (_, reason) => {
        void this.closeSession(
          id,
          /^connecterror:\d+$/.test(reason) ? reason : 'server_disconnected',
        );
      });
      useHttpSignaling(serverConnector, this.serverUrl, {
        timeoutMs: this.options.offerTimeoutMs ?? 20000,
      });
      serverConnector.connect();
    } catch {
      void this.closeSession(id, 'server_setup_failed');
    }
  }
  closeSession(connectionId: string | bigint, reason = 'session_closed'): Promise<void> {
    const id = BigInt(connectionId);
    const existing = this.closing.get(id);
    if (existing) return existing;
    const runtime = this.active.get(id);
    if (!runtime) {
      this.clientEndpoint.connections.get(id)?.close(reason);
      return Promise.resolve();
    }
    runtime.session.dispose();
    this.active.delete(id);
    // Install before calling close(): nethernet emits disconnect synchronously.
    let resolve!: () => void;
    const completion = new Promise<void>((done) => {
      resolve = done;
    });
    this.closing.set(id, completion);
    const socketClosed = runtime.serverConnector
      ? new Promise<void>((done) => runtime.serverConnector!.socket.once('close', done))
      : Promise.resolve();
    runtime.serverConnector?.close(reason);
    runtime.session.clientConnection.close(reason);
    this.notify('sessionClose', runtime.session, reason);
    void Promise.all([
      socketClosed,
      runtime.clientConnectionClosed(),
      runtime.serverConnectionClosed?.(),
    ]).then(() => {
      this.closing.delete(id);
      resolve();
    });
    return completion;
  }
  close(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.stopped = true;
    for (const id of this.active.keys()) void this.closeSession(id, 'proxy_stopped');
    this.clientEndpoint.close('proxy_stopped');
    this.hooks.clear();
    this.shutdown = Promise.all(this.closing.values()).then(() => {});
    return this.shutdown;
  }
}
