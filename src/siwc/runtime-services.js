import { AccountStore, OWNER } from './accounts.js';
import { OpenAIProtocol } from './protocol.js';
import { SessionManager } from './sessions.js';
import { createAttachmentBridge } from './attachment-bridge.js';
import { createHostTransport, TransportFailure } from './network-transport.js';
import { ModelCache } from './model-cache.js';
import { withSignal } from './abortable.js';

async function optionalPeer(specifier) {
  try {
    return await import(specifier);
  } catch (error) {
    const missing = /^Cannot find (?:package|module) ['"]([^'"]+)['"]/.exec(
      error?.message ?? '',
    )?.[1];
    if (['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(error?.code) && missing === specifier)
      return;
    throw error;
  }
}
const publicAddress = (module) => {
  const api = module?.default ?? module;
  if (typeof api?.parse !== 'function') return;
  return (value) => {
    try {
      let address = api.parse(value);
      if (address.isIPv4MappedAddress?.()) address = address.toIPv4Address();
      return address.range() === 'unicast';
    } catch {
      return false;
    }
  };
};
// Optional services initialize independently: account settings/provider owner
// registration must not wait for their imports. Each network wait is covered
// by its caller's deadline, with proven not-sent state until dispatch begins.
export function createRuntimeServices(ctx, native, { transport = 'auto' } = {}) {
  const accounts = new AccountStore(ctx.credentials),
    catalogCache = new ModelCache();
  let network,
    closed = false,
    networkMode = 'initializing';
  const requests = new WeakMap();
  const networkReady = (async () => {
    let route, guard;
    networkMode = transport === 'host' ? 'host-selected' : 'host-no-capability';
    if (transport !== 'host') {
      try {
        const [proxy, ipaddr] = await Promise.all([
          optionalPeer('@deepseek-ai/dsh-http-proxy'),
          optionalPeer('ipaddr.js'),
        ]);
        route = typeof proxy?.proxyRouteFor === 'function' ? proxy.proxyRouteFor : undefined;
        guard = publicAddress(ipaddr);
        if (route && guard) networkMode = 'bounded-ready';
      } catch {
        networkMode = 'blocked-contract';
        route = () => {
          throw Error('SIWC_NATIVE_NETWORK_CONTRACT_UNAVAILABLE');
        };
      }
    }
    if (!closed) network = createHostTransport({ proxyRouteFor: route, isPublicAddress: guard });
    return network;
  })();
  const cacheReady = (async () => {
    try {
      const paths = await optionalPeer('@deepseek-ai/dsh-home-paths');
      const candidate = paths?.dshCachePath?.(OWNER, 'model-catalogs');
      if (!closed && typeof candidate === 'string' && candidate) catalogCache.root = candidate;
    } catch {
      /* Optional display persistence only, never authorization state. */
    }
  })();
  const scoped = {
    async fetch(input, options = {}) {
      const state = { delegated: false };
      if (options.signal) requests.set(options.signal, state);
      const value = await withSignal(() => networkReady, options.signal);
      if (closed || !value) throw new TransportFailure('SIWC_TRANSPORT_CLOSED');
      state.delegated = true;
      return value.fetch(input, options);
    },
    stateFor(signal) {
      return requests.get(signal)?.delegated
        ? network?.stateFor(signal)
        : { stage: 'policy', writeOutcome: 'not_sent' };
    },
    dispose() {
      closed = true;
      network?.dispose();
    },
  };
  const ready = Promise.all([networkReady, cacheReady]);
  ready.catch(() => {});
  const protocol = new OpenAIProtocol({ fetchImpl: scoped.fetch, stateFor: scoped.stateFor });
  const bridge = createAttachmentBridge(ctx, native);
  return {
    accounts,
    protocol,
    network: scoped,
    catalogCache,
    fetchImpl: scoped.fetch,
    ready,
    sessions: new SessionManager({ accounts, protocol }),
    attachments: bridge.store,
    restoreFiles: bridge.restoreFiles,
    readNetwork: () => ({
      mode: networkMode,
      route: network?.status.route ?? 'unused',
      persistentCatalog: !!catalogCache.root,
    }),
  };
}
