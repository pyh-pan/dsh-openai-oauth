// Real Desktop SessionController.selectModel, with synthetic account/session
// services and controlled upstreams. No user profile or real grant is opened.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { AccountStore } from '../src/siwc/accounts.js';
import { SessionManager } from '../src/siwc/sessions.js';
import { OpenAIProtocol, DIRECT_SCOPE, ISSUER } from '../src/siwc/protocol.js';
import { createAdapterClass } from '../src/siwc/adapter.js';
import { PROVIDER } from '../src/siwc/controller.js';
import { MemoryCredentials, CLIENT, NOW } from '../test/siwc-fixtures.js';

export async function verifyNativeModelSelection(asar) {
  const req = createRequire(pathToFileURL(join(asar, 'dsh/package.json')));
  const load = (name) => import(pathToFileURL(req.resolve('@deepseek-ai/' + name)).href);
  const [{ Context }, native, nativeSessions, projections, api, registry] = await Promise.all([
    load('cordis'),
    load('dsh-llm'),
    load('dsh-session'),
    load('dsh-session-projection'),
    load('dsh-api-session-controller'),
    load('dsh-typert-registry'),
  ]);
  const Adapter = createAdapterClass(native);
  for (const expired of [false, true]) {
    let now = NOW,
      authCalls = 0,
      catalogCalls = 0,
      responseCalls = 0,
      selected;
    const accounts = new AccountStore(new MemoryCredentials());
    const key = await accounts.beginRegistration(CLIENT);
    await accounts.saveValidated({
      issuer: ISSUER,
      subject: 'synthetic-reasoning',
      clientId: CLIENT,
      accessToken: 'synthetic-selection-access',
      refreshToken: 'synthetic-selection-refresh',
      idToken: 'synthetic-selection-id',
      scopes: [DIRECT_SCOPE],
      expiresAt: NOW + 120000,
    });
    await accounts.select(key);
    const before = await accounts.registration(key);
    const protocol = new OpenAIProtocol({
      now: () => now,
      fetchImpl: async () => {
        authCalls++;
        throw new TypeError('synthetic socket closure', {
          cause: Object.assign(Error('synthetic'), { code: 'ECONNRESET' }),
        });
      },
    });
    const sessions = new SessionManager({ accounts, protocol, now: () => now });
    const adapter = new Adapter({
      accounts,
      sessions,
      now: () => now,
      fetchImpl: async (url) => {
        if (url.endsWith('/responses')) responseCalls++;
        assert.ok(url.endsWith('/models'), 'selection fixture must never send inference');
        catalogCalls++;
        return Response.json({
          models: [
            {
              slug: 'fixture-reasoning',
              visibility: 'list',
              supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
              default_reasoning_level: 'high',
            },
          ],
        });
      },
    });
    const ctx = new Context();
    try {
      await ctx.plugin(registry.default);
      await ctx.plugin(native.default);
      await ctx.plugin(nativeSessions.default);
      await ctx.plugin(projections.default);
      ctx.provide('fileUploads', { registerAgentResolver: () => () => {} });
      ctx.provide('agentDefaultModel', { saveSelection: async () => {} });
      // Create the disposable Session before the API's list observers register.
      const session = ctx.sessions.create('synthetic-reasoning-session');
      const controller = new api.SessionController(ctx, {});
      const agent = {
        id: session.id,
        session,
        ctx,
        options: { provider: PROVIDER, model: 'fixture-reasoning' },
      };
      // Substitute only Agent ownership/persistence; the real public selection,
      // availability check, Llm normalization and adapter path remain untouched.
      controller.agents.resolveAgent = async () => ({ agent });
      controller.agents.serializeImageAdmission = async (_agent, work) => work();
      controller.agents.selectForNextRequest = (_agent, value) => {
        selected = value;
      };
      ctx.llm.registerAdapter([PROVIDER], adapter);
      const select = (reasoningEffort) =>
        controller.selectModel({
          sessionId: session.id,
          provider: PROVIDER,
          model: 'fixture-reasoning',
          reasoningEffort,
        });
      await select('high');
      assert.equal(selected.reasoningEffort, 'high');
      assert.equal(authCalls, 0);
      now += expired ? 121001 : 61000;
      if (expired) {
        await assert.rejects(select('low'), (error) => {
          assert.equal(error.code, 'session/model-unavailable');
          assert.match(error.message, /not automatically replayed/);
          return true;
        });
        assert.equal(selected.reasoningEffort, 'high');
        assert.equal(authCalls, 1);
      } else {
        assert.equal((await select('low')).selected.reasoningEffort, 'low');
        assert.equal(authCalls, 0, 'unexpired catalog access must not proactively rotate');
        assert.equal(catalogCalls, 2, 'the expired directory itself is still refreshed');
        await assert.rejects(select('invented'), (error) => {
          assert.equal(error.code, 'session/model-unavailable');
          assert.match(error.message, /does not support reasoning effort/);
          return true;
        });
        assert.equal(selected.reasoningEffort, 'low');
        const call = await ctx.llm.prepareCall({
          provider: PROVIDER,
          model: 'fixture-reasoning',
          reasoningEffort: 'low',
        });
        const output = [];
        for await (const chunk of call.stream({
          ...call.config,
          messages: [
            native.createUserMessage({
              source: { kind: 'user' },
              content: [{ type: 'text', text: 'synthetic only' }],
            }),
          ],
        }))
          output.push(chunk);
        assert.equal(output.at(-1).reason.failure.code, 'AUTH_REQUEST_UNCONFIRMED');
        assert.equal(authCalls, 1, 'actual Responses readiness retains proactive refresh');
      }
      assert.equal(responseCalls, 0);
      assert.deepEqual(
        await accounts.registration(key),
        before,
        'an ambiguous refresh never erases the grant',
      );
    } finally {
      adapter.dispose();
      await sessions.dispose();
      await ctx.fiber.dispose();
    }
  }
  return {
    nativeReasoningSelection: true,
    unexpiredCatalogDoesNotRotate: true,
    reasoningChangeAfterCatalogExpiry: true,
    unsupportedEffortStillDenied: true,
    inferenceKeepsRefreshMargin: true,
    expiredGrantStillRequiresRefresh: true,
    ambiguousRefreshSingleAttempt: true,
  };
}
