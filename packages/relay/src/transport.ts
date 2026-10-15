import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
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
import type { SignalingRequest } from './types';

export { captureChannels } from './raw-channels';

type PortRange = number | readonly [number, number];

/** One BDS server-udp-ports entry: an external port (range) forwarded to an internal one. */
export interface PublicUdpMapping {
  external: PortRange;
  /** Same length as external. Defaults to external. */
  internal?: PortRange;
}

/** Equivalent of BDS server-udp-ports: a public address forwarded to fixed local UDP ports. */
export interface PublicUdpPorts {
  /** Address advertised to clients. */
  address: string;
  /** Tried in order; each session binds one free internal port. */
  ports: readonly PublicUdpMapping[];
  /** Local IPv4 address to bind and advertise as host candidate. Defaults to all interfaces. */
  interfaceAddress?: string;
}

const toRange = (range: PortRange): [number, number] =>
  typeof range === 'number' ? [range, range] : [range[0], range[1]];

function portMappings({ address, ports }: PublicUdpPorts) {
  const mappings = ports.map(({ external, internal = external }) => ({
    external: toRange(external),
    internal: toRange(internal),
  }));
  const valid = (range: number[]) =>
    range.every((port) => Number.isInteger(port) && port > 0 && port < 65536) &&
    range[0] <= range[1];
  const internals = mappings.map(({ internal }) => internal).sort((a, b) => a[0] - b[0]);
  if (
    !address ||
    !mappings.length ||
    mappings.some(
      ({ external, internal }) =>
        !valid(external) ||
        !valid(internal) ||
        external[1] - external[0] !== internal[1] - internal[0],
    ) ||
    internals.some((range, index) => index > 0 && range[0] <= internals[index - 1][1])
  )
    throw new Error('invalid_public_udp');
  return mappings;
}

export function validatePublicUdp(publicUdp: PublicUdpPorts) {
  portMappings(publicUdp);
}

/** Append a public candidate for each forwarded local host port. */
export function addPublicCandidates(sdp: string, publicUdp: PublicUdpPorts) {
  const mappings = portMappings(publicUdp);
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);
  const added: string[] = [];
  let last = -1;
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith('a=candidate:')) continue;
    last = index;
    // a=candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> ...
    const fields = line.split(' ');
    const port = Number(fields[5]);
    if (fields[2]?.toLowerCase() !== 'udp' || fields[7] !== 'host') continue;
    const mapping = mappings.find(({ internal }) => port >= internal[0] && port <= internal[1]);
    if (!mapping) continue;
    const mapped = port - mapping.internal[0] + mapping.external[0];
    fields[0] = `a=candidate:public${mapped}`;
    fields[4] = publicUdp.address;
    fields[5] = String(mapped);
    const candidate = fields.join(' ');
    if (!added.includes(candidate)) added.push(candidate);
  }
  if (!added.length) return sdp;
  lines.splice(last + 1, 0, ...added);
  return lines.join(eol);
}

async function bindable(port: number, address: string) {
  const socket = createSocket('udp4');
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(port, address, resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    try {
      socket.close();
    } catch {
      /* bind failed */
    }
  }
}

async function freeInternalPort(mappings: ReturnType<typeof portMappings>, address: string) {
  for (const { internal } of mappings)
    for (let port = internal[0]; port <= internal[1]; port++)
      if (await bindable(port, address)) return port;
}

type Attach = (
  connection: Connection,
  networkId?: bigint,
  verified?: VerifiedSdpIdentity,
  request?: SignalingRequest,
) => void;

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
  #requests = new Map<bigint, SignalingRequest | undefined>();
  attach: Attach;
  publicUdp?: PublicUdpPorts;
  constructor(
    options: NetherNetServerOptions,
    attach: Attach,
    publicUdp?: PublicUdpPorts,
  ) {
    super(options);
    this.attach = attach;
    if (publicUdp) {
      const mappings = portMappings(publicUdp);
      if ((options.webrtcBackend ?? 'werift') !== 'werift')
        throw new Error('public_udp_requires_werift');
      this.publicUdp = publicUdp;
      const self = this as unknown as {
        webrtc: { RTCPeerConnection: new (config: object) => any };
      };
      const Base = self.webrtc.RTCPeerConnection;
      const bindAddress = publicUdp.interfaceAddress ?? '0.0.0.0';
      // Werift binds udp4 and gathers only host addresses listed here, so each session
      // opens a single socket. Several sockets would race for the same fixed port.
      const iceInterfaceAddresses = {
        udp4: bindAddress,
        host:
          publicUdp.interfaceAddress ??
          Object.values(networkInterfaces())
            .flat()
            .find((info) => info?.family === 'IPv4' && !info.internal)?.address,
      };
      // Werift probes a free port and binds it later without an error handler.
      // Gather one connection at a time so sessions do not pick the same port.
      let gathering = Promise.resolve();
      self.webrtc = {
        ...self.webrtc,
        RTCPeerConnection: class extends Base {
          constructor(config: object) {
            super({ ...config, iceInterfaceAddresses });
          }
          setLocalDescription(description: unknown) {
            const result = gathering.then(async () => {
              const port = await freeInternalPort(mappings, bindAddress);
              if (port === undefined) throw new Error('public_udp_exhausted');
              for (const ice of this.iceTransports) ice.connection.options.portRange = [port, port];
              return super.setLocalDescription(description);
            });
            gathering = result.then(
              () => {},
              () => {},
            );
            return result;
          }
        },
      };
    }
    onServerConnectionCreated(this, (connection) => {
      if (!this.#peers.has(connection.address)) return;
      const verified = this.#identities.get(connection.address);
      const request = this.#requests.get(connection.address);
      this.#identities.delete(connection.address);
      this.#requests.delete(connection.address);
      this.attach(connection, this.#peers.get(connection.address), verified, request);
    });
    this.on('closeConnection', (id) => {
      this.#negotiating.delete(id);
      this.#peers.delete(id);
      this.#identities.delete(id);
      this.#requests.delete(id);
    });
    this.on('openConnection', (connection) => this.#negotiating.delete(connection.address));
  }
  override async handleOffer(
    signal: SignalStructure,
    respond: (signal: SignalStructure) => void,
    credentials?: NetherNetServerOptions['credentials'],
    abortSignal?: AbortSignal,
    request?: SignalingRequest,
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
          this.acceptOffer(snapshot, respond, credentials, undefined, cancellation, request),
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
        this.acceptOffer(snapshot, respond, credentials, boundIdentity, cancellation, request),
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
    request?: SignalingRequest,
  ) {
    this.#peers.set(signal.connectionId, signal.networkId);
    this.#identities.set(signal.connectionId, verified);
    this.#requests.set(signal.connectionId, request);
    let answered = false;
    try {
      await super.handleOffer(
        signal,
        (reply) => {
          if (reply.type === SignalType.ConnectResponse && this.publicUdp)
            reply.data = addPublicCandidates(reply.data, this.publicUdp);
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
        this.#requests.delete(signal.connectionId);
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
