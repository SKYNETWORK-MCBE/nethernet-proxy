import { generateKeyPairSync } from 'node:crypto';
import { SignJWT } from 'jose';
import type { Identity } from 'nethernet';
import { signSdpIdentity, renewServerIdentity } from '../../src/server-identity';

export const issuer = 'https://authorization.franchise.minecraft-services.net/';
export const audience = 'api://auth-minecraft-services/multiplayer';
export const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const clientKeys = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
export const serverIdentity = renewServerIdentity({
  privateKey: clientKeys.privateKey,
  token: '',
  domain: 'self',
});
export const signingKey = {
  ...rsa.publicKey.export({ format: 'jwk' }),
  kid: 'test-key',
  use: 'sig',
  alg: 'RS256',
};
export const plainSdp = `v=0\r\na=fingerprint:sha-256 ${Array(32).fill('AA').join(':')}\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n`;
export async function identity(
  overrides: Record<string, unknown> = {},
  signingPrivateKey = rsa.privateKey,
): Promise<Identity> {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    iss: issuer,
    aud: audience,
    exp: now + 600,
    iat: now,
    xid: '123456789',
    xname: 'Test Player',
    mid: 'test-playfab',
    cpk: clientKeys.publicKey.export({ format: 'jwk' }),
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .sign(signingPrivateKey);
  return { privateKey: clientKeys.privateKey, token, domain: issuer.slice(0, -1) };
}
export async function offer(overrides: Record<string, unknown> = {}) {
  return signSdpIdentity(plainSdp, await identity(overrides));
}
