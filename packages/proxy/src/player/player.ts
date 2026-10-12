import type { SendOptions, ISession } from '@nethernet-proxy/relay';
import { DataPacket, TextPacket, TextType, TextVariant, TextVariantType, type ClientData } from '@serenityjs/protocol';
import type { PlayerIdentity } from '../identity';
import type { NetherNetProxy } from '../proxy';
import type { RawMessage, RawText } from '../types';
import { ScreenDisplay } from './screen-display';

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
  readonly onScreenDisplay = new ScreenDisplay(this);

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

  get persistentId() {
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

    this.send(pkt);
  }

  /** Client-proxy round-trip time in ms; undefined until measured. */
  getPing() {
    return this.session.getPing('client');
  }

  /** Proxy-server round-trip time in ms; undefined until measured. */
  getServerPing() {
    return this.session.getPing('server');
  }

  close(reason?: string) {
    return this.session.close(reason);
  }

  /** Serialized single packet; no chat/title API or delivery acknowledgement. */
  send(packet: DataPacket, options?: SendOptions) {
    if (this.closed) throw new Error('player_closed');

    const buffer = packet.serialize();

    return this.session.client.send(buffer, options);
  }
  
  sendToServer(packet: DataPacket, options?: SendOptions) {
    if (this.closed) throw new Error('player_closed');

    const buffer = packet.serialize();

    return this.session.server.send(buffer, options);
  }
}
