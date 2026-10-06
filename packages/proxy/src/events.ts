import type { RelayEvents, ISession } from '@nethernet-proxy/relay';
import type { PlayerIdentity } from './identity';
import type { Player } from './player';
import type { ClientData } from '@serenityjs/protocol';

export interface PlayerJoinEvent {
  readonly connectionId: string;
  readonly session: ISession;
  readonly identity: PlayerIdentity;
  readonly protocol?: number;
  readonly clientData: ClientData;
}
export interface PlayerSpawnEvent {
  readonly player: Player;
  readonly initialSpawn: true;
}
export interface PlayerLeaveEvent extends PlayerJoinEvent {
  readonly player?: Player;
  readonly reason: string;
}
export interface ProxyEvents extends RelayEvents {
  playerJoin: [event: PlayerJoinEvent];
  playerSpawn: [event: PlayerSpawnEvent];
  playerLeave: [event: PlayerLeaveEvent];
}
