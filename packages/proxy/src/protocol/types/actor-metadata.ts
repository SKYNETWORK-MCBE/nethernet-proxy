import { BinaryStream, DataType, Endianness } from '@serenityjs/binarystream';

export enum ActorMetadataType {
  Float = 3,
  Long = 7,
}

export interface ActorMetadataItem {
  key: number;
  type: ActorMetadataType;
  value: number | bigint;
}

// 1.26.x metadata: key, type, then the legacy type again as one byte. Only the types we send.
export class ActorMetadata extends DataType {
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
