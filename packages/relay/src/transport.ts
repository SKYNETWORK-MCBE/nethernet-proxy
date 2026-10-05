import {
  Client as NetherNetClient,
  Server as NetherNetServer,
  SignalType,
  SignalStructure,
} from 'nethernet';
import type {
  Connection,
  ClientOptions as NetherNetClientOptions,
  ServerOptions as NetherNetServerOptions,
  Identity,
} from 'nethernet';
import { signSdpIdentity, renewServerIdentity } from './server-identity';
import { sdpHash, SdpVerificationError } from './sdp-verifier';
import type { SdpVerifier, VerifiedSdpIdentity } from './sdp-verifier';
import { onClientConnectionCreated, onServerConnectionCreated } from './raw-channels';

export { captureChannels } from './raw-channels';

/** Proxy endpoint accepting connections from clients. */
export class ClientEndpoint extends NetherNetServer {
  identity?: Identity;
  offerVerifier?: SdpVerifier;
  onOfferRejected?: (signal: SignalStructure, reason: string) => void;
  maxSessions = 128;
  maxPendingOffers = 8;
  offerTimeoutMs = 20000;
  #stopped = new AbortController();
  #pending = new Set<bigint>();
  #negotiating = new Set<bigint>();
  #peers = new Map<bigint, bigint | undefined>();
  #identities = new Map<bigint, VerifiedSdpIdentity | undefined>();
  attach: (connection: Connection, networkId?: bigint, verified?: VerifiedSdpIdentity) => void;
  constructor(
    options: NetherNetServerOptions,
    attach: (connection: Connection, networkId?: bigint, verified?: VerifiedSdpIdentity) => void,
  ) {
    super(options);
    this.attach = attach;
    onServerConnectionCreated(this, (connection) => {
      if (!this.#peers.has(connection.address)) return;
      const verified = this.#identities.get(connection.address);
      this.#identities.delete(connection.address);
      this.attach(connection, this.#peers.get(connection.address), verified);
    });
    this.on('closeConnection', (id) => {
      this.#negotiating.delete(id);
      this.#peers.delete(id);
      this.#identities.delete(id);
    });
    this.on('openConnection', (connection) => this.#negotiating.delete(connection.address));
  }
  override async handleOffer(
    signal: SignalStructure,
    respond: (signal: SignalStructure) => void,
    credentials?: NetherNetServerOptions['credentials'],
    abortSignal?: AbortSignal,
  ) {
    // Snapshot before asynchronous validation. The caller cannot swap SDP,
    // peer ID or connection ID after the verification has started.
    const snapshot = new SignalStructure(
      signal.type,
      signal.connectionId,
      signal.data,
      signal.networkId,
    );
    if (
      this.#stopped.signal.aborted ||
      abortSignal?.aborted ||
      this.connections.has(snapshot.connectionId) ||
      this.#pending.has(snapshot.connectionId)
    )
      return Promise.resolve();
    if (Buffer.byteLength(snapshot.data) > 256 * 1024) {
      this.reject(snapshot, respond, 'sdp_limit');
      return;
    }
    if (
      this.connections.size + this.#pending.size >= this.maxSessions ||
      this.#negotiating.size >= this.maxPendingOffers
    ) {
      this.reject(snapshot, respond, 'admission_limit');
      return;
    }
    this.#pending.add(snapshot.connectionId);
    this.#negotiating.add(snapshot.connectionId);
    const controller = new AbortController();
    const cancellation = AbortSignal.any([
      controller.signal,
      this.#stopped.signal,
      ...(abortSignal ? [abortSignal] : []),
    ]);
    const timer = setTimeout(() => controller.abort(), this.offerTimeoutMs);
    const cancel = () => this.connections.get(snapshot.connectionId)?.close('offer_aborted');
    cancellation.addEventListener('abort', cancel, { once: true });
    try {
      if (!this.offerVerifier) {
        this.#pending.delete(snapshot.connectionId);
        await abortable(
          this.acceptOffer(snapshot, respond, credentials, undefined, cancellation),
          cancellation,
        );
        return;
      }
      const verified = await abortable(this.offerVerifier(snapshot.data), cancellation);
      if (cancellation.aborted) return;
      const boundIdentity = Object.freeze({ ...verified });
      if (
        boundIdentity.sdpSha256 !== sdpHash(snapshot.data) ||
        boundIdentity.expiresAt <= Date.now() / 1000
      ) {
        throw new SdpVerificationError('verified_sdp_mismatch');
      }
      // Move the reservation from pending to connections synchronously inside super.handleOffer.
      this.#pending.delete(snapshot.connectionId);
      await abortable(
        this.acceptOffer(snapshot, respond, credentials, boundIdentity, cancellation),
        cancellation,
      );
    } catch (error: unknown) {
      if (abortSignal?.aborted || this.#stopped.signal.aborted) return;
      const reason = cancellation.aborted
        ? 'offer_timeout'
        : error instanceof SdpVerificationError
          ? error.code
          : 'identity_verification_failed';
      this.reject(snapshot, respond, reason);
      this.connections.get(snapshot.connectionId)?.close(reason);
    } finally {
      clearTimeout(timer);
      cancellation.removeEventListener('abort', cancel);
      this.#pending.delete(snapshot.connectionId);
      if (!this.connections.has(snapshot.connectionId))
        this.#negotiating.delete(snapshot.connectionId);
    }
  }

  private reject(
    signal: SignalStructure,
    respond: (signal: SignalStructure) => void,
    reason: string,
  ) {
    try {
      this.onOfferRejected?.(signal, reason);
    } catch {
      /* diagnostics only */
    }
    try {
      respond(
        new SignalStructure(SignalType.ConnectError, signal.connectionId, '37', signal.networkId),
      );
    } catch {
      /* caller may have disconnected */
    }
  }

  override close(reason?: string) {
    this.#stopped.abort();
    super.close(reason);
  }

  private async acceptOffer(
    signal: SignalStructure,
    respond: (signal: SignalStructure) => void,
    credentials?: NetherNetServerOptions['credentials'],
    verified?: VerifiedSdpIdentity,
    cancellation?: AbortSignal,
  ) {
    this.#peers.set(signal.connectionId, signal.networkId);
    this.#identities.set(signal.connectionId, verified);
    let answered = false;
    try {
      await super.handleOffer(
        signal,
        (reply) => {
          if (reply.type === SignalType.ConnectResponse && this.identity) {
            reply.data = signSdpIdentity(
              reply.data,
              this.identity.domain === 'self' ? renewServerIdentity(this.identity) : this.identity,
            );
          }
          if (reply.type !== SignalType.CandidateAdd) answered = true;
          respond(reply);
        },
        credentials,
      );
    } finally {
      if (!this.connections.has(signal.connectionId)) {
        this.#peers.delete(signal.connectionId);
        this.#identities.delete(signal.connectionId);
        // The server connection can fail while the answer to the client is still being generated.
        // Do not leave its HTTP offer waiting until the gateway deadline.
        if (!answered && !cancellation?.aborted && !this.#stopped.signal.aborted) {
          respond(
            new SignalStructure(
              SignalType.ConnectError,
              signal.connectionId,
              '26',
              signal.networkId,
            ),
          );
        }
      }
    }
  }

  override handleCandidate(signal: SignalStructure, respond?: (signal: SignalStructure) => void) {
    if (
      !this.connections.has(signal.connectionId) ||
      this.#peers.get(signal.connectionId) !== signal.networkId
    )
      return Promise.resolve();
    return super.handleCandidate(
      new SignalStructure(signal.type, signal.connectionId, signal.data, signal.networkId),
      respond,
    );
  }
}

/** Proxy connector opening its own connection to a server. */
export function createServerConnector(
  networkId: bigint,
  options: NetherNetClientOptions,
  attach: (connection: Connection) => void,
) {
  const connector = new NetherNetClient(networkId, '127.0.0.1', options);
  onClientConnectionCreated(connector, attach);
  return connector;
}

export function useHttpSignaling(
  client: NetherNetClient,
  url: string | URL,
  { timeoutMs = 20000 } = {},
) {
  const controller = new AbortController();
  client.once('disconnect', () => controller.abort());
  client.signalHandler = (signal) => {
    // HTTP join is non-trickle; Werift setLocalDescription gathers candidates.
    if (signal.type !== SignalType.ConnectRequest) return;
    void (async () => {
      try {
        const response = await fetch(new URL(`/v1/join/${client.networkId}`, url), {
          method: 'POST',
          headers: { 'content-type': 'application/sdp', 'user-agent': 'libhttpclient/1.0.0.0' },
          body: signal.data,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
        });
        if (!response.ok || !response.body) throw new Error('server_http_status');
        const reader = response.body.getReader();
        const parts: Buffer[] = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 256 * 1024) {
            await reader.cancel();
            throw new Error('server_sdp_limit');
          }
          parts.push(Buffer.from(value));
        }
        const data = Buffer.concat(parts).toString('utf8');
        if (/^\d+$/.test(data.trim())) {
          client.handleSignal({
            type: SignalType.ConnectError,
            connectionId: signal.connectionId,
            networkId: client.serverNetworkId,
            data: data.trim(),
          });
        } else if (data.startsWith('v=0')) {
          client.handleSignal({
            type: SignalType.ConnectResponse,
            connectionId: signal.connectionId,
            networkId: client.serverNetworkId,
            data,
          });
        } else throw new Error('server_invalid_sdp');
      } catch {
        if (!controller.signal.aborted) client.close('server_signaling_failed');
      }
    })();
  };
  const close = client.close.bind(client);
  client.close = (reason) => {
    controller.abort();
    close(reason);
  };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('offer_aborted'));
    if (signal.aborted) {
      void promise.catch(() => {});
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** nethernet's close() does not await the WebRTC backend's asynchronous close. */
export function trackConnectionClose(connection: Connection) {
  const close = connection.rtcConnection.close.bind(connection.rtcConnection);
  let completion = Promise.resolve();
  connection.rtcConnection.close = () => {
    try {
      completion = Promise.resolve(close()).then(
        () => {},
        () => {},
      );
    } catch {
      completion = Promise.resolve();
    }
  };
  return () => completion;
}
