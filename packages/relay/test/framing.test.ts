import { test } from 'vite-plus/test'
import assert from 'node:assert/strict'
import {
  decodePayload,
  encodePayload,
  fragmentPayload,
  Reassembler,
  readPacket,
  varuint,
} from '../src/framing'
import { packet } from './helpers/relay'

for (const algorithm of [undefined, 'deflate', 'snappy'] as const)
  for (const threshold of [0, 1, 65535])
    test(`batch/fragment round trip (algorithm=${algorithm}, threshold=${threshold})`, () => {
      const compression = algorithm ? { algorithm, threshold } : undefined
      const original = [packet(999 | 0x3c00), packet(1, Buffer.alloc(100))]
      const encoded = encodePayload(original, compression)
      const snapshot = Buffer.from(encoded)
      const assembler = new Reassembler()
      let payload: Buffer | null = null
      for (const frame of fragmentPayload(encoded, 7)) payload = assembler.push(frame)
      const decoded = decodePayload(payload!, { compression: !!compression }).packets
      assert.deepEqual(
        decoded.map((x) => x.bytes),
        original,
      )
      assert.deepEqual(encoded, snapshot)
      assert.equal(decoded[0].header, 999 | 0x3c00)
      if (compression && (threshold === 0 || threshold === 65535)) assert.equal(encoded[0], 255)
    })
test('wire bounds reject malformed lengths, uint overflow, invalid headers and too many fragments', () => {
  for (const buffer of [Buffer.from([128]), Buffer.from([255, 255, 255, 255, 16])])
    assert.throws(() => varuint(buffer))
  for (const buffer of [Buffer.from([0]), Buffer.from([99, 1]), Buffer.from([2, 128, 128])])
    assert.throws(() => decodePayload(buffer))
  assert.throws(() => readPacket(Buffer.from([128, 128, 1])), /invalid_packet_header/)
  assert.throws(() => fragmentPayload(Buffer.alloc(257), 1), /fragment_count_limit/)
  const assembler = new Reassembler(2)
  assert.throws(() => assembler.push(Buffer.from([0, 1, 2, 3])), /payload_limit/)
  assert.equal(assembler.push(Buffer.from([0, 1]))![0], 1)
})
