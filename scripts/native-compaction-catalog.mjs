// Real native pressure algorithm with a cold, selection-only catalog seam.
// All Sessions/model facts are synthetic; no credentials, network or inference.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const P = 'chatgpt-subscription',
  model = 'synthetic-cold-catalog';
export async function verifyColdCompactionCatalog(asar, Engine) {
  const req = createRequire(pathToFileURL(join(asar, 'dsh/package.json')));
  const load = (name) => import(pathToFileURL(req.resolve('@deepseek-ai/' + name)).href);
  const [{ Context }, native, sessions, projections, meter] = await Promise.all(
    ['cordis', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-token-meter'].map(load),
  );
  for (const mode of [
    'ready',
    'auth-fail',
    'missing-context',
    'summary-other-fail',
    'foreign',
    'unrouted',
    'cancel',
  ]) {
    const ctx = new Context();
    let prepared = 0,
      streams = 0,
      live = mode === 'foreign';
    const info = (provider) => ({
      provider,
      id: model,
      name: 'Synthetic cold metadata',
      ...(live ? { context: { contextWindow: 20000 } } : {}),
    });
    class ColdAdapter extends native.LlmAdapter {
      providerInfo(provider) {
        return { id: provider, name: provider };
      }
      async listModels(provider) {
        return [info(provider)];
      }
      async resolveModel(provider) {
        return info(provider);
      }
      async prepareCall(provider) {
        prepared++;
        if (['auth-fail', 'summary-other-fail'].includes(mode))
          throw new native.LlmError('synthetic auth unavailable', 'AUTH_NETWORK_TIMEOUT');
        if (mode === 'cancel') await new Promise(() => {});
        live = mode !== 'missing-context';
        return {
          model: info(provider),
          stream: async function* () {
            streams++;
            assert.fail('pressure capability preparation must not infer');
          },
        };
      }
    }
    try {
      await ctx.plugin(native.default);
      await ctx.plugin(sessions.default);
      await ctx.plugin(projections.default);
      await ctx.plugin(meter.default);
      ctx.llm.registerAdapter([P, 'other'], new ColdAdapter());
      await ctx.plugin(Engine, {
        basic: {
          auto: false,
          headroomTokens: 1024,
          retainTokens: 1000,
          ...(mode === 'summary-other-fail'
            ? { summarizationProvider: 'other', summarizationModel: model }
            : {}),
        },
      });
      const session = ctx.sessions.create('synthetic-cold-' + mode);
      session.append('turn/start', { turn: 1 });
      if (mode !== 'unrouted')
        session.append('request/header', {
          reason: 'initial',
          header: { config: { provider: mode === 'foreign' ? 'other' : P, model } },
        });
      session.append(
        'user/message',
        native.createUserMessage({
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'Synthetic short retained history.' }],
        }),
        { surfaceOp: 'append' },
      );
      const agent = { session, options: { provider: P, model } },
        before = session.snapshotEvents();
      const abort = new AbortController(),
        pending = ctx.compaction.compactIfNeeded(agent, 'pressure', abort.signal);
      if (mode === 'cancel') {
        abort.abort(Error('synthetic cancel'));
        await assert.rejects(pending);
      } else if (['auth-fail', 'missing-context', 'summary-other-fail'].includes(mode)) {
        await assert.rejects(pending);
        assert.throws(() => ctx.compaction.assertConversationReady(session), {
          code: 'SIWC_COMPACTION_REQUIRED',
        });
        const decision = await ctx.waterfall(
          'agent/pre-step',
          { agent, messages: [], turn: 1, step: 1, signal: abort.signal },
          async () => ({ kind: 'enter', messages: [] }),
        );
        assert.equal(decision.kind, 'reject');
      } else {
        assert.equal(await pending, null);
        assert.doesNotThrow(() => ctx.compaction.assertConversationReady(session));
        assert.equal(prepared, ['foreign', 'unrouted'].includes(mode) ? 0 : 1);
      }
      assert.equal(streams, 0);
      assert.deepEqual(
        session.snapshotEvents(),
        before,
        'capability preparation cannot rewrite history or emit a request header',
      );
    } finally {
      await ctx.fiber.dispose();
    }
  }
  return {
    coldRetainedPressurePreparesLiveCatalog: true,
    coldMetadataNeverSuppliesContext: true,
    capabilityFailureStillRejects: true,
    conversationRouteControlsPressureWarmup: true,
    warmupNeverDispatchesOrRewritesHistory: true,
  };
}
