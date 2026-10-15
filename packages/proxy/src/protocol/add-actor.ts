import { Endianness, Float32, VarLong, VarString, ZigZong } from '@serenityjs/binarystream';
import { DataPacket, Packet, Vector3f } from '@serenityjs/protocol';
import { Proto, Serialize } from '@serenityjs/raknet';
import {
  type ActorLinkData,
  ActorLinks,
  ActorMetadata,
  type ActorMetadataItem,
  EmptyList,
} from './types';

// Bedrock 1.26.50 layout. No attributes or entity properties.
@Proto(Packet.AddEntity)
export class AddActorPacket extends DataPacket {
  @Serialize(ZigZong)
  uniqueId!: bigint;

  @Serialize(VarLong)
  runtimeId!: bigint;

  @Serialize(VarString)
  identifier!: string;

  @Serialize(Vector3f)
  position!: Vector3f;

  @Serialize(Vector3f)
  velocity!: Vector3f;

  @Serialize(Float32, { endian: Endianness.Little })
  pitch = 0;

  @Serialize(Float32, { endian: Endianness.Little })
  yaw = 0;

  @Serialize(Float32, { endian: Endianness.Little })
  headYaw = 0;

  @Serialize(Float32, { endian: Endianness.Little })
  bodyYaw = 0;

  @Serialize(EmptyList)
  attributes: [] = [];

  @Serialize(ActorMetadata)
  metadata: ActorMetadataItem[] = [];

  @Serialize(EmptyList)
  intProperties: [] = [];

  @Serialize(EmptyList)
  floatProperties: [] = [];

  @Serialize(ActorLinks)
  links: ActorLinkData[] = [];
}
