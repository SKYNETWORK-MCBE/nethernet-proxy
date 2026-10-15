import { BinaryStream, DataType } from '@serenityjs/binarystream';

/** An always-empty list (attributes, entity properties). */
export class EmptyList extends DataType {
  static read(stream: BinaryStream) {
    if (stream.readVarInt() !== 0) throw new Error('unsupported_non_empty_list');
    return [];
  }
  static write(stream: BinaryStream) {
    stream.writeVarInt(0);
  }
}
