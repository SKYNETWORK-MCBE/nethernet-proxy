import { createPublicKey } from 'node:crypto'
import { Authentication, AuthenticationType } from '@bedrock-apis/carolina-authentication'
import type { ClientData, LoginTokens } from '@serenityjs/protocol'
import { createMinecraftClientTokenVerifier } from 'nethernet-gateway/minecraft'
import type { LoginIdentity } from './identity'

const verifyToken = createMinecraftClientTokenVerifier()

/** PoC's token → authenticated cpk → signed client JWT flow, without retaining credentials. */
export async function verifyLoginClientData(tokens: LoginTokens): Promise<{
  identity: LoginIdentity
  clientData: Readonly<ClientData>
}> {
  const authentication = Authentication.parse(tokens.identity)
  if (authentication.AuthenticationType !== AuthenticationType.Online)
    throw new Error('unsupported_login_authentication')
  // Reuse the relay ecosystem's issuer/audience/RS256/JWKS checks, including a bounded JWKS fetch.
  const online = await verifyToken(authentication.Token)
  const key = createPublicKey({ key: online.cpk, format: 'jwk' })
    .export({ type: 'spki', format: 'der' })
    .toString('base64')
  const client = await Authentication.verify<ClientData>(tokens.client, key)
  if (client == null) throw new Error('missing_client_data')
  return {
    identity: Object.freeze({
      source: 'login',
      verified: true,
      name: online.gamertag,
      xuid: online.xuid,
    }),
    clientData: Object.freeze(client),
  }
}
