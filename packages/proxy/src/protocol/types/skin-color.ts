/*!
 * Copied from SerenityJS main (MIT), unreleased as of @serenityjs/protocol 0.8.21.
 * Delete once the release that includes it is adopted.
 * 印: [MC] 0.8.21 から最新版マイクラ (1.26.51, protocol 2193) で変わった箇所 (https://mojang.github.io/bedrock-protocol-docs/1.26.51/)
 *     [Serenity] 0.8.21 以降に Serenity 側で入った修正 (MC とは無関係) / [local] このリポジトリ独自の調整
 * Copyright (c) 2024 SerenityJS
 * See THIRD_PARTY_NOTICES.md in this package for the source and full license.
 */
import { BinaryStream, DataType, Endianness } from '@serenityjs/binarystream';

// [MC] 追加 (色が string から ARGB int32 になったため)
class SkinColor extends DataType {
  public static read(stream: BinaryStream): string {
    // Read the ARGB value of the color
    const argb = stream.readUint32(Endianness.Little);

    // Convert the ARGB value to a hex string
    return `#${argb.toString(16).padStart(8, '0')}`;
  }

  public static write(stream: BinaryStream, value: string): void {
    // Convert the hex string to an ARGB value, and write it to the stream
    stream.writeUint32(SkinColor.toArgb(value), Endianness.Little);
  }

  public static toArgb(value: string): number {
    // Remove the leading hash from the color
    const hex = value.startsWith('#') ? value.slice(1) : value;

    // Parse the hex string, defaulting to 0 for invalid colors
    const parsed = Number.parseInt(hex, 16) || 0;

    // Give six digit colors full opacity
    return (hex.length === 6 ? 0xff_00_00_00 | parsed : parsed) >>> 0;
  }
}

export { SkinColor };
