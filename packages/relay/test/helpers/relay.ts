import type { Connection } from 'nethernet';
import { ProxySession, defaultLimits } from '../../src/session';
import { PacketHooks } from '../../src/hooks';
import { encodePayload, fragmentPayload, uint } from '../../src/framing';
import type { Channel, Direction, RelayLimits } from '../../src/types';

export function packet(id = 9, body: Buffer = Buffer.from([42])) {
  return Buffer.concat([uint(id), body]);
}
export function frames(packets: Buffer[], fragmentSize = 10000) {
  return fragmentPayload(encodePayload(packets), fragmentSize);
}
export function setup(
  limits: Partial<RelayLimits> = {},
  connectionId = 1n,
  hooks = new PacketHooks(),
) {
  const sent: { direction: Direction; channel: Channel; frame: Buffer }[] = [];
  const errors: string[] = [];
  const reasons: string[] = [];
  let ready = 0;
  const endpoint = (direction: Direction) =>
    ({
      address: direction === 's2c' ? connectionId : connectionId + 1n,
      reliable: {
        readyState: 'open',
        bufferedAmount: 0,
        send: (frame: Buffer) => sent.push({ direction, channel: 'reliable', frame }),
      },
      unreliable: {
        readyState: 'open',
        bufferedAmount: 0,
        send: (frame: Buffer) => sent.push({ direction, channel: 'unreliable', frame }),
      },
    }) as unknown as Connection;
  const clientConnection = endpoint('s2c');
  const serverConnection = endpoint('c2s');
  const session = new ProxySession(
    clientConnection,
    '123',
    undefined,
    undefined,
    hooks,
    { ...defaultLimits, ...limits },
    {
      close: (reason) => {
        reasons.push(reason);
        session.dispose();
        return Promise.resolve();
      },
      ready: () => {
        ready++;
      },
      packetError: (reason) => {
        errors.push(reason);
      },
    },
  );
  session.setServerConnection(serverConnection);
  return {
    session,
    hooks,
    sent,
    errors,
    reasons,
    clientConnection,
    serverConnection,
    ready: () => ready,
    negotiate: (algorithm = 0, threshold = 1) => {
      const body = Buffer.alloc(4);
      body.writeUInt16LE(threshold, 0);
      body.writeUInt16LE(algorithm, 2);
      for (const frame of frames([packet(143, body)])) session.receive('s2c', 'reliable', frame);
      sent.length = 0;
    },
  };
}
