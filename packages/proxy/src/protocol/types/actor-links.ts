import { BinaryStream, DataType, Endianness } from '@serenityjs/binarystream';

export interface ActorLinkData {
  ridden: bigint;
  rider: bigint;
  type: number;
  immediate: boolean;
  riderInitiated: boolean;
}

export class ActorLinks extends DataType {
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
