// Installed public Loader/Fiber/config hooks + actual retained preset realms.
// Disposable Sessions and mock transport only. No profile or credential access.
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createAdapterClass } from '../src/siwc/adapter.js';
import {
  installPresetIntegration,
  COVERAGE,
  COVERAGE_TOKEN,
  SUPPORTED_PRESETS,
} from '../src/siwc/preset-integration.js';
const asar = process.env.DSH_ASAR;
if (!asar) throw Error('Set DSH_ASAR');
const req = createRequire(pathToFileURL(asar + '/dsh/package.json'));
const peers = new Map(
  [
    '@deepseek-ai/dsh-compaction-basic',
    '@deepseek-ai/dsh-compaction-basic/package.json',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/schemastery',
    'zod',
  ].map((n) => [n, pathToFileURL(req.resolve(n)).href]),
);
peers.set(
  '@pyh-pan/dsh-openai-oauth/compaction',
  new URL('../src/compaction.js', import.meta.url).href,
);
const hook = registerHooks({
  resolve(s, c, next) {
    return !c.conditions.includes('require') && peers.has(s)
      ? { url: peers.get(s), shortCircuit: true }
      : next(s, c);
  },
});
const load = (n) => import(pathToFileURL(req.resolve(n)).href);
const [
  { Context },
  { default: Loader, Group },
  { default: Registry },
  { default: Preset },
  native,
  sessions,
  projections,
  meter,
  scopeModule,
] = await Promise.all([
  load('@deepseek-ai/cordis'),
  load('@deepseek-ai/cordis-plugin-loader'),
  load('@deepseek-ai/dsh-agent-preset-registry'),
  load('@deepseek-ai/dsh-agent-preset'),
  load('@deepseek-ai/dsh-llm'),
  load('@deepseek-ai/dsh-session'),
  load('@deepseek-ai/dsh-session-projection'),
  load('@deepseek-ai/dsh-token-meter'),
  load('@deepseek-ai/dsh-scope'),
]);
const moduleName = new URL('../src/compaction.js', import.meta.url).href;
const ctx = new Context(),
  agents = new Map(),
  scopes = [];
const timeout = setTimeout(() => {
  console.error('NATIVE_PRESET_INTEGRATION_TIMEOUT');
  process.exit(1);
}, 30000);
let integration,
  mode = 'success';
