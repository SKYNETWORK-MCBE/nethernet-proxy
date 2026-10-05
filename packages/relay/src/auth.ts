import { proxyAuthDirectory } from './cache-storage';
import prismarineAuth from 'prismarine-auth';
import type { Identity } from 'nethernet';
import { authStorage } from './auth-storage';
const { Authflow, Titles } = prismarineAuth;

// Explicit proxy-account transport authentication. Never generates a player
// LoginPacket. Cache persistence was explicitly requested by the operator.
export async function authenticateTransport(version: string): Promise<Identity> {
  const directory = await proxyAuthDirectory();
  const { cache, privateKey, publicKey } = await authStorage(directory);
  const flow = new Authflow(
    'transport-probe',
    cache,
    {
      flow: 'live',
      authTitle: Titles.MinecraftNintendoSwitch,
      deviceType: 'Nintendo',
    },
    (code) => {
      // User-facing one-time login code, not the secret polling device_code.
      console.log(
        JSON.stringify({
          event: 'device_login',
          url: code.verification_uri,
          userCode: code.user_code,
          expiresIn: code.expires_in,
        }),
      );
    },
  );
  // 3.1.1's declarations say KeyObject, but the implementation serializes the
  // argument directly to JSON. The official endpoint expects a key STRING.
  const { mcToken } = await flow.getMinecraftBedrockServicesToken({ version });
  const response = await fetch(
    'https://authorization.franchise.minecraft-services.net/api/v1.0/multiplayer/session/start',
    {
      method: 'POST',
      headers: {
        authorization: mcToken,
        'content-type': 'application/json',
        'user-agent': 'libhttpclient/1.0.0.0',
      },
      body: JSON.stringify({
        publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      }),
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!response.ok) throw new Error(`multiplayer_token_http_${response.status}`);
  const data = await response.json();
  const token = data.result?.signedToken ?? data.signedToken;
  if (typeof token !== 'string' || token.split('.').length !== 3)
    throw new Error('missing_multiplayer_token');
  return { privateKey, token, domain: 'https://authorization.franchise.minecraft-services.net' };
}
