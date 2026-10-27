import * as native from '@deepseek-ai/dsh-llm';
import Schema from '@deepseek-ai/schemastery';
import { createRuntimeServices } from './siwc/runtime-services.js';
import { createHostPlugin } from './siwc/host.js';
import * as connectionNative from '@deepseek-ai/dsh-client-connection';
import { watchPresetIntegration } from './siwc/preset-runtime.js';

// Resolve the declared peer to the installed runtime's own module. Never
// replace bundled pi-ai, install another Llm service, or mount test endpoints.
const plugin = createHostPlugin(
  native,
  (ctx, { requestPolicy }) => createRuntimeServices(ctx, native, requestPolicy),
  {
    Schema,
    connectionNative,
    installPresetIntegration: (ctx) =>
      watchPresetIntegration(ctx, new URL('./compaction.js', import.meta.url).href, async () => {
        const [{ default: NativePreset }, nativeRegistry] = await Promise.all([
          import('@deepseek-ai/dsh-agent-preset'),
          import('@deepseek-ai/dsh-agent-preset-registry'),
        ]);
        return { NativePreset, nativeRegistry };
      }),
  },
);
export const { name, inject, Config, apply } = plugin;
