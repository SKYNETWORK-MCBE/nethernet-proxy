import {
  BinaryStream,
  DataType,
  Endianness,
  Float32,
  VarLong,
  VarString,
  ZigZong,
} from '@serenityjs/binarystream';
import { DataPacket, Packet, Vector3f } from '@serenityjs/protocol';
import { Proto, Serialize } from '@serenityjs/raknet';

export enum ActorMetadataType {
  Float = 3,
  Long = 7,
}

export interface ActorMetadataItem {
  key: number;
  type: ActorMetadataType;
  value: number | bigint;
}

export interface ActorLinkData {
  ridden: bigint;
  rider: bigint;
  type: number;
  immediate: boolean;
  riderInitiated: boolean;
}

/** An always-empty list (attributes, entity properties). */
class EmptyList extends DataType {
  static read(stream: BinaryStream) {
    if (stream.readVarInt() !== 0) throw new Error('unsupported_non_empty_list');
    return [];
  }
  static write(stream: BinaryStream) {
    stream.writeVarInt(0);
  }
}

// 1.26.x metadata: key, type, then the legacy type again as one byte. Only the types we send.
class ActorMetadata extends DataType {
  static read(stream: BinaryStream): ActorMetadataItem[] {
    return Array.from({ length: stream.readVarInt() }, () => {
      const key = stream.readVarInt();
      const type = stream.readVarInt();
      stream.readUint8();
      if (type === ActorMetadataType.Float)
        return { key, type, value: stream.readFloat32(Endianness.Little) };
      if (type === ActorMetadataType.Long) return { key, type, value: stream.readZigZong() };
      throw new Error('unsupported_metadata_type');
    });
  }
  static write(stream: BinaryStream, items: ActorMetadataItem[]) {
    stream.writeVarInt(items.length);
    for (const item of [...items].sort((a, b) => a.key - b.key)) {
      stream.writeVarInt(item.key);
      stream.writeVarInt(item.type);
      stream.writeUint8(item.type);
      if (item.type === ActorMetadataType.Float)
        stream.writeFloat32(Number(item.value), Endianness.Little);
      else stream.writeZigZong(BigInt(item.value));
    }
  }
}

class ActorLinks extends DataType {
  static read(stream: BinaryStream): ActorLinkData[] {
    return Array.from({ length: stream.readVarInt() }, () => {
      const link = {
        ridden: stream.readZigZong(),
        rider: stream.readZigZong(),
        type: stream.readUint8(),
        immediate: stream.readBool(),
        riderInitiated: stream.readBool(),
      };
      stream.readFloat32(Endianness.Little);
      return link;
    });
  }
  static write(stream: BinaryStream, links: ActorLinkData[]) {
    stream.writeVarInt(links.length);
    for (const link of links) {
      stream.writeZigZong(link.ridden);
      stream.writeZigZong(link.rider);
      stream.writeUint8(link.type);
      stream.writeBool(link.immediate);
      stream.writeBool(link.riderInitiated);
      stream.writeFloat32(0, Endianness.Little);
    }
  }
}

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
