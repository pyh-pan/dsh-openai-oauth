import * as native from '@deepseek-ai/dsh-llm';
import Schema from '@deepseek-ai/schemastery';
import { AccountStore } from './siwc/accounts.js';
import { OpenAIProtocol } from './siwc/protocol.js';
import { SessionManager } from './siwc/sessions.js';
import { createHostPlugin } from './siwc/host.js';
import * as connectionNative from '@deepseek-ai/dsh-client-connection';
import { watchPresetIntegration } from './siwc/preset-runtime.js';
import { createAttachmentBridge } from './siwc/attachment-bridge.js';

// Resolve the declared peer to the installed runtime's own module. Never
// replace bundled pi-ai, install another Llm service, or mount test endpoints.
const plugin = createHostPlugin(
  native,
  (ctx) => {
    const accounts = new AccountStore(ctx.credentials);
    // Temporary diagnostic build: capture one sanitized token-request failure.
    const protocol = new OpenAIProtocol({ diagnostics: true });
    const bridge = createAttachmentBridge(ctx, native);
    return {
      accounts,
      protocol,
      sessions: new SessionManager({ accounts, protocol }),
      attachments: bridge.store,
      restoreFiles: bridge.restoreFiles,
    };
  },
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
