import https from 'node:https';
import { Readable, pipeline } from 'node:stream';
import { createBrotliDecompress, createUnzip } from 'node:zlib';
import { BoundedLookup, hasHostOverride } from './network-lookup.js';
import { withSignal } from './abortable.js';
import { createDnsPolicy } from './network-policy.js';

const ORIGINS = new Set(['https://auth.openai.com', 'https://api.openai.com']);
export class TransportFailure extends Error {
  constructor(code = 'SIWC_TRANSPORT_FAILED') {
    super(code);
    this.code = code;
  }
}
const safeFailure = (error) =>
  new TransportFailure(
    typeof error?.code === 'string' &&
    /^(?:EAI_AGAIN|ENOTFOUND|ECONN[A-Z_]+|ENET[A-Z_]+|EHOST[A-Z_]+|ETIMEDOUT|EPIPE|ABORT_ERR|ERR_(?:TLS|SSL)_[A-Z_]+|CERT_[A-Z_]+|UNABLE_TO_[A-Z_]+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|SIWC_[A-Z_]+)$/.test(
      error.code,
    )
      ? error.code
      : 'SIWC_TRANSPORT_FAILED',
  );

// Fixed official origins only. Follow the native proxy route before doing any
// local DNS: proxied/unknown routes remain entirely with the Host fetch. Direct
// requests own a bounded resolver + private HTTPS Agent, never global settings.
export function createHostTransport({
  proxyRouteFor,
  isPublicAddress,
  fetchImpl = globalThis.fetch,
  lookup,
  hostOverride = hasHostOverride,
  dnsPolicy = createDnsPolicy(),
  request = https.request,
  agent = new https.Agent({ keepAlive: true }),
  connectTimeoutMs = 10000,
} = {}) {
  const resolver = lookup ?? new BoundedLookup({ isPublicAddress });
  const states = new WeakMap();
  let closed = false;
  let routeMode = 'unused';
  const fetch = async (input, options = {}) => {
    const state = { stage: 'policy', writeOutcome: 'not_sent' };
    if (options.signal) states.set(options.signal, state);
    let url;
    try {
      url = new URL(input);
    } catch {
      throw new TransportFailure('SIWC_ORIGIN_BLOCKED');
    }
    if (
      !ORIGINS.has(url.origin) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      (url.origin === 'https://api.openai.com' &&
        !['/v1/models', '/v1/responses'].includes(url.pathname))
    )
      throw new TransportFailure('SIWC_ORIGIN_BLOCKED');
    const assertActive = () => {
      if (closed) throw new TransportFailure('SIWC_TRANSPORT_CLOSED');
      options.signal?.throwIfAborted();
    };
    assertActive();
    let route;
    try {
      if (typeof proxyRouteFor === 'function') route = proxyRouteFor(url);
    } catch {
      throw new TransportFailure('SIWC_HOST_ROUTE_UNAVAILABLE');
    }
    const delegate = () => {
      assertActive();
      routeMode = 'host';
      state.writeOutcome = 'unknown';
      return fetchImpl(input, { ...options, redirect: 'error' });
    };
    if (route?.proxied !== false || typeof isPublicAddress !== 'function') return delegate();
    if ((await withSignal(() => hostOverride(url.hostname), options.signal)) !== false)
      return delegate();
    const dnsRoute = await withSignal(() => dnsPolicy(url.hostname), options.signal);
    if (!dnsRoute) return delegate();
    assertActive();
    routeMode = 'direct';
    const method = (options.method ?? 'GET').toUpperCase();
    if (
      !['GET', 'HEAD', 'POST'].includes(method) ||
      (options.body !== undefined &&
        typeof options.body !== 'string' &&
        !(options.body instanceof Uint8Array)) ||
      (method !== 'POST' && options.body !== undefined)
    )
      throw new TransportFailure('SIWC_INVALID_BODY');
    const headers = Object.fromEntries(new Headers(options.headers).entries());
    if (headers.host && headers.host !== url.host)
      throw new TransportFailure('SIWC_ORIGIN_BLOCKED');
    if (!headers['accept-encoding']) headers['accept-encoding'] = 'gzip, deflate, br';
    options.signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      let req,
        response,
        stream,
        timer,
        settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      };
      const fail = (error) => {
        cleanup();
        resolver.invalidate?.(url.hostname);
        const failure = safeFailure(error);
        if (!settled) {
          settled = true;
          reject(failure);
        } else stream?.destroy(failure);
      };
      const abort = () => {
        const error = new TransportFailure('ABORT_ERR');
        req?.destroy(error);
        response?.destroy(error);
        stream?.destroy(error);
        fail(error);
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) return abort();
      try {
        state.stage = 'dns';
        req = request(
          url,
          {
            method,
            headers,
            agent,
            servername: url.hostname,
            rejectUnauthorized: true,
            autoSelectFamily: true,
            autoSelectFamilyAttemptTimeout: 2000,
            lookup(hostname, lookupOptions, callback) {
              withSignal(
                () =>
                  resolver.resolve(
                    hostname,
                    lookupOptions.family ?? 0,
                    dnsRoute.servers,
                    dnsRoute.families,
                  ),
                options.signal,
              ).then(
                (records) => {
                  state.stage = 'connect';
                  if (lookupOptions.all) callback(null, records);
                  else callback(null, records[0].address, records[0].family);
                },
                (error) => callback(safeFailure(error)),
              );
            },
          },
          (incoming) => {
            if (settled) {
              incoming.destroy();
              return;
            }
            response = incoming;
            clearTimeout(timer);
            state.stage = 'body';
            const empty = method === 'HEAD' || [204, 205, 304].includes(incoming.statusCode);
            // Never follow a redirect, including before a rotating-token response.
            if ([301, 302, 303, 307, 308].includes(incoming.statusCode)) {
              incoming.destroy();
              req.destroy();
              fail(new TransportFailure('SIWC_REDIRECT_BLOCKED'));
              return;
            }
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(incoming.headers)) {
              if (Array.isArray(value)) for (const item of value) responseHeaders.append(key, item);
              else if (value !== undefined) responseHeaders.append(key, String(value));
            }
            const encoding = responseHeaders.get('content-encoding')?.trim().toLowerCase();
            stream = incoming;
            if (!empty && encoding && encoding !== 'identity') {
              const decoder =
                encoding === 'br'
                  ? createBrotliDecompress()
                  : ['gzip', 'deflate'].includes(encoding)
                    ? createUnzip()
                    : undefined;
              if (!decoder) {
                incoming.destroy();
                fail(new TransportFailure('SIWC_CONTENT_ENCODING_INVALID'));
                return;
              }
              stream = decoder;
              pipeline(incoming, decoder, () => {});
              responseHeaders.delete('content-encoding');
              responseHeaders.delete('content-length');
            }
            stream.once('end', cleanup);
            stream.once('close', () => {
              cleanup();
              if (!incoming.complete) incoming.destroy();
            });
            stream.once('error', fail);
            try {
              const result = new Response(empty ? null : Readable.toWeb(stream), {
                status: incoming.statusCode,
                headers: responseHeaders,
              });
              settled = true;
              resolve(result);
              if (empty) incoming.resume();
            } catch (error) {
              incoming.destroy();
              fail(error);
            }
          },
        );
        req.once('socket', (socket) => {
          const send = () => {
            if (settled) return;
            if (!socket.authorized) {
              req.destroy(new TransportFailure('ERR_TLS_CERT_ALTNAME_INVALID'));
              return;
            }
            // Structural proof, not a missing diagnostics event: no end/write
            // occurs before verified TLS. Mark uncertain BEFORE handing over
            // any bytes that could contain a rotating refresh credential.
            state.writeOutcome = 'unknown';
            state.stage = 'headers';
            clearTimeout(timer);
            try {
              req.end(options.body);
            } catch (error) {
              req.destroy();
              fail(error);
            }
          };
          if (socket.encrypted && socket.authorized && !socket.connecting) send();
          else {
            socket.once('connect', () => {
              state.stage = 'tls';
            });
            socket.prependOnceListener('secureConnect', send);
          }
        });
        req.once('error', fail);
        timer = setTimeout(() => req.destroy(new TransportFailure('ETIMEDOUT')), connectTimeoutMs);
      } catch (error) {
        req?.destroy();
        fail(error);
      }
    });
  };
  return {
    fetch,
    get status() {
      return { route: routeMode };
    },
    stateFor: (signal) => (states.has(signal) ? { ...states.get(signal) } : undefined),
    dispose() {
      if (!closed) {
        closed = true;
        resolver.dispose?.();
        agent.destroy();
      }
    },
  };
}
