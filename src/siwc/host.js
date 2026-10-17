import { createAdapterClass } from './adapter.js';
import { API_PATH, PROVIDER, SiwcController, createSiwcHandler } from './controller.js';
import { OWNER, SELECTION_KEY } from './accounts.js';
import { assertHostContract, nativeContractIssues } from '../compatibility.js';
import { createPluginConfig, normalizePluginConfig } from './request-policy.js';

const starting = () => new Response('DSH_PLUGIN_STARTING', { status: 503 });

// Probe only the actual management route's inert startup handler, in process.
// No network, extra endpoint, account read, token write or upstream call occurs.
async function assertOwnerBoundary(connection, isClosed) {
  let timer;
  try {
    await Promise.race([
      (async () => {
        const carrier = connection.createSharedFetchHandler('/api');
        for (const method of ['GET', 'POST']) {
          const request = () =>
            new Request(`http://localhost${API_PATH}`, {
              method,
              ...(method === 'POST' ? { body: '{}' } : {}),
            });
          const denied = await carrier.fetch(request(), {
            id: 'siwc-startup-guest',
            principal: { kind: 'guest' },
          });
          if (isClosed()) return;
          if (denied.status !== 403) throw Error();
          const allowed = await carrier.fetch(request(), {
            id: 'siwc-startup-owner',
            principal: { kind: 'owner' },
          });
          if (isClosed()) return;
          if (allowed.status !== 503 || (await allowed.text()) !== 'DSH_PLUGIN_STARTING')
            throw Error();
        }
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('DSH_CONNECTION_OWNER_BOUNDARY_TIMEOUT')), 5000);
      }),
    ]);
  } catch (error) {
    if (isClosed()) return;
    throw new Error(
      error?.message === 'DSH_CONNECTION_OWNER_BOUNDARY_TIMEOUT'
        ? 'DSH_CONNECTION_OWNER_BOUNDARY_TIMEOUT'
        : 'DSH_CONNECTION_OWNER_BOUNDARY_CHANGED',
    );
  } finally {
    clearTimeout(timer);
  }
}

// Runtime factories must return protected host-side services, not UI data.
export function createHostPlugin(native, createRuntime, { verifyCandidate, Schema } = {}) {
  const issues = nativeContractIssues(native);
  if (issues.length) throw new Error(`DSH_HOST_CONTRACT_MISSING:${issues.join(',')}`);
  const Adapter = createAdapterClass(native);
  return {
    name: 'chatgpt-subscription-login',
    inject: ['connection', 'credentials', 'llm'],
    ...(Schema ? { Config: createPluginConfig(Schema) } : {}),
    async apply(ctx, config) {
      const { requestPolicy } = normalizePluginConfig(config);
      const compatibility = assertHostContract(native, ctx);
      let closed = false;
      let runtime, adapter, controller, handler;
      ctx.effect(
        () => async () => {
          closed = true;
          controller?.dispose();
          adapter?.dispose();
          await runtime?.sessions.dispose?.();
        },
        'chatgpt-subscription: lifetime',
      );
      if (closed) return;
      if (compatibility.status === 'candidate') {
        if (typeof verifyCandidate !== 'function')
          throw new Error('DSH_CANDIDATE_VALIDATION_REQUIRED');
        await verifyCandidate(compatibility.version);
        if (closed) return;
      }
      ctx.connection.fetch.register({
        path: API_PATH,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: (request) =>
          closed ? new Response(null, { status: 410 }) : handler ? handler(request) : starting(),
      });
      // Preserve the separately validated legacy carrier. Every 0.2.1+ runtime,
      // including candidates after a direct Desktop update, must enforce owner.
      if (compatibility.version !== '0.2.0-rc.2')
        await assertOwnerBoundary(ctx.connection, () => closed);
      if (closed) return;
      if (compatibility.status === 'candidate')
        console.warn(
          `DSH_COMPATIBILITY_CANDIDATE:${compatibility.version}:local synthetic checks passed; not a validated release`,
        );
      runtime = createRuntime(ctx);
      adapter = new Adapter({ ...runtime, requestPolicy, logger: ctx.logger });
      const handle = ctx.llm.registerAdapter([PROVIDER], adapter);
      if (typeof handle?.replace !== 'function')
        throw new Error('DSH_ADAPTER_HANDLE_CONTRACT_CHANGED');
      const changed = () => {
        if (!closed) {
          adapter.invalidate();
          handle.replace([PROVIDER]);
        }
      };
      controller = new SiwcController(
        {
          ...runtime,
          readNotice: () => adapter.notice,
          onSelection: async (selection) => {
            adapter.clearNotice();
            await runtime.sessions.selectionChanged?.(selection);
            changed();
          },
        },
        runtime.controllerOptions,
      );
      handler = createSiwcHandler(controller);
      // Rotating a token invalidates catalog metadata, not a running request.
      ctx.on('credentials/record-updated', async (key) => {
        if (key === SELECTION_KEY) {
          adapter.clearNotice();
          await runtime.sessions.selectionChanged?.(await runtime.accounts.selection());
        } else if (typeof key === 'string' && key.startsWith(`${OWNER}/account-`))
          await runtime.sessions.accountChanged?.(key);
        else return;
        changed();
      });
    },
  };
}