const calls = [];
const Adapter = createAdapterClass(native);
const adapter = new Adapter({
  accounts: { selection: async () => ({ key: 'synthetic', generation: 1 }) },
  sessions: { access: async () => ({ accessToken: 'mock-preset-only' }) },
  assertCoverage: (id, purpose) => integration?.assertCoverage(id, purpose),
  fetchImpl: async (url, opts) => {
    if (url.endsWith('/models'))
      return Response.json({
        models: [{ slug: 'fixture', visibility: 'list', context_window: 20000 }],
      });
    const body = JSON.parse(opts.body);
    calls.push(body);
    const text = mode === 'success' ? 'A small synthetic durable checkpoint.' : '';
    const event = {
      type: 'response.completed',
      response: {
        id: 'mock',
        status: 'completed',
        output: [
          {
            type: 'message',
            id: 'mock-message',
            role: 'assistant',
            content: [{ type: 'output_text', text, annotations: [] }],
          },
        ],
        usage: { input_tokens: 1000, output_tokens: 20 },
      },
    };
    return new Response(`data: ${JSON.stringify(event)}\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  },
});
const definitions = new Map();
const definition = (id) => ({
  id,
  name: 'Original ' + id,
  plugins: [
    {
      name: 'cordis:group',
      isolate: { compaction: true },
      config: [
        {
          name: '@deepseek-ai/dsh-compaction-basic',
          config: {
            auto: true,
            thresholdRatio: 0.3,
            maxTokens: 1024,
            headroomTokens: 1024,
            retainTokens: 1000,
          },
        },
      ],
    },
  ],
});
async function bind(id, session) {
  const scope = scopeModule.createScope(ctx, {});
  scopes.push(scope);
  await ctx.agentPresets.mount(scope.ctx, id);
  const agent = {
    id: session.id,
    ctx: scope.ctx,
    session,
    options: { provider: 'chatgpt-subscription', model: 'fixture' },
  };
  agents.set(session.id, agent);
  return agent;
}
function fixture(id, preset) {
  const s = ctx.sessions.create(id, { meta: { agentPreset: 'standard' } });
  s.append('agent-preset/selected', { agentPreset: preset });
  s.append('turn/start', { turn: 1 });
  s.append('request/header', {
    reason: 'initial',
    header: { config: { provider: 'chatgpt-subscription', model: 'fixture' } },
  });
  s.append('request/context', {
    provider: 'chatgpt-subscription',
    model: 'fixture',
    contextWindow: 20000,
  });
  s.append('step/start', { turn: 1, step: 1 });
  const start = s.append(
    'user/message',
    native.createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Synthetic old context '.repeat(2000) }],
    }),
    { surfaceOp: 'append' },
  ).seq;
  s.append(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      message: {
        id: id + '-answer',
        role: 'assistant',
        source: { kind: 'model', provider: 'chatgpt-subscription', model: 'fixture' },
        content: [{ type: 'text', text: 'Synthetic answer '.repeat(500) }],
      },
      stream: [],
    },
    { surfaceOp: 'append' },
  );
  s.append('step/end', { turn: 1, step: 1 });
  const end = s.surface.nodes.at(-1);
  s.append(
    'user/message',
    native.createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Keep this recent tail.' }],
    }),
    { surfaceOp: 'append' },
  );
  return { s, start, end };
}
try {
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(asar + '/dsh/package.json').href });
  ctx.loader.builtins.group = Group;
  await ctx.plugin(native.default);
  await ctx.plugin(sessions.default);
  await ctx.plugin(projections.default);
  await ctx.plugin(meter.default);
  ctx.provide('agents', { get: (id) => agents.get(id) });
  await ctx.plugin(Registry, { default: 'standard' });
  ctx.llm.registerAdapter(['chatgpt-subscription'], adapter);
  const otherCaps = [];
  class OtherAdapter extends native.LlmAdapter {
    providerInfo(id) {
      return { id, name: 'Synthetic other provider' };
    }
    async *stream(options) {
      otherCaps.push(options.maxTokens);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'Other provider native summary.' };
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: 'Other provider native summary.' },
      };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['synthetic-other'], new OtherAdapter());
  for (const id of SUPPORTED_PRESETS) {
    const raw = definition(id);
    if (id === 'standard') {
      const owner = raw.plugins[0].config[0];
      owner.name = '@pyh-pan/dsh-openai-oauth/compaction';
      owner.config = { basic: owner.config, summaryTimeoutMs: 300000, maxSummaryBytes: 262144 };
    }
    definitions.set(id, structuredClone(raw));
    await ctx.loader.create({
      id: 'preset-' + id,
      name: '@deepseek-ai/dsh-agent-preset',
      config: raw,
    });
  }
  await ctx.loader.await();
  const before = fixture('header-standard-selected-cordis', 'cordis');
  const oldAgent = await bind('cordis', before.s);
  assert.equal(before.s.header.agentPreset, 'standard');
  const owner = await ctx.plugin({
    name: 'synthetic-unified-provider',
    inject: ['loader', 'agentPresets', 'agents', 'sessionProjections'],
    async apply(c) {
      integration = await installPresetIntegration(c, Preset, moduleName);
    },
  });
  assert.throws(() => integration.assertCoverage(oldAgent.id), {
    code: 'SIWC_COMPACTION_NOT_COVERED',
  });
  const roster = await ctx.agentPresets.list();
  assert.ok(
    roster.every((r) => !r.broken),
    JSON.stringify(roster),
  );
  let reduced = 0;
  for (const id of SUPPORTED_PRESETS) {
    const f = fixture('unified-' + id, id),
      agent = await bind(id, f.s);
    integration.assertCoverage(agent.id);
    const engine = ctx.agentPresets.serviceFor(agent, 'compaction');
    assert.equal(engine[COVERAGE], COVERAGE_TOKEN);
    const sizeBefore = ctx.tokenMeter.measure(f.s).totalTokens;
    f.s.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    await engine.compactNow(
      { ...agent, runMaintenance: (task) => task(new AbortController().signal) },
      new AbortController().signal,
    );
    assert.ok(ctx.tokenMeter.measure(f.s).totalTokens < sizeBefore);
    reduced++;
    assert.equal(f.s.snapshotEvents().filter((e) => e.type === 'compaction/summary').length, 1);
    assert.equal(
      f.s.snapshotEvents().find((e) => e.type === 'compaction/summary').data.maxTokens,
      undefined,
    );
    assert.equal(f.s.deriveMessages().at(-1).content[0].text, 'Keep this recent tail.');
    const childScope = scopeModule.createScope(ctx, {});
    scopes.push(childScope);
    const childSession = fixture('child-' + id, id).s;
    assert.equal(ctx.agentPresets.composeFrom(childScope.ctx, agent.ctx), id);
    const child = {
      id: childSession.id,
      ctx: childScope.ctx,
      session: childSession,
      options: agent.options,
    };
    agents.set(child.id, child);
    integration.assertCoverage(child.id);
    assert.equal(ctx.agentPresets.serviceFor(child, 'compaction')[COVERAGE], COVERAGE_TOKEN);
    assert.deepEqual(
      ctx.agentPresets.inspectCompositions(child.ctx),
      ctx.agentPresets.inspectCompositions(agent.ctx),
    );
    const auto = fixture('automatic-' + id, id),
      autoAgent = await bind(id, auto.s);
    const admitted = await autoAgent.ctx.waterfall(
      'agent/pre-step',
      { agent: autoAgent, messages: [], turn: 1, step: 2, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    );
    assert.equal(admitted.kind, 'enter');
    assert.ok(auto.s.snapshotEvents().some((e) => e.type === 'compaction/summary'));
    f.s.append('request/header', {
      reason: 'synthetic-other-route',
      header: { config: { provider: 'synthetic-other', model: 'fixture' } },
    });
    const other = await engine.summarize(
      { messages: f.s.deriveMessages() },
      agent,
      new AbortController().signal,
    );
    assert.equal(other.provider, 'synthetic-other');
    assert.equal(other.maxTokens, 1024);
    assert.equal(otherCaps.at(-1), 1024);
    mode = 'empty';
    const bad = fixture('blocked-' + id, id),
      badAgent = await bind(id, bad.s);
    await assert.rejects(
      engine.compactRegion(bad.start, bad.end, badAgent, new AbortController().signal),
    );
    const decision = await badAgent.ctx.waterfall(
      'agent/pre-step',
      { agent: badAgent, messages: [], turn: 1, step: 2, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    );
    assert.equal(decision.kind, 'reject');
    assert.throws(() => integration.assertCoverage(badAgent.id), {
      code: 'SIWC_COMPACTION_REQUIRED',
    });
    integration.assertCoverage(badAgent.id, 'compaction');
    mode = 'success';
    bad.s.append('turn/end', { turn: 1, reason: { kind: 'blocked' } });
    await engine.compactNow(
      { ...badAgent, runMaintenance: (task) => task(new AbortController().signal) },
      new AbortController().signal,
    );
    integration.assertCoverage(badAgent.id);
  }
  // Resume exact selected-preset state into the current revision, not its header.
  const restored = sessions.Session.fromRestore(
    before.s.id,
    before.s.snapshotEvents(),
    before.s.header,
    0,
  );
  const resumed = await bind('cordis', restored);
  integration.assertCoverage(resumed.id);
  for (const e of ctx.loader.entries())
    if (e.options.name === '@deepseek-ai/dsh-agent-preset')
      assert.deepEqual(e.options.config, definitions.get(e.options.config.id));
  assert.ok(calls.every((b) => !Object.hasOwn(b, 'max_output_tokens')));
  // Adapter prepared-call admission cannot accidentally bypass the guard.
  const count = calls.length;
  const prepared = await adapter.prepareCall('chatgpt-subscription', 'fixture');
  const out = [];
  for await (const chunk of prepared.stream({
    provider: 'chatgpt-subscription',
    model: 'fixture',
    sessionId: 'missing',
    get messages() {
      throw Error('HISTORY_MUST_NOT_BE_READ');
    },
  }))
    out.push(chunk);
  assert.equal(out.at(-1).reason.failure.code, 'SIWC_SESSION_COVERAGE_UNAVAILABLE');
  assert.equal(calls.length, count);
  const customConfig = definition('custom');
  await ctx.loader.create({
    id: 'preset-custom',
    name: '@deepseek-ai/dsh-agent-preset',
    config: customConfig,
  });
  await ctx.loader.await();
  const custom = fixture('uncovered-custom', 'custom'),
    customAgent = await bind('custom', custom.s);
  const rejected = [];
  for await (const chunk of prepared.stream({
    provider: 'chatgpt-subscription',
    model: 'fixture',
    sessionId: customAgent.id,
    get messages() {
      throw Error('HISTORY_MUST_NOT_BE_READ');
    },
  }))
    rejected.push(chunk);
  assert.equal(rejected.at(-1).reason.failure.code, 'SIWC_COMPACTION_NOT_COVERED');
  assert.equal(calls.length, count);
  // Simulate native recomposition after removal of the old standard-only
  // bundle: raw declaration returns to basic, integration stays single-owner.
  const currentStandard = definition('standard');
  definitions.set('standard', structuredClone(currentStandard));
  await ctx.loader.update('preset-standard', { config: currentStandard });
  await ctx.loader.await();
  const migrated = fixture('migrated-standard', 'standard'),
    migratedAgent = await bind('standard', migrated.s);
  integration.assertCoverage(migratedAgent.id);
  assert.equal(
    ctx.agentPresets
      .inspectCompositions(migratedAgent.ctx)[0]
      .modules.filter((m) => m.moduleName === moduleName).length,
    1,
  );
  // A future/recreated declaration must also be transformed, not only startup rows.
  ctx.loader.remove('preset-minimal');
  await ctx.loader.await();
  await ctx.loader.create({
    id: 'preset-minimal',
    name: '@deepseek-ai/dsh-agent-preset',
    config: structuredClone(definitions.get('minimal')),
  });
  await ctx.loader.await();
  const late = fixture('late-minimal', 'minimal'),
    lateAgent = await bind('minimal', late.s);
  integration.assertCoverage(lateAgent.id);
  // Removing integration restores raw declarations only for future bindings.
  await owner.dispose();
  await ctx.loader.await();
  console.log(
    JSON.stringify({
      nativeUnifiedPresetIntegration: 'passed',
      presets: SUPPORTED_PRESETS,
      checkpointAndShrinkCount: reduced,
      explicitCompactNowAllPresets: true,
      automaticCompactionAllPresets: true,
      childRetainsCoveredRealm: true,
      futureDeclarationsCovered: true,
      legacyBundleConfigAdopted: true,
      legacyBundleRemovalRecomposition: true,
      failedSummariesBlockAllPresets: true,
      otherProvidersKeepNativeCap: otherCaps.length === 4,
      headerStandardSelectedCordis: true,
      resumeUsesSelectedPreset: true,
      oldRevisionRejected: true,
      rawDeclarationsUnchanged: true,
      preparedCallGuard: true,
      unknownPresetBlockedBeforeHistoryOrTransport: true,
      serverCalls: 0,
      mockResponses: calls.length,
      credentialsAccessed: false,
    }),
  );
} finally {
  for (const s of scopes.reverse()) await s.dispose();
  await ctx.fiber.dispose();
  clearTimeout(timeout);
  hook.deregister();
}
