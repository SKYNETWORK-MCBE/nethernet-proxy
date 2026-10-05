import { inflateRawSync, deflateRawSync } from 'node:zlib';
import snappy from 'snappyjs';

export interface FramedPacket {
  id: number;
  header: number;
  bytes: Buffer;
  body: Buffer;
}
export interface Compression {
  readonly algorithm: 'deflate' | 'snappy';
  readonly threshold: number;
}
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export function varuint(buffer: Buffer, offset = 0, end = buffer.length) {
  if (!Number.isInteger(offset) || offset < 0) throw new Error('invalid_offset');
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= end) throw new Error('truncated_varuint');
    const byte = buffer[offset + i];
    if (i === 4 && byte > 15) throw new Error('overflow_varuint');
    value += (byte & 127) * 2 ** (i * 7);
    if (!(byte & 128)) return { value, size: i + 1 };
  }
  throw new Error('overflow_varuint');
}
export function uint(value: number) {
  const buffer = Buffer.allocUnsafe(5);
  let length = 0;
  do {
    const byte = value & 127;
    value >>>= 7;
    buffer[length++] = byte | (value ? 128 : 0);
  } while (value);
  return buffer.subarray(0, length);
}
/** Packet buffers are zero-copy views; only hook dispatch copies them. */
export function readPacket(bytes: Buffer): FramedPacket {
  const { value: header, size } = varuint(bytes);
  if (header > 0x3fff) throw new Error('invalid_packet_header');
  return { id: header & 1023, header, bytes, body: bytes.subarray(size) };
}
export function batchPackets(buffer: Buffer): FramedPacket[] {
  const packets: FramedPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (packets.length >= 4096) throw new Error('too_many_packets');
    const { value: length, size } = varuint(buffer, offset);
    offset += size;
    if (!length || length > buffer.length - offset) throw new Error('invalid_packet_length');
    packets.push(readPacket(buffer.subarray(offset, offset + length)));
    offset += length;
  }
  if (!packets.length) throw new Error('empty_batch');
  return packets;
}
export function decodePayload(
  original: Buffer,
  { compression = false, maxBytes = DEFAULT_MAX_BYTES } = {},
) {
  if (original.length > maxBytes) throw new Error('payload_limit');
  let buffer = original;
  let compressed = false;
  if (compression) {
    const algorithm = buffer[0];
    buffer = buffer.subarray(1);
    compressed = algorithm !== 255;
    if (algorithm === 0) buffer = inflateRawSync(buffer, { maxOutputLength: maxBytes });
    else if (algorithm === 1) {
      if (varuint(buffer).value > maxBytes) throw new Error('payload_limit');
      buffer = Buffer.from(snappy.uncompress(buffer));
    } else if (algorithm !== 255) throw new Error('unknown_compression_header');
  }
  if (buffer.length > maxBytes) throw new Error('payload_limit');
  return { packets: batchPackets(buffer), compressed };
}
export function encodePayload(
  packets: readonly Buffer[],
  compression?: Compression,
  maxBytes = DEFAULT_MAX_BYTES,
) {
  const parts: Buffer[] = [];
  let length = 0;
  for (const packet of packets) {
    const prefix = uint(packet.length);
    length += prefix.length + packet.length;
    if (length > maxBytes) throw new Error('payload_limit');
    parts.push(prefix, packet);
  }
  if (!packets.length || packets.length > 4096) throw new Error('invalid_packet_count');
  const batch = Buffer.concat(parts, length);
  if (!compression) return batch;
  let algorithm = 255;
  let body = batch;
  // Threshold 0 disables compression. Compression is per batch, not per packet.
  if (compression.threshold > 0 && batch.length >= compression.threshold) {
    algorithm = compression.algorithm === 'deflate' ? 0 : 1;
    body = algorithm === 0 ? deflateRawSync(batch) : Buffer.from(snappy.compress(batch));
  }
  if (body.length + 1 > maxBytes) throw new Error('payload_limit');
  return Buffer.concat([Buffer.from([algorithm]), body]);
}
export function fragmentPayload(payload: Buffer, fragmentSize = 10000) {
  if (!Number.isInteger(fragmentSize) || fragmentSize < 1 || fragmentSize > 10000)
    throw new Error('invalid_fragment_size');
  const count = Math.ceil(payload.length / fragmentSize);
  if (!count || count > 256) throw new Error('fragment_count_limit');
  const frames: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const part = payload.subarray(i * fragmentSize, (i + 1) * fragmentSize);
    const frame = Buffer.allocUnsafe(part.length + 1);
    frame[0] = count - i - 1;
    part.copy(frame, 1);
    frames.push(frame);
  }
  return frames;
}
/** Only the replacement header is read; body and ID consistency are caller contracts. */
export function preserveSubclients(replacement: Buffer, originalHeader: number) {
  const { value, size } = varuint(replacement);
  return Buffer.concat([
    uint((value & 1023) | (originalHeader & 0x3c00)),
    replacement.subarray(size),
  ]);
}
export function networkSettings(packet: FramedPacket): Compression {
  if (packet.body.length < 4) throw new Error('invalid_network_settings');
  const threshold = packet.body.readUInt16LE(0);
  const code = packet.body.readUInt16LE(2);
  if (code !== 0 && code !== 1) throw new Error('unknown_compression_algorithm');
  return Object.freeze({ algorithm: code === 0 ? 'deflate' : 'snappy', threshold });
}
/** Retains views rather than copying each fragment; single-frame payloads need no concat. */
export class Reassembler {
  private parts: Buffer[] = [];
  private bytes = 0;
  private remaining: number | null = null;
  constructor(readonly maxBytes = DEFAULT_MAX_BYTES) {}
  reset() {
    this.parts = [];
    this.bytes = 0;
    this.remaining = null;
  }
  push(frame: Buffer): Buffer | null {
    if (frame.length < 2 || (this.remaining !== null && frame[0] !== this.remaining - 1)) {
      this.reset();
      throw new Error('invalid_fragment');
    }
    this.bytes += frame.length - 1;
    if (this.bytes > this.maxBytes) {
      this.reset();
      throw new Error('payload_limit');
    }
    this.parts.push(frame.subarray(1));
    this.remaining = frame[0];
    if (this.remaining) return null;
    const payload = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.bytes);
    this.reset();
    return payload;
  }
}
