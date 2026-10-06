export interface PlayerIdentity {
  readonly verified: boolean;
  readonly name?: string;
  readonly xuid?: string;
  /** Playfab ID */
  readonly persistentId?: string;
  readonly uuid?: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_login_identity');
  return value as Record<string, unknown>;
}
export function loginClaims(token: unknown) {
  if (typeof token !== 'string') throw new Error('invalid_login_identity');
  const parts = token.split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1]))
    throw new Error('invalid_login_identity');
  return object(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
}
function text(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Decode a small allowlist only; BDS acceptance is not JWT verification by this library. */
export function loginIdentity(identity: string): PlayerIdentity {
  const data = object(JSON.parse(identity));
  if (typeof data.Token === 'string' && data.Token.length) {
    const token = loginClaims(data.Token);
    return Object.freeze({
      verified: false,
      name: text(token.xname),
      xuid: text(token.xid),
      pfid: text(token.mid),
    });
  }
  if (data.Certificate !== undefined && typeof data.Certificate !== 'string')
    throw new Error('invalid_login_identity');
  const certificate = data.Certificate === undefined ? data : object(JSON.parse(data.Certificate));
  if (!Array.isArray(certificate.chain)) throw new Error('invalid_login_identity');
  for (const token of certificate.chain) {
    const extra = loginClaims(token).extraData;
    if (extra === undefined) continue;
    const info = object(extra);
    return Object.freeze({
      verified: false,
      name: text(info.displayName),
      xuid: text(info.XUID),
      uuid: text(info.identity),
    });
  }
  throw new Error('invalid_login_identity');
}
