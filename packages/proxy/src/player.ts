import type { SendOptions, ISession } from '@nethernet-proxy/relay';
import { TextPacket, TextType, TextVariant, TextVariantType, type ClientData } from '@serenityjs/protocol';
import type { PlayerIdentity } from './identity';
import type { NetherNetProxy } from './proxy';
import type { RawMessage, RawText } from './types';

export interface InitialPlayerState {
  readonly entityId: bigint;
  readonly runtimeEntityId: bigint;
  readonly gamemode: number;
  readonly position: Readonly<{ x: number; y: number; z: number }>;
  readonly dimension: number;
  readonly pitch: number;
  readonly yaw: number;
}

export class Player {
  constructor(
    private readonly proxy: NetherNetProxy,
    readonly session: ISession,
    readonly identity: PlayerIdentity,
    readonly initialState: InitialPlayerState,
    readonly protocol: number | undefined,
    readonly clientData: ClientData,
  ) {}

  get connectionId() {
    return this.session.connectionId;
  }

  get xuid(): string {
    if (!this.identity.xuid && !this.proxy.requireClientData) throw new Error('Failed to read player identity');
    return this.identity.xuid as string;
  }

  get name() {
    if (!this.identity.name && !this.proxy.requireClientData) throw new Error('Failed to read player identity');
    return this.identity.name;
  }

  get pfid() {
    if (!this.identity.persistentId && !this.proxy.requireClientData) throw new Error('Failed to read player identity');
    return this.identity.persistentId;
  }

  get runtimeEntityId() {
    return this.initialState.runtimeEntityId;
  }

  get closed() {
    return this.session.closed;
  }

  sendMessage(message: string | RawMessage) {
    const rawText: RawText = {};
    rawText.rawtext = typeof message === 'string' ? [{ text: message }] : message.rawtext;
    
    const pkt = new TextPacket();
    pkt.isLocalized = true;
    pkt.variantType = TextVariantType.MessageOnly;
    pkt.variant = new TextVariant(JSON.stringify(rawText), TextType.Json);
    pkt.xuid = '';
    pkt.platformChatId = '';

    this.send(pkt.serialize());
  }

  close(reason?: string) {
    return this.session.close(reason);
  }

  /** Serialized single packet; no chat/title API or delivery acknowledgement. */
  send(packet: Buffer, options?: SendOptions) {
    if (this.closed) throw new Error('player_closed');
    return this.session.client.send(packet, options);
  }
  
  sendToServer(packet: Buffer, options?: SendOptions) {
    if (this.closed) throw new Error('player_closed');
    return this.session.server.send(packet, options);
  }
}
