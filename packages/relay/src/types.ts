import type {
  ClientOptions as NetherNetClientOptions,
  Identity,
  ServerOptions as NetherNetServerOptions,
} from 'nethernet';
import type { SdpVerifier, VerifiedSdpIdentity } from './sdp-verifier';
import type { PublicUdpPorts } from './transport';

export type Direction = 'c2s' | 's2c';
export type Channel = 'reliable' | 'unreliable';
export type SendResult = 'sent' | 'queued';
export type Log = (event: string, fields: Record<string, unknown>) => void;
export interface PacketContext {
  readonly connectionId: string;
  readonly networkId?: string;
  readonly id: number;
  readonly direction: Direction;
  readonly channel: Channel;
}
export type BeforeCallback = (
  buffer: Buffer,
  context: PacketContext,
) => Buffer | null | undefined | void;
export type AfterCallback = (buffer: Buffer, context: PacketContext) => void;
export interface PacketSubscriptionOptions {
  direction?: Direction;
  channel?: Channel;
}
export interface PacketSelector {
  before(callback: BeforeCallback): () => void;
  after(callback: AfterCallback): () => void;
}
export interface SendOptions {
  channel?: Channel;
}
export interface SessionPeer {
  send(packet: Buffer, options?: SendOptions): SendResult;
}
/** Detached snapshot of the HTTP signaling request. Headers are caller-supplied. */
export interface SignalingRequest {
  readonly headers: Headers;
  readonly remoteAddress: string | undefined;
}
export interface ISession {
  readonly connectionId: string;
  readonly networkId?: string;
  readonly verifiedSignaling?: VerifiedSdpIdentity;
  /** HTTP request that delivered the offer; undefined when not signaled through the gateway. */
  readonly signalingRequest?: SignalingRequest;
  readonly client: SessionPeer;
  readonly server: SessionPeer;
  readonly ready: boolean;
  readonly closed: boolean;
  packetHandler(id: number, options?: PacketSubscriptionOptions): PacketSelector;
  /** Latest ICE round-trip time in ms between the proxy and `peer`; undefined until measured. */
  getPing(peer?: 'client' | 'server'): Promise<number | undefined>;
  close(reason?: string): Promise<void>;
}
export interface RelayEvents {
  sessionOpen: [session: ISession];
  sessionReady: [session: ISession];
  sessionClose: [session: ISession, reason: string];
  packetError: [session: ISession, reason: string, direction: Direction, channel: Channel];
  signalingRejected: [connectionId: string, reason: string];
}
export interface RelayLimits {
  maxQueueBytes: number;
  maxQueueMessages: number;
  maxPayloadBytes: number;
  fragmentSize: number;
  fragmentTimeoutMs: number;
}
export interface RelayOptions extends NetherNetServerOptions, Partial<RelayLimits> {
  serverUrl: string | URL;
  /** Proxy operator identity used to sign answers sent to the client, not the player's identity. */
  clientSideIdentity: Identity;
  /** Proxy account identity used to sign offers sent to the server. */
  serverSideIdentity?: Identity;
  /** Trusted verifier; the default authenticates using nethernet-gateway. */
  verifyOffer?: SdpVerifier;
  /** Connection options toward the server; the underlying SDK connector is a NetherNet Client. */
  serverOptions?: Omit<
    NetherNetClientOptions,
    'identity' | 'networkId' | 'connectionId' | 'webrtcBackend'
  >;
  /** Public address/ports forwarded to the client-side sockets, like BDS server-udp-ports. */
  publicUdp?: PublicUdpPorts;
  maxSessions?: number;
  maxPendingOffers?: number;
  offerTimeoutMs?: number;
  log?: Log;
}
/** @deprecated Use RelayOptions / RelayEvents. */
export type ProxyOptions = RelayOptions;
export type ProxyEvents = RelayEvents;
