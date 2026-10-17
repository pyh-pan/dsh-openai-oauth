import { createAdapterClass } from './adapter.js';
import { API_PATH, PROVIDER, SiwcController, createSiwcHandler } from './controller.js';
import { OWNER, SELECTION_KEY } from './accounts.js';

// Isolatable host composition, used by both production entry and native tests.
// Runtime factories must return protected host-side services, not UI data.
export function createHostPlugin(native, createRuntime) {
  const Adapter = createAdapterClass(native);
  return {
    name: 'chatgpt-subscription-login',
    inject: ['connection', 'credentials', 'llm'],
    apply(ctx) {
      const runtime = createRuntime(ctx);
      const adapter = new Adapter(runtime);
      const handle = ctx.llm.registerAdapter([PROVIDER], adapter);
      let closed = false;
      const changed = () => {
        if (!closed) {
          adapter.invalidate();
          handle.replace([PROVIDER]);
        }
      };
      const controller = new SiwcController(
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
      ctx.connection.fetch.register({
        path: API_PATH,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: createSiwcHandler(controller),
      });
      // credentials-local reloads its cross-process document before notifying.
      // Refreshes invalidate catalog metadata, but only logout/selection changes
      // cancel a running request; rotating an access token alone does not.
      ctx.on('credentials/record-updated', async (key) => {
        if (key === SELECTION_KEY) {
          adapter.clearNotice();
          await runtime.sessions.selectionChanged?.(await runtime.accounts.selection());
        } else if (typeof key === 'string' && key.startsWith(`${OWNER}/account-`))
          await runtime.sessions.accountChanged?.(key);
        else return;
        changed();
      });
      ctx.effect(
        () => async () => {
          closed = true;
          controller.dispose();
          adapter.dispose();
          await runtime.sessions.dispose?.();
        },
        'chatgpt-subscription: lifetime',
      );
    },
  };
}
