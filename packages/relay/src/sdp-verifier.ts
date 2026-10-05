import { createHash, createPublicKey } from 'node:crypto'
import { verifyClientIdentity } from 'nethernet-gateway'
import type { VerifyClientToken } from 'nethernet-gateway'
import { createMinecraftClientTokenVerifier } from 'nethernet-gateway/minecraft'

export interface VerifiedSdpIdentity {
  readonly sdpSha256: string
  readonly xuid: string
  readonly gamertag: string
  readonly playFabId: string
  readonly publicKeyFingerprint: string
  readonly issuer: string
  readonly expiresAt: number
}
export type SdpVerifier = (sdp: string) => Promise<VerifiedSdpIdentity>
export class SdpVerificationError extends Error {
  constructor(
    readonly code:
      | 'invalid_sdp_identity'
      | 'identity_verification_failed'
      | 'verified_sdp_mismatch'
      | 'verification_busy',
  ) {
    super(code)
  }
}
export function sdpHash(sdp: string) {
  return createHash('sha256').update(sdp, 'utf8').digest('hex')
}

export function createSdpVerifier(
  options: {
    /** Trusted callback: must authenticate JWTs, never merely decode claims. */
    verifyClientToken?: VerifyClientToken
    maxConcurrent?: number
  } = {},
): SdpVerifier {
  // Reuse the gateway's pinned issuer/audience/RS256/JWKS verifier. Neither
  // idp.domain nor client token headers control the remote key source.
  const verifyToken = options.verifyClientToken ?? createMinecraftClientTokenVerifier()
  const maxConcurrent = options.maxConcurrent ?? 8
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1)
    throw new Error('invalid_verifier_configuration')
  let active = 0
  return async (sdp) => {
    if (active >= maxConcurrent) throw new SdpVerificationError('verification_busy')
    active++
    try {
      try {
        // This function also checks session-level identity uniqueness and the
        // detached fingerprint JWS against the authenticated token's cpk.
        const identity = await verifyClientIdentity(sdp, verifyToken)
        if (!identity) throw new Error('missing_identity')
        const expiresAt = identity.claims.exp
        const issuer = identity.claims.iss
        if (
          typeof expiresAt !== 'number' ||
          !Number.isInteger(expiresAt) ||
          expiresAt <= Date.now() / 1000 ||
          typeof issuer !== 'string' ||
          !issuer ||
          !/^[1-9][0-9]{0,19}$/.test(identity.xuid)
        )
          throw new Error('invalid_verified_claims')
        const publicKey = createPublicKey({ key: identity.cpk, format: 'jwk' })
        if (
          publicKey.asymmetricKeyType !== 'ec' ||
          publicKey.asymmetricKeyDetails?.namedCurve !== 'secp384r1'
        )
          throw new Error('invalid_cpk')
        return Object.freeze({
          sdpSha256: sdpHash(sdp),
          xuid: identity.xuid,
          gamertag: identity.gamertag,
          playFabId: identity.playFabId,
          issuer,
          expiresAt,
          publicKeyFingerprint: createHash('sha256')
            .update(publicKey.export({ type: 'spki', format: 'der' }))
            .digest('hex'),
        })
      } catch {
        // Never expose library exceptions: they can contain client-controlled
        // claims/issuer/keys. Only a fixed diagnostic code crosses this boundary.
        throw new SdpVerificationError('identity_verification_failed')
      }
    } finally {
      active--
    }
  }
}
