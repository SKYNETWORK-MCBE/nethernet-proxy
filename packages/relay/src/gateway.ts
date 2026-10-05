import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NetherNetGateway } from 'nethernet-gateway';
import type { VerifyClientToken } from 'nethernet-gateway';
import { SignalType } from 'nethernet';
import type { Relay } from './relay';

export interface TransportGatewayOptions {
  offerTimeoutMs?: number;
  /** Enable authenticated identity in policy middleware; transport still verifies independently. */
  verifyClientToken?: VerifyClientToken;
  /** Register policy middleware before the terminal transport handler. */
  configure?: (gateway: NetherNetGateway) => void;
}

/** HTTP signaling only. WebRTC admission and identity verification stay in the transport. */
export class TransportGateway extends NetherNetGateway {
  private requests = new AsyncLocalStorage<{
    controller: AbortController;
    cleanup: (() => void)[];
  }>();
  private activeRequests = new Set<AbortController>();

  constructor(
    readonly relay: Relay,
    { offerTimeoutMs = 25000, verifyClientToken, configure }: TransportGatewayOptions = {},
  ) {
    super({ upstream: relay.serverUrl.toString(), verifyClientToken });
    const transport = relay;
    if (!Number.isInteger(offerTimeoutMs) || offerTimeoutMs < 1)
      throw new Error('invalid_offer_timeout');
    configure?.(this);
    this.use('join', (ctx) => {
      // Gateway IDs are strings; NetherNet endpoints require unsigned uint64.
      if (!/^\d{1,20}$/.test(ctx.networkId)) return new Response(null, { status: 400 });
      const networkId = BigInt(ctx.networkId);
      if (networkId > 0xffffffffffffffffn) return new Response(null, { status: 400 });
      const connectionId = randomBytes(8).readBigUInt64LE();
      const controller = new AbortController();
      const request = this.requests.getStore();
      const disconnected = request?.controller.signal;
      return new Promise<Response>((resolve) => {
        let settled = false;
        const finish = (response: Response, reason?: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (reason) {
            disconnected?.removeEventListener('abort', onDisconnect);
            controller.abort();
            void transport.closeSession(connectionId, reason);
          }
          resolve(response);
        };
        const onDisconnect = () => {
          controller.abort();
          void transport.closeSession(connectionId, 'http_client_closed');
          finish(new Response(null, { status: 499 }));
        };
        const timer = setTimeout(
          () => finish(new Response(null, { status: 504 }), 'http_offer_timeout'),
          offerTimeoutMs,
        );
        disconnected?.addEventListener('abort', onDisconnect, { once: true });
        request?.cleanup.push(() => disconnected?.removeEventListener('abort', onDisconnect));
        if (disconnected?.aborted) return onDisconnect();
        void transport.clientEndpoint
          .handleOffer(
            {
              type: SignalType.ConnectRequest,
              connectionId,
              networkId,
              data: ctx.offer,
            },
            (signal) => {
              if (signal.type === SignalType.CandidateAdd) return;
              finish(
                new Response(signal.data, {
                  headers: {
                    'content-type':
                      signal.type === SignalType.ConnectResponse ? 'application/sdp' : 'text/plain',
                  },
                }),
                signal.type === SignalType.ConnectError ? 'client_signaling_rejected' : undefined,
              );
            },
            undefined,
            controller.signal,
          )
          .catch(() => finish(new Response(null, { status: 502 }), 'http_offer_failed'));
      });
    });
    // Never log gateway event objects: they can contain caller-supplied headers.
    this.on('requestError', () =>
      transport.log('transport_error', { stage: 'gateway', reason: 'gateway_request_failed' }),
    );
  }

  override async handleRequest(incoming: IncomingMessage, response: ServerResponse) {
    const controller = new AbortController();
    this.activeRequests.add(controller);
    const request = { controller, cleanup: [] as (() => void)[] };
    const onClose = () => {
      if (!response.writableFinished) controller.abort();
    };
    response.once('close', onClose);
    try {
      await this.requests.run(request, () => super.handleRequest(incoming, response));
    } finally {
      if (!response.writableFinished) controller.abort();
      for (const cleanup of request.cleanup) cleanup();
      this.activeRequests.delete(controller);
      response.off('close', onClose);
    }
  }

  override async close() {
    for (const controller of this.activeRequests) controller.abort();
    this.server?.closeAllConnections();
    await super.close();
  }
}
