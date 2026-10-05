/*!
 * Adapted from SerenityJS StartGamePacket (MIT).
 * Copyright (c) 2024 SerenityJS
 * See THIRD_PARTY_NOTICES.md in this package for the source and full license.
 */
import {
  Endianness,
  Float32,
  Int16,
  Uint64,
  VarLong,
  VarString,
  ZigZag,
  ZigZong,
} from '@serenityjs/binarystream';
import { DataPacket, Packet, Vector3f } from '@serenityjs/protocol';
import { Proto, Serialize } from '@serenityjs/raknet';

// ponytail: initial-state prefix only; update if Bedrock changes the layout through dimension.
// Not a complete StartGame packet for sending.
@Proto(Packet.StartGame)
export class StartGamePacket extends DataPacket {
  @Serialize(ZigZong)
  entityId!: bigint;

  @Serialize(VarLong)
  runtimeEntityId!: bigint;

  @Serialize(ZigZag)
  playerGamemode!: number;

  @Serialize(Vector3f)
  playerPosition!: Vector3f;

  @Serialize(Float32, { endian: Endianness.Little })
  pitch!: number;

  @Serialize(Float32, { endian: Endianness.Little })
  yaw!: number;

  @Serialize(Uint64, { endian: Endianness.Little })
  seed!: bigint;

  @Serialize(Int16, { endian: Endianness.Little })
  biomeType!: number;

  @Serialize(VarString)
  biomeName!: string;

  @Serialize(ZigZag)
  dimension!: number;
}
