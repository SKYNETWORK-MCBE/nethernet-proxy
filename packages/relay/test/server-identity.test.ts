import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify, createPublicKey } from 'node:crypto';
import { renewServerIdentity, signSdpIdentity } from '../src/server-identity';

test('server identity JWT and detached fingerprint signature verify with the same key', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const identity = renewServerIdentity({ privateKey, token: '', domain: 'self' });
  const [header, payload, signature] = identity.token.split('.');
  assert.ok(
    verify(
      'sha384',
      Buffer.from(`${header}.${payload}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    ),
  );
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  assert.deepEqual(
    createPublicKey({ key: claims.cpk, format: 'jwk' }).export({ type: 'spki', format: 'der' }),
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  assert.equal(claims.exp - claims.iat, 60);
  const sdp =
    'v=0\r\na=fingerprint:sha-256 AA:BB\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';
  const result = signSdpIdentity(sdp, identity);
  const attribute = /^a=identity:(.+)\r?$/m.exec(result)![1].trim();
  const data = JSON.parse(Buffer.from(attribute, 'base64').toString());
  const assertion = JSON.parse(data.assertion);
  const [h, , s] = assertion.fingerprints.split('.');
  const canonical = Buffer.from(
    JSON.stringify({ fingerprint: [{ algorithm: 'sha-256', digest: 'AA:BB' }] }),
  ).toString('base64url');
  assert.ok(
    verify(
      'sha384',
      Buffer.from(`${h}.${canonical}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url'),
    ),
  );
  const different = Buffer.from(
    JSON.stringify({ fingerprint: [{ algorithm: 'sha-256', digest: 'CC:DD' }] }),
  ).toString('base64url');
  assert.equal(
    verify(
      'sha384',
      Buffer.from(`${h}.${different}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url'),
    ),
    false,
  );
  assert.equal(signSdpIdentity(result, identity).match(/a=identity:/g)?.length, 1);
});

test('P-256 is not a NetherNet server identity', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  assert.throws(() => renewServerIdentity({ privateKey, token: '' }), /p384/);
});
