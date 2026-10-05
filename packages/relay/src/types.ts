import type {
  ClientOptions as NetherNetClientOptions,
  Identity,
  ServerOptions as NetherNetServerOptions,
} from 'nethernet'
import type { SdpVerifier, VerifiedSdpIdentity } from './sdp-verifier'

export type Direction = 'c2s' | 's2c'
export type Channel = 'reliable' | 'unreliable'
export type SendResult = 'sent' | 'queued'
export type Log = (event: string, fields: Record<string, unknown>) => void
export interface PacketContext {
  readonly connectionId: string
  readonly networkId?: string
  readonly id: number
  readonly direction: Direction
  readonly channel: Channel
}
export type BeforeCallback = (
  buffer: Buffer,
  context: PacketContext,
) => Buffer | null | undefined | void
export type AfterCallback = (buffer: Buffer, context: PacketContext) => void
export interface PacketSubscriptionOptions {
  direction?: Direction
  channel?: Channel
}
export interface PacketSelector {
  before(callback: BeforeCallback): () => void
  after(callback: AfterCallback): () => void
}
export interface SendOptions {
  channel?: Channel
}
export interface SessionPeer {
  send(packet: Buffer, options?: SendOptions): SendResult
}
export interface Session {
  readonly connectionId: string
  readonly networkId?: string
  readonly verifiedSignaling?: VerifiedSdpIdentity
  readonly client: SessionPeer
  readonly server: SessionPeer
  readonly ready: boolean
  readonly closed: boolean
  packetHandler(id: number, options?: PacketSubscriptionOptions): PacketSelector
  close(reason?: string): Promise<void>
}
export interface RelayEvents {
  sessionOpen: [session: Session]
  sessionReady: [session: Session]
  sessionClose: [session: Session, reason: string]
  packetError: [session: Session, reason: string, direction: Direction, channel: Channel]
  signalingRejected: [connectionId: string, reason: string]
}
export interface RelayLimits {
  maxQueueBytes: number
  maxQueueMessages: number
  maxPayloadBytes: number
  fragmentSize: number
  fragmentTimeoutMs: number
}
export interface RelayOptions extends NetherNetServerOptions, Partial<RelayLimits> {
  serverUrl: string | URL
  /** Proxy operator identity used to sign answers sent to the client, not the player's identity. */
  clientSideIdentity: Identity
  /** Proxy account identity used to sign offers sent to the server. */
  serverSideIdentity?: Identity
  /** Trusted verifier; the default authenticates using nethernet-gateway. */
  verifyOffer?: SdpVerifier
  /** Connection options toward the server; the underlying SDK connector is a NetherNet Client. */
  serverOptions?: Omit<
    NetherNetClientOptions,
    'identity' | 'networkId' | 'connectionId' | 'webrtcBackend'
  >
  maxSessions?: number
  maxPendingOffers?: number
  offerTimeoutMs?: number
  log?: Log
}
/** @deprecated Use RelayOptions / RelayEvents. */
export type ProxyOptions = RelayOptions
export type ProxyEvents = RelayEvents
