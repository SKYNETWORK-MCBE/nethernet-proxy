import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  decodePayload,
  encodePayload,
  fragmentPayload,
  Reassembler,
  readPacket,
} from '../src/framing';
import { setup, packet, frames } from './helpers/relay';
import type { PacketContext } from '../src/types';

function payload(frames: Buffer[]) {
  const reassembly = new Reassembler();
  let result: Buffer | null = null;
  for (const frame of frames) result = reassembly.push(frame);
  return result!;
}
test('selectors alone do not change raw forwarding; steady-state bytes and message identities are preserved', () => {
  const { session, hooks, sent, negotiate } = setup();
  negotiate();
  hooks.selector(9);
  const source = [Buffer.from([1, 0xde, 0xad]), Buffer.from([0, 0xbe, 0xef])];
  session.receive('c2s', 'unreliable', source[0]);
  assert.equal(sent[0].frame, source[0]);
  session.receive('c2s', 'unreliable', source[1]);
  assert.equal(sent[1].frame, source[1]);
  assert.equal(sent[0].channel, 'unreliable');
  assert.equal(session.queuedBytes, 0);
  session.dispose();
});
test('after-only forwards fragments immediately, then observes independent final packet Buffers', () => {
  const { session, hooks, sent, errors } = setup();
  const bytes = packet(9 | (1 << 10) | (2 << 12));
  let context: PacketContext | undefined;
  const seen: Buffer[] = [];
  hooks.selector(9, { direction: 'c2s' }).after((buffer) => {
    buffer.fill(0);
    throw new Error('consumer');
  });
  hooks.selector(9, { direction: 'c2s' }).after((buffer, ctx) => {
    seen.push(buffer);
    context = ctx;
  });
  const input = frames([bytes, packet(999), bytes], 3);
  session.receive('c2s', 'reliable', input[0]);
  assert.equal(sent[0].frame, input[0]);
  assert.equal(seen.length, 0);
  for (const frame of input.slice(1)) session.receive('c2s', 'reliable', frame);
  assert.deepEqual(seen, [bytes, bytes]);
  assert.deepEqual(context, {
    connectionId: '1',
    networkId: '123',
    id: 9,
    direction: 'c2s',
    channel: 'reliable',
  });
  assert.ok(Object.isFrozen(context));
  assert.equal(errors.length, 2);
  assert.ok(!session.closed);
  session.dispose();
});
test('before undefined discards in-place mutations and forwards the original fragment objects', () => {
  const { session, hooks, sent } = setup();
  hooks.selector(9).before((buffer) => {
    buffer.fill(0);
  });
  const input = frames([packet()], 2);
  session.receive('c2s', 'reliable', input[0]);
  assert.equal(sent.length, 0);
  for (const frame of input.slice(1)) session.receive('c2s', 'reliable', frame);
  assert.deepEqual(
    sent.map((x) => x.frame),
    input,
  );
  for (let i = 0; i < input.length; i++) assert.equal(sent[i].frame, input[i]);
  session.dispose();
});
for (const algorithm of ['deflate', 'snappy'] as const)
  test(`before replacement/drop preserves order and subclients; re-encodes ${algorithm} once per batch`, () => {
    const { session, hooks, sent, negotiate } = setup();
    negotiate(algorithm === 'snappy' ? 1 : 0);
    const order: string[] = [];
    const observed: Buffer[] = [];
    hooks.selector(9, { direction: 'c2s' }).before(() => {
      order.push('one');
      return packet(9, Buffer.from([77]));
    });
    hooks.selector(9, { direction: 'c2s' }).before((buffer) => {
      order.push('two');
      assert.equal(buffer.at(-1), 77);
      assert.equal(readPacket(buffer).header, 9 | 1024);
      return packet(9, Buffer.from([88]));
    });
    hooks.selector(10).before(() => null);
    hooks.selector(10).before(() => {
      assert.fail('drop must stop before chain');
    });
    hooks.selector(9).after((buffer) => {
      order.push('after');
      observed.push(buffer);
    });
    hooks.selector(10).after(() => assert.fail('dropped packet must not be observed'));
    const input = fragmentPayload(
      encodePayload([packet(9 | 1024), packet(10), packet(999)], { algorithm, threshold: 1 }),
      4,
    );
    for (const frame of input) session.receive('c2s', 'reliable', frame);
    const output = decodePayload(payload(sent.map((x) => x.frame)), { compression: true }).packets;
    assert.deepEqual(
      output.map((x) => x.bytes),
      [packet(9 | 1024, Buffer.from([88])), packet(999)],
    );
    assert.deepEqual(observed, [output[0].bytes]);
    assert.deepEqual(order, ['one', 'two', 'after']);
    session.dispose();
  });
