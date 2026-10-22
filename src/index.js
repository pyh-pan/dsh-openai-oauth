import * as native from '@deepseek-ai/dsh-llm';
import Schema from '@deepseek-ai/schemastery';
import { AccountStore } from './siwc/accounts.js';
import { OpenAIProtocol } from './siwc/protocol.js';
import { SessionManager } from './siwc/sessions.js';
import { createHostPlugin } from './siwc/host.js';
import { validateRunningCandidate } from './desktop-preflight.js';
import { createAttachmentBridge } from './siwc/attachment-bridge.js';

// Resolve the declared peer to the installed runtime's own module. Never
// replace bundled pi-ai, install another Llm service, or mount test endpoints.
const plugin = createHostPlugin(
  native,
  (ctx) => {
    const accounts = new AccountStore(ctx.credentials);
    const protocol = new OpenAIProtocol();
    const bridge = createAttachmentBridge(ctx, native);
    return {
      accounts,
      protocol,
      sessions: new SessionManager({ accounts, protocol }),
      attachments: bridge.store,
      restoreFiles: bridge.restoreFiles,
    };
  },
  { verifyCandidate: validateRunningCandidate, Schema },
);
export const { name, inject, Config, apply } = plugin;
