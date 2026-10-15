import type { BinaryStream } from '@serenityjs/binarystream';

type StreamClass = new (...args: any[]) => BinaryStream;

/**
 * 信頼できない入力を読むための mixin。DataPacket も BinaryStream なので、パケットクラスにもそのまま掛けられる。
 * 本家の validateOffset は書き込み用に 0 埋めでバッファを伸ばすため、読み込みでも EOF を越えて 0 が返り、
 * 壊れた長さフィールドが巨大ループや巨大確保になる。ここでは伸ばさずに throw する。
 * VarInt / VarLong は validateOffset を通らず `buffer[offset++] || 0` で読むので、読んだ後に offset を検査する。
 * 読み込み専用 (伸ばせないので write 系は throw する)。
 */
export function SafeRead<T extends StreamClass>(Base: T) {
  return class SafeRead extends Base {
    override validateOffset(length: number): boolean {
      if (this.offset < 0 || length < 0 || this.offset + length > this.buffer.length)
        throw new Error('truncated_packet');
      return true;
    }

    override readVarInt(): number {
      return this.checked(super.readVarInt());
    }
    override readVarLong(): bigint {
      return this.checked(super.readVarLong());
    }
    override readZigZag(): number {
      return this.checked(super.readZigZag());
    }
    override readZigZong(): bigint {
      return this.checked(super.readZigZong());
    }

    checked<V>(value: V): V {
      if (this.offset > this.buffer.length) throw new Error('truncated_packet');
      return value;
    }
  };
}
