import type { SendOptions, Session } from '@nethernet-proxy/relay'
import type { PlayerIdentity } from './identity'
import type { ClientData } from '@serenityjs/protocol'

export interface InitialPlayerState {
  readonly entityId: bigint
  readonly runtimeEntityId: bigint
  readonly gamemode: number
  readonly position: Readonly<{ x: number; y: number; z: number }>
  readonly dimension: number
  readonly pitch: number
  readonly yaw: number
}

export class Player {
  constructor(
    readonly session: Session,
    readonly identity: PlayerIdentity,
    readonly initialState: InitialPlayerState,
    readonly protocol: number | undefined,
    readonly clientData: ClientData,
  ) {}
  get connectionId() {
    return this.session.connectionId
  }
  get runtimeEntityId() {
    return this.initialState.runtimeEntityId
  }
  get closed() {
    return this.session.closed
  }
  close(reason?: string) {
    return this.session.close(reason)
  }
  /** Serialized single packet; no chat/title API or delivery acknowledgement. */
  send(packet: Buffer, options?: SendOptions) {
    if (this.closed) throw new Error('player_closed')
    return this.session.client.send(packet, options)
  }
  sendToServer(packet: Buffer, options?: SendOptions) {
    if (this.closed) throw new Error('player_closed')
    return this.session.server.send(packet, options)
  }
}
