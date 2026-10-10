/*!
 * PlayerSkin wire layout follows gophertunnel (MIT) protocol.Skin / packet.PlayerSkin.
 * Copyright (c) 2019 Sandertv
 * See THIRD_PARTY_NOTICES.md in this package for the source and full license.
 */

export interface SkinImage {
  readonly width: number;
  readonly height: number;
  /** Raw RGBA, width * height * 4 bytes. */
  readonly data: Buffer;
}
export interface SkinAnimation {
  readonly image: SkinImage;
  readonly type: number;
  readonly frames: number;
  readonly expression: number;
}
export interface SkinPersonaPiece {
  readonly pieceId: string;
  /** Numeric on the wire, a name such as `persona_skeleton` in login ClientData. */
  readonly pieceType: number | string;
  readonly packId: string;
  readonly isDefault: boolean;
  readonly productId: string;
}
export interface SkinPersonaTintPiece {
  readonly pieceType: string;
  readonly colors: readonly string[];
}
export interface SkinData {
  readonly id: string;
  readonly playFabId: string;
  readonly resourcePatch: string;
  readonly skinImage: SkinImage;
  readonly animations: readonly SkinAnimation[];
  readonly capeImage: SkinImage;
  readonly geometryData: string;
  readonly geometryEngineVersion: string;
  readonly animationData: string;
  readonly capeId: string;
  readonly fullId: string;
  readonly armSize: string;
  readonly skinColor: string;
  readonly personaPieces: readonly SkinPersonaPiece[];
  readonly tintPieces: readonly SkinPersonaTintPiece[];
  readonly isPremium: boolean;
  readonly isPersona: boolean;
  readonly isPersonaCapeOnClassic: boolean;
  readonly isPrimaryUser: boolean;
  readonly overrideAppearance: boolean;
  readonly isTrusted: boolean;
  readonly profileHash: string;
}
export interface PlayerSkinPacketData {
  readonly uuid: string;
  readonly skin: SkinData;
  readonly newSkinName: string;
  readonly oldSkinName: string;
}

const ARM_SIZES = ['slim', 'wide'];

/**
 * Bounds-checked reader: BinaryStream yields zeros past EOF, which turns a stale layout into
 * multi-billion iteration loops. Every read here throws instead, and counts are capped by the bytes left.
 */
class Reader {
  private offset = 0;
  constructor(private readonly buffer: Buffer) {}

  private take(length: number) {
    if (length > this.buffer.length - this.offset) throw new Error('truncated_skin');
    const start = this.offset;
    this.offset += length;
    return this.buffer.subarray(start, this.offset);
  }
  varuint() {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = this.take(1)[0];
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return value;
    }
    throw new Error('varint_overflow');
  }
  /** Element count whose smallest encoding is `minBytes` each. */
  count(minBytes: number) {
    const count = this.varuint();
    if (count * minBytes > this.buffer.length - this.offset) throw new Error('truncated_skin');
    return count;
  }
  bytes() {
    return Buffer.from(this.take(this.varuint()));
  }
  string() {
    return this.take(this.varuint()).toString('utf8');
  }
  bool() {
    return this.take(1)[0] !== 0;
  }
  uint8() {
    return this.take(1)[0];
  }
  uint32() {
    return this.take(4).readUInt32LE();
  }
  float32() {
    return this.take(4).readFloatLE();
  }
  /** Big-endian int32 holding ARGB with alpha in the low byte (gophertunnel BEARGB). */
  color() {
    const [b, g, r, a] = this.take(4);
    return `#${[a, r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
  }
  /** Two little-endian int64 halves. */
  uuid() {
    const raw = this.take(16);
    const hex = Buffer.concat([
      Buffer.from(raw.subarray(0, 8)).reverse(),
      Buffer.from(raw.subarray(8, 16)).reverse(),
    ]).toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  image(): SkinImage {
    const width = this.uint32();
    const height = this.uint32();
    return { width, height, data: this.bytes() };
  }
}

function readSkin(reader: Reader): SkinData {
  const id = reader.string();
  const playFabId = reader.string();
  const resourcePatch = reader.bytes().toString('utf8');
  const skinImage = reader.image();
  const animations = Array.from({ length: reader.count(15) }, () => ({
    image: reader.image(),
    type: reader.varuint(),
    frames: reader.float32(),
    expression: reader.varuint(),
  }));
  const capeImage = reader.image();
  const geometryData = reader.bytes().toString('utf8');
  const geometryEngineVersion = reader.bytes().toString('utf8');
  const animationData = reader.bytes().toString('utf8');
  const capeId = reader.string();
  const fullId = reader.string();
  const arm = reader.uint8();
  const skinColor = reader.color();
  const personaPieces = Array.from({ length: reader.count(23) }, () => ({
    pieceId: reader.string(),
    pieceType: reader.uint32(),
    packId: reader.uuid(),
    isDefault: reader.bool(),
    productId: reader.string(),
  }));
  const tintPieces = Array.from({ length: reader.count(17) }, () => ({
    pieceType: reader.string(),
    colors: [reader.color(), reader.color(), reader.color(), reader.color()],
  }));
  return {
    id,
    playFabId,
    resourcePatch,
    skinImage,
    animations,
    capeImage,
    geometryData,
    geometryEngineVersion,
    animationData,
    capeId,
    fullId,
    armSize: ARM_SIZES[arm] ?? String(arm),
    skinColor,
    personaPieces,
    tintPieces,
    isPremium: reader.bool(),
    isPersona: reader.bool(),
    isPersonaCapeOnClassic: reader.bool(),
    isPrimaryUser: reader.bool(),
    overrideAppearance: reader.bool(),
    isTrusted: reader.string().toLowerCase() === 'true',
    profileHash: reader.string(),
  };
}

/** Decodes a framed PlayerSkin packet (header varint included). */
export function readPlayerSkinPacket(buffer: Buffer): PlayerSkinPacketData {
  const reader = new Reader(buffer);
  reader.varuint();
  return {
    uuid: reader.uuid(),
    skin: readSkin(reader),
    newSkinName: reader.string(),
    oldSkinName: reader.string(),
  };
}
