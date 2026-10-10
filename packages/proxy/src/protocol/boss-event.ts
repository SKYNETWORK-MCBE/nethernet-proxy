import { Endianness, Float32, Uint8, VarString, ZigZong } from '@serenityjs/binarystream';
import { DataPacket, Packet } from '@serenityjs/protocol';
import { Proto, Serialize } from '@serenityjs/raknet';

export enum BossEventType {
  Show,
  RegisterPlayer,
  Hide,
  UnregisterPlayer,
  HealthPercentage,
  Title,
  AppearanceProperties,
  Texture,
  Request,
}

export enum BossBarColor {
  Pink,
  Blue,
  Red,
  Green,
  Yellow,
  Purple,
  RebeccaPurple,
  White,
}

export enum BossBarOverlay {
  Progress,
  Notched6,
  Notched10,
  Notched12,
  Notched20,
}

// Bedrock 1.26.50+ layout: every event type carries all fields.
@Proto(Packet.BossEvent)
export class BossEventPacket extends DataPacket {
  @Serialize(ZigZong)
  bossUniqueId!: bigint;

  @Serialize(Uint8)
  type!: BossEventType;

  @Serialize(VarString)
  title!: string;

  @Serialize(VarString)
  filteredTitle!: string;

  @Serialize(Float32, { endian: Endianness.Little })
  percent!: number;

  @Serialize(Uint8)
  color!: BossBarColor;

  @Serialize(Uint8)
  overlay!: BossBarOverlay;
}
