import { createAdapterClass } from './adapter.js';
import { API_PATH, PROVIDER, SiwcController, createSiwcHandler } from './controller.js';
import { OWNER, SELECTION_KEY } from './accounts.js';
import {
  assertHostContract,
  nativeContractIssues,
  isOperatorConnection,
} from '../compatibility.js';
import { unavailablePresetIntegration } from './preset-integration.js';
import { createPluginConfig, normalizePluginConfig } from './request-policy.js';

const diagnostic = (error) =>
  Response.json(
    { error },
    {
      status: 503,
      headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    },
  );

// Inert, in-process probes of the actual management route. No account read,
// credential write, network request or upstream call occurs.
async function assertOwnerBoundary(connection, nativeConnection, isClosed) {
  let timer;
  try {
    await Promise.race([
      (async () => {
        const carrier = connection.createSharedFetchHandler('/api');
        const operatorOnly = isOperatorConnection(connection, nativeConnection);
        if (operatorOnly) {
          for (const host of ['localhost', 'untrusted.invalid']) {
            const admission = connection.admit({ headers: { host }, url: API_PATH, method: 'GET' });
            if (![401, 403].includes(admission?.rejection)) throw Error();
          }
        }
        for (const method of ['GET', 'POST']) {
          const request = () =>
            new Request(`http://localhost${API_PATH}`, {
              method,
              ...(method === 'POST' ? { body: '{}' } : {}),
            });
          if (!operatorOnly) {
            const denied = await carrier.fetch(request(), {
              id: 'siwc-startup-guest',
              principal: { kind: 'guest' },
            });
            if (isClosed()) return;
            if (denied.status !== 403) throw Error();
          }
          const allowed = await carrier.fetch(
            request(),
            operatorOnly
              ? connection.operator
              : { id: 'siwc-startup-owner', principal: { kind: 'owner' } },
          );
          if (isClosed()) return;
          if (allowed.status !== 503 || (await allowed.json()).error !== 'DSH_PLUGIN_STARTING')
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

// Runtime factories return protected host-side services, never UI data. Only
// essential account/provider services are hard dependencies; session protection
// owns its own lifecycle and denies uncovered session requests independently.
export function createHostPlugin(
  native,
  createRuntime,
  { Schema, installPresetIntegration, connectionNative } = {},
) {
  const issues = nativeContractIssues(native);
  if (issues.length) throw new Error(`DSH_HOST_CONTRACT_MISSING:${issues.join(',')}`);
  const Adapter = createAdapterClass(native);
  return {
    name: 'chatgpt-subscription-login',
    inject: ['connection', 'credentials', 'llm'],
    ...(Schema ? { Config: createPluginConfig(Schema) } : {}),
    async apply(ctx, config) {
      const { requestPolicy } = normalizePluginConfig(config);
      assertHostContract(native, ctx);
      let closed = false;
      let runtime, adapter, controller, handler;
      let startupError = 'DSH_PLUGIN_STARTING';
      ctx.effect(
        () => async () => {
          closed = true;
          controller?.dispose();
          adapter?.dispose();
          try {
            await runtime?.sessions.dispose?.();
          } finally {
            runtime?.network?.dispose?.();
            await runtime?.catalogCache?.dispose?.();
          }
        },
        'chatgpt-subscription: lifetime',
      );
      if (closed) return;
      ctx.connection.fetch.register({
        path: API_PATH,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: (request) =>
          closed
            ? new Response(null, { status: 410 })
            : handler
              ? handler(request)
              : diagnostic(startupError),
      });
      try {
        await assertOwnerBoundary(ctx.connection, connectionNative, () => closed);
      } catch (error) {
        startupError = error.message;
        throw error;
      }
      if (closed) return;
      let integration;
      try {
        integration = await installPresetIntegration?.(ctx);
      } catch (error) {
        integration = unavailablePresetIntegration(error);
      }
      if (closed) return;
      runtime = createRuntime(ctx, { requestPolicy });
      adapter = new Adapter({
        ...runtime,
        requestPolicy,
        logger: ctx.logger,
        assertCoverage: integration?.assertCoverage,
      });
      const handle = ctx.llm.registerAdapter([PROVIDER], adapter);
      if (typeof handle?.replace !== 'function') {
        startupError = 'DSH_ADAPTER_HANDLE_CONTRACT_CHANGED';
        throw new Error(startupError);
      }
      runtime.ready
        ?.then(() => {
          if (!closed) handle.replace([PROVIDER]);
        })
        .catch(() => {});
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
          readDirectory: () => adapter.directoryStatus,
          readNetwork: runtime.readNetwork,
          refreshModels: async (signal, options) => {
            const result = await adapter.refreshModels(signal, options);
            if (!closed) handle.replace([PROVIDER]);
            return result;
          },
          readCoverage: integration?.readCoverage,
          onSelection: async (selection) => {
            adapter.clearNotice();
            await runtime.sessions.selectionChanged?.(selection);
            changed();
          },
        },
        runtime.controllerOptions,
      );
      handler = createSiwcHandler(controller);
      ctx.on('credentials/record-updated', async (key) => {
        if (key === SELECTION_KEY) {
          adapter.clearNotice();
          await runtime.sessions.selectionChanged?.(await runtime.accounts.selection());
        } else if (typeof key === 'string' && key.startsWith(`${OWNER}/account-`)) {
          if ((await runtime.sessions.accountChanged?.(key)) === false) return;
        } else return;
        changed();
      });
    },
  };
}
