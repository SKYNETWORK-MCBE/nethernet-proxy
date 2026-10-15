/*!
 * Copied from SerenityJS main (MIT), unreleased as of @serenityjs/protocol 0.8.21.
 * [Serenity] 0.8.21 の Uuid.read は受信バッファをその場で反転する (転送するパケットが壊れる) ため main 版を使う。
 * Delete once the release that includes it is adopted.
 * 印: [MC] 0.8.21 から最新版マイクラ (1.26.51, protocol 2193) で変わった箇所 (https://mojang.github.io/bedrock-protocol-docs/1.26.51/)
 *     [Serenity] 0.8.21 以降に Serenity 側で入った修正 (MC とは無関係) / [local] このリポジトリ独自の調整
 * Copyright (c) 2024 SerenityJS
 * See THIRD_PARTY_NOTICES.md in this package for the source and full license.
 */
import { BinaryStream, DataType } from '@serenityjs/binarystream';

class Uuid extends DataType {
  public static read(stream: BinaryStream): string {
    // Read the most significant bits and least significant bits of the UUID.
    // The bytes are copied before reversing, as reversing a view would mutate the source buffer.
    const msb = Buffer.from(stream.read(8)).reverse(); // [Serenity] コピーしてから反転 // Reverse the bytes to match the UUID format
    const lsb = Buffer.from(stream.read(8)).reverse();

    // Convert the byte arrays to a hexadecimal string and format it as a UUID.
    const uuid = Buffer.concat([msb, lsb]).toString('hex');

    // Format the UUID string into the standard UUID format.
    return (
      uuid.slice(0, 8) +
      '-' +
      uuid.slice(8, 12) +
      '-' +
      uuid.slice(12, 16) +
      '-' +
      uuid.slice(16, 20) +
      '-' +
      uuid.slice(20)
    );
  }

  public static write(stream: BinaryStream, value: string): void {
    // Remove the dashes from the UUID string.
    const uuid = value.replace(/-/g, '');

    // Convert the UUID string to a byte array.
    const bytes = Buffer.from(uuid, 'hex');

    // Split the byte array into most significant bits and least significant bits.
    const msb = bytes.subarray(0, 8); // First 8 bytes are the most significant bits
    const lsb = bytes.subarray(8, 16); // Last 8 bytes are the least significant bits

    // Write the most significant bits and least significant bits to the stream.
    stream.write(msb.reverse());
    stream.write(lsb.reverse());
  }
}

export { Uuid };
