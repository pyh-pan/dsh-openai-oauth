import * as native from '@deepseek-ai/dsh-llm';
import { AccountStore } from './siwc/accounts.js';
import { OpenAIProtocol } from './siwc/protocol.js';
import { SessionManager } from './siwc/sessions.js';
import { createHostPlugin } from './siwc/host.js';

// Resolve the declared peer to the installed runtime's own module. Never
// replace bundled pi-ai, install another Llm service, or mount test endpoints.
const plugin = createHostPlugin(native, (ctx) => {
  const accounts = new AccountStore(ctx.credentials);
  const protocol = new OpenAIProtocol();
  return { accounts, protocol, sessions: new SessionManager({ accounts, protocol }) };
});
export const { name, inject, apply } = plugin;
