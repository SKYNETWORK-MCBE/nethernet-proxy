export { NetherNetProxy } from './proxy'
export type { GatewaySetup, NetherNetProxyOptions } from './proxy'
export { Player } from './player'
export type { InitialPlayerState } from './player'
export type { LoginIdentity, PlayerIdentity } from './identity'
export type { ClientData } from '@serenityjs/protocol'
export type { PlayerJoinEvent, PlayerSpawnEvent, PlayerLeaveEvent, ProxyEvents } from './events'
export {
  Relay,
  TransportGateway,
  proxyServerIdentity,
  authenticateTransport,
} from '@nethernet-proxy/relay'
export type { RelayOptions, TransportGatewayOptions, Session } from '@nethernet-proxy/relay'