test('all packets dropped produce neither output nor after, and same-bytes Buffer is still a replacement', () => {
  const { session, hooks, sent } = setup();
  const stop = hooks.selector(9).before(() => null);
  const stopAfter = hooks.selector(9).after(() => assert.fail('no after for dropped packet'));
  session.receive('c2s', 'reliable', frames([packet()])[0]);
  assert.equal(sent.length, 0);
  stop();
  stopAfter();
  hooks.selector(9).before((buffer) => buffer);
  const unchanged = frames([packet()])[0];
  session.receive('c2s', 'reliable', unchanged);
  assert.notEqual(sent[0].frame, unchanged);
  assert.deepEqual(sent[0].frame, unchanged);
  const input = frames([packet(999)])[0];
  session.receive('c2s', 'reliable', input);
  assert.equal(sent[1].frame, input);
  session.dispose();
});
test('registration/unsubscription snapshots apply at the next batch, including callback changes', () => {
  const { session, hooks, sent } = setup();
  const seen: string[] = [];
  const first = frames([packet(), packet()], 2);
  session.receive('c2s', 'reliable', first[0]);
  let stop = hooks.selector(9).before(() => {
    seen.push('new');
  });
  for (const frame of first.slice(1)) session.receive('c2s', 'reliable', frame);
  assert.equal(seen.length, 0);
  const second = frames([packet(), packet()], 2);
  session.receive('c2s', 'reliable', second[0]);
  const count = sent.length;
  stop();
  stop();
  hooks.selector(9).after(() => {
    seen.push('after');
  });
  for (const frame of second.slice(1)) session.receive('c2s', 'reliable', frame);
  assert.deepEqual(seen, ['new', 'new']);
  assert.ok(sent.length > count);
  stop = hooks.selector(9).before(() => {
    stop();
    hooks.selector(9).before(() => {
      seen.push('later');
    });
  });
  for (const frame of frames([packet(), packet()])) session.receive('c2s', 'reliable', frame);
  assert.equal(seen.filter((x) => x === 'later').length, 0);
  for (const frame of frames([packet()])) session.receive('c2s', 'reliable', frame);
  assert.equal(seen.filter((x) => x === 'later').length, 2);
  session.dispose();
});
test('no-handler negotiation enables late hooks and injection with shared fragment ordering', () => {
  const { session, hooks, sent, negotiate } = setup();
  assert.throws(() => session.server.send(packet()), /compression_unknown/);
  negotiate();
  const source = fragmentPayload(
    encodePayload([packet(999)], { algorithm: 'deflate', threshold: 1 }),
    2,
  );
  session.receive('c2s', 'reliable', source[0]);
  assert.equal(session.server.send(packet(9)), 'queued');
  assert.equal(sent.length, 1);
  for (const frame of source.slice(1)) session.receive('c2s', 'reliable', frame);
  for (let i = 0; i < source.length; i++) assert.equal(sent[i].frame, source[i]);
  const injected = decodePayload(payload(sent.slice(source.length).map((x) => x.frame)), {
    compression: true,
  });
  assert.equal(injected.packets[0].id, 9);
  let calls = 0;
  hooks.selector(9).before(() => {
    calls++;
    session.server.send(packet(9));
  });
  hooks.selector(9).after(() => {
    calls++;
    session.server.send(packet(9));
  });
  for (const frame of fragmentPayload(
    encodePayload([packet()], { algorithm: 'deflate', threshold: 1 }),
  ))
    session.receive('c2s', 'reliable', frame);
  assert.equal(calls, 2);
  assert.ok(!session.closed);
  assert.equal(session.client.send(packet(), { channel: 'unreliable' }), 'sent');
  assert.equal(sent.at(-1)!.direction, 's2c');
  assert.equal(sent.at(-1)!.channel, 'unreliable');
  session.dispose();
});
test('initial settings remain uncompressed on rewrite; subsequent batches use negotiated headers', () => {
  const { session, hooks, sent } = setup();
  hooks.selector(143).before((bytes) => bytes);
  const body = Buffer.from([1, 0, 0, 0]);
  session.receive('s2c', 'reliable', frames([packet(143, body)])[0]);
  assert.equal(decodePayload(payload(sent.map((x) => x.frame))).packets[0].id, 143);
  assert.equal(session.server.send(packet()), 'sent');
  session.dispose();
});
test('before exceptions and decode failure close only that session; after errors do not block relay', () => {
  for (const failure of ['callback', 'decode']) {
    const a = setup();
    const b = setup();
    a.hooks.selector(9).before(() => {
      throw new Error('secret');
    });
    const input = failure === 'decode' ? Buffer.from([0, 99]) : frames([packet()])[0];
    a.session.receive('c2s', 'reliable', input);
    assert.ok(a.session.closed);
    assert.equal(a.sent.length, 0);
    assert.equal(
      a.reasons[0],
      failure === 'decode' ? 'before_decode_failed' : 'before_callback_failed',
    );
    b.session.receive('c2s', 'reliable', frames([packet()])[0]);
    assert.ok(!b.session.closed);
    b.session.dispose();
  }
});
test('after never runs when final fragment fails to forward, but does run after pending queue acceptance', () => {
  const { session, hooks, serverConnection, sent } = setup();
  let calls = 0;
  hooks.selector(9).after(() => {
    calls++;
  });
  Object.defineProperty(serverConnection.reliable, 'readyState', {
    value: 'connecting',
    configurable: true,
  });
  const input = frames([packet()], 2);
  for (const frame of input) session.receive('c2s', 'reliable', frame);
  assert.equal(calls, 1);
  assert.equal(sent.length, 0);
  Object.defineProperty(serverConnection.reliable, 'readyState', { value: 'open' });
  session.channelReady('c2s', 'reliable');
  assert.equal(sent.length, input.length);
  serverConnection.reliable!.send = () => {
    throw new Error('send failed');
  };
  session.receive('c2s', 'reliable', frames([packet()])[0]);
  assert.equal(calls, 1);
  assert.ok(session.closed);
  assert.equal(session.queuedBytes, 0);
});
test('queue limits include held fragments and callback injection; oversized decompression is bounded', () => {
  const { session, hooks, reasons } = setup({ maxQueueBytes: 5 });
  hooks.selector(9).before(() => {});
  for (const frame of frames([packet(9, Buffer.alloc(20))], 3))
    session.receive('c2s', 'reliable', frame);
  assert.ok(session.closed);
  assert.equal(reasons[0], 'backpressure_limit');
  assert.equal(session.queuedBytes, 0);
  const a = setup({ maxPayloadBytes: 100 });
  a.negotiate();
  a.hooks.selector(9).before(() => {});
  const compressed = Buffer.concat([
    Buffer.from([0]),
    deflateRawSync(encodePayload([packet(9, Buffer.alloc(1000))])),
  ]);
  for (const frame of fragmentPayload(compressed)) a.session.receive('c2s', 'reliable', frame);
  assert.ok(a.session.closed);
  assert.equal(a.reasons[0], 'before_decode_failed');
});
test('callbacks must be synchronous and stale unsubscribe remains safe after close', () => {
  const { hooks, session } = setup();
  for (const id of [-1, 1024, NaN, 1.1])
    assert.throws(() => hooks.selector(id), /invalid_packet_id/);
  assert.throws(() => hooks.selector(9).after(async () => {}), /synchronous/);
  const stop = hooks.selector(9).before(() => {});
  hooks.clear();
  stop();
  stop();
  session.dispose();
  assert.throws(() => hooks.selector(9).before(() => {}), /proxy_closed/);
});
test('partial batches time out and ready is a one-time all-channel event', async () => {
  const { session, ready } = setup({ fragmentTimeoutMs: 20 });
  session.channelReady('c2s', 'reliable');
  session.channelReady('s2c', 'unreliable');
  assert.equal(ready(), 1);
  assert.ok(session.ready);
  session.receive('c2s', 'reliable', Buffer.from([1, 1]));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(session.closed);
  assert.equal(session.ready, false);
});
test('removing the last handler switches back to raw at the boundary without losing compression state', () => {
  const { session, hooks, sent, negotiate, errors } = setup();
  negotiate();
  let count = 0;
  const selector = hooks.selector(9, { direction: 'c2s' });
  const stop = selector.after(() => {
    count++;
  });
  const input = fragmentPayload(
    encodePayload([packet()], { algorithm: 'deflate', threshold: 1 }),
    3,
  );
  session.receive('c2s', 'reliable', input[0]);
  stop();
  for (const frame of input.slice(1)) session.receive('c2s', 'reliable', frame);
  assert.equal(count, 1);
  const opaque = Buffer.from([0, 0xde, 0xad]);
  session.receive('c2s', 'reliable', opaque);
  assert.equal(sent.at(-1)!.frame, opaque);
  assert.equal(errors.length, 0);
  assert.equal(session.server.send(packet()), 'sent');
  session.dispose();
});
test('queue acceptance preserves packet order and owns injection buffers; limits apply to all streams', () => {
  const a = setup({ maxQueueMessages: 2 });
  a.negotiate();
  Object.defineProperty(a.serverConnection.reliable, 'readyState', {
    value: 'connecting',
    configurable: true,
  });
  const buffer = packet(9);
  assert.equal(a.session.server.send(buffer), 'queued');
  buffer.fill(0);
  const second = frames([packet(999)])[0];
  a.session.receive('c2s', 'reliable', second);
  assert.equal(a.session.queuedMessages, 2);
  Object.defineProperty(a.serverConnection.reliable, 'readyState', { value: 'open' });
  a.session.channelReady('c2s', 'reliable');
  assert.equal(decodePayload(a.sent[0].frame.subarray(1), { compression: true }).packets[0].id, 9);
  assert.equal(a.sent[1].frame, second);
  a.session.dispose();
  const b = setup({ maxQueueMessages: 1 });
  b.negotiate();
  Object.defineProperty(b.serverConnection.reliable, 'readyState', { value: 'connecting' });
  Object.defineProperty(b.clientConnection.unreliable, 'readyState', { value: 'connecting' });
  b.session.server.send(packet());
  assert.throws(
    () => b.session.client.send(packet(), { channel: 'unreliable' }),
    /backpressure_limit/,
  );
  assert.ok(b.session.closed);
  assert.equal(b.session.queuedMessages, 0);
});
test('before and after return promises are not awaited and do not leave unhandled rejections', async () => {
  const a = setup();
  a.hooks
    .selector(9)
    .before((() => Promise.reject(new Error('test rejection'))) as unknown as () => Buffer);
  a.session.receive('c2s', 'reliable', frames([packet()])[0]);
  assert.ok(a.session.closed);
  assert.equal(a.reasons[0], 'invalid_before_result');
  const b = setup();
  b.hooks.selector(9).after(() => Promise.reject(new Error('test rejection')));
  b.session.receive('c2s', 'reliable', frames([packet()])[0]);
  assert.ok(!b.session.closed);
  assert.deepEqual(b.errors, ['async_after_result']);
  await new Promise((resolve) => setTimeout(resolve, 0));
  b.session.dispose();
});
test('per-channel fragment streams are independent and loss on unreliable does not close reliable', () => {
  const { session, hooks, sent, errors } = setup();
  const observed: string[] = [];
  hooks.selector(9).after((_, ctx) => {
    observed.push(ctx.channel);
  });
  const split = frames([packet()], 1);
  session.receive('c2s', 'reliable', split[0]);
  session.receive('c2s', 'unreliable', split[0]);
  session.receive('c2s', 'unreliable', frames([packet()])[0]);
  for (const frame of split.slice(1)) session.receive('c2s', 'reliable', frame);
  assert.deepEqual(observed, ['unreliable', 'reliable']);
  assert.deepEqual(errors, ['fragment_sequence']);
  assert.ok(!session.closed);
  assert.equal(sent.length, split.length + 2);
  session.dispose();
});
