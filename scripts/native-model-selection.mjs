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
function assertSafeDiagnostic(message, tokenState) {
  const match = message.match(/\[SIWC-AUTH-DIAG first-failure\] (\{.*\}) \[\/SIWC-AUTH-DIAG\]/);
  assert.ok(match, 'native public error must retain the safe diagnostic');
  let value;
  try {
    value = JSON.parse(match[1]);
  } catch {
    assert.fail('native diagnostic must be valid JSON');
  }
  assert.equal(value.phase, 'refresh');
  assert.equal(value.tokenState, tokenState);
  assert.equal(value.stage, 'fetch_started');
  assert.equal(value.attempts, 1);
  assert.equal(value.timeout, false);
  assert.deepEqual(value.transportCodes, ['ECONNRESET']);
  assert.doesNotMatch(
    match[1],
    /synthetic-selection|fixture-reasoning|https?:|refresh_token|client_id/,
  );
}

export async function verifyNativeModelSelection(asar) {
  const req = createRequire(pathToFileURL(join(asar, 'dsh/package.json')));
  const load = (name) => import(pathToFileURL(req.resolve('@deepseek-ai/' + name)).href);
  const [{ Context, Service }, native, nativeSessions, projections, api, registry] =
    await Promise.all([
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
      diagnostics: true,
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
      // Newer native services initialize after construction. Honor the actual
      // lifecycle before replacing this fixture's Agent ownership/persistence.
      await controller[Service.init]?.();
      const agent = {
        id: session.id,
        session,
        ctx,
        options: { provider: PROVIDER, model: 'fixture-reasoning' },
        model: {
          select(value) {
            selected = value;
          },
        },
      };
      // Substitute only Agent ownership/persistence; the real public selection,
      // availability check, Llm normalization and adapter path remain untouched.
      controller.agents.resolveAgent = async () => ({ agent });
      controller.agents.serializeImageAdmission = async (_agent, work) => work();
      if (typeof controller.agents.selectForNextRequest === 'function')
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
      assert.equal((await select('low')).selected.reasoningEffort, 'low');
      assert.equal(authCalls, 0, 'local model/effort selection must not renew even expired access');
      assert.equal(catalogCalls, 1, 'retained selection metadata must not refetch after TTL');
      await assert.rejects(select('invented'), (error) => {
        assert.equal(error.code, 'session/model-unavailable');
        assert.match(error.message, /does not support reasoning effort/);
        return true;
      });
      assert.equal(selected.reasoningEffort, 'low');
      await assert.rejects(
        ctx.llm.prepareCall({
          provider: PROVIDER,
          model: 'fixture-reasoning',
          reasoningEffort: 'low',
        }),
        (error) => {
          assert.equal(error.code, 'AUTH_REQUEST_UNCONFIRMED');
          assertSafeDiagnostic(error.message, expired ? 'expired' : 'unexpired');
          return true;
        },
      );
      assert.equal(authCalls, 1, 'actual preparation keeps proactive/expired refresh requirements');
      await assert.rejects(
        ctx.llm.prepareCall({
          provider: PROVIDER,
          model: 'fixture-reasoning',
          reasoningEffort: 'low',
        }),
        { code: 'ACCOUNT_RENEWAL_UNCONFIRMED' },
      );
      assert.equal(
        authCalls,
        1,
        'a later native preparation cannot replay the uncertain generation',
      );
      assert.equal((await select('high')).selected.reasoningEffort, 'high');
      assert.equal(responseCalls, 0);
      const { renewal, ...retained } = await accounts.registration(key);
      assert.equal(renewal.state, 'uncertain');
      assert.deepEqual(
        retained,
        before,
        'an uncertain operation keeps credentials behind its durable fence',
      );
    } finally {
      adapter.dispose();
      await sessions.dispose();
      await ctx.fiber.dispose();
    }
  }
  return {
    nativeReasoningSelection: true,
    nativeAuthDiagnosticPreserved: true,
    unexpiredCatalogDoesNotRotate: true,
    expiredAccessDoesNotBlockRetainedSelection: true,
    retainedCatalogSelectionMakesNoRequest: true,
    reasoningChangeAfterCatalogExpiry: true,
    unsupportedEffortStillDenied: true,
    inferenceKeepsRefreshMargin: true,
    expiredGrantStillRequiresRefresh: true,
    ambiguousRefreshSingleAttempt: true,
  };
}
