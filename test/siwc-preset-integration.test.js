import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptPresetDefinition,
  assertSessionCoverage,
  installPresetIntegration,
  COVERAGE,
  COVERAGE_TOKEN,
  SUPPORTED_PRESETS,
  NATIVE_COMPACTION,
  COMPAT_COMPACTION,
} from '../src/siwc/preset-integration.js';
const moduleName = 'file:///reviewed/compaction.js';
const definition = (id = 'cordis') => ({
  id,
  name: 'Keep name',
  description: 'Keep description',
  plugins: [
    { name: 'unrelated-plugin', config: { enabled: true } },
    {
      name: 'cordis:group',
      isolate: { compaction: true },
      config: [
        {
          name: NATIVE_COMPACTION,
          config: { auto: true, headroomTokens: 1234, retainTokens: 789 },
        },
        { name: '@deepseek-ai/dsh-command-compact' },
        { name: '@deepseek-ai/dsh-compaction-tool-result-pruner', config: { keep: 'original' } },
      ],
    },
  ],
});

test('one package adapts all supported presets without mutating or persisting their declarations', () => {
  for (const id of SUPPORTED_PRESETS) {
    const raw = definition(id),
      original = structuredClone(raw);
    const result = adaptPresetDefinition(raw, moduleName);
    assert.equal(result.supported, true);
    const owner = result.config.plugins[1].config[0];
    assert.equal(owner.name, moduleName);
    assert.deepEqual(owner.config.basic, original.plugins[1].config[0].config);
    assert.equal(owner.config.summaryTimeoutMs, 300000);
    assert.equal(owner.config.maxSummaryBytes, 262144);
    assert.deepEqual(result.config.plugins[0], original.plugins[0]);
    assert.deepEqual(result.config.plugins[1].config.slice(1), original.plugins[1].config.slice(1));
    assert.deepEqual(raw, original);
  }
});
test('former local compat bundle and repeated config resolution do not double-wrap basic config', () => {
  const raw = definition();
  const owner = raw.plugins[1].config[0];
  const basic = owner.config;
  owner.name = COMPAT_COMPACTION;
  owner.config = { basic, summaryTimeoutMs: 2000, maxSummaryBytes: 4096 };
  const once = adaptPresetDefinition(raw, moduleName);
  const twice = adaptPresetDefinition(once.config, moduleName);
  assert.deepEqual(twice, once);
  assert.deepEqual(once.config.plugins[1].config[0].config, owner.config);
});
test('unknown/custom/dynamic/duplicate owners are never silently rewritten', () => {
  const fixtures = [definition('custom')];
  const dynamic = definition();
  dynamic.plugins[1].config = { __jsExpr: 'mustNotEvaluate()' };
  fixtures.push(dynamic);
  const duplicate = definition();
  duplicate.plugins[1].config.push({ name: NATIVE_COMPACTION });
  fixtures.push(duplicate);
  const unknown = definition();
  unknown.plugins[1].config.push({ name: 'custom-transform' });
  fixtures.push(unknown);
  const disabled = definition();
  disabled.plugins[1].disabled = true;
  fixtures.push(disabled);
  const root = definition();
  root.plugins.push({ name: NATIVE_COMPACTION });
  fixtures.push(root);
  for (const raw of fixtures) {
    const saved = structuredClone(raw);
    assert.deepEqual(adaptPresetDefinition(raw, moduleName), { supported: false });
    assert.deepEqual(raw, saved);
  }
});
function coverageFixture() {
  const agent = { ctx: {}, session: { header: { agentPreset: 'standard' } } };
  const ctx = {
    agents: { get: (id) => (id === 'live' ? agent : undefined) },
    sessionProjections: { stateOf: () => 'cordis' },
    agentPresets: {
      composedPreset: () => 'cordis',
      serviceFor: () => ({ [COVERAGE]: COVERAGE_TOKEN, assertConversationReady() {} }),
      inspectCompositions: () => [{ id: 'cordis', modules: [{ moduleName }], leakedServices: [] }],
    },
  };
  return ctx;
}
test('coverage uses selected cordis + exact live revision, never the frozen standard header', () => {
  const ctx = coverageFixture();
  assert.doesNotThrow(() => assertSessionCoverage(ctx, 'live', moduleName));
  ctx.sessionProjections.stateOf = () => 'standard';
  assert.throws(() => assertSessionCoverage(ctx, 'live', moduleName), {
    code: 'SIWC_PRESET_REVISION_MISMATCH',
  });
});
test('a same-path old module generation cannot impersonate the current compatible engine', () => {
  const ctx = coverageFixture();
  for (const marker of [true, Object.freeze({})]) {
    ctx.agentPresets.serviceFor = () => ({ [COVERAGE]: marker, assertConversationReady() {} });
    assert.throws(() => assertSessionCoverage(ctx, 'live', moduleName), {
      code: 'SIWC_COMPACTION_NOT_COVERED',
    });
  }
});

test('failed compaction blocks prepared conversation calls but admits explicit recovery summaries', () => {
  const ctx = coverageFixture();
  ctx.agentPresets.serviceFor = () => ({
    [COVERAGE]: COVERAGE_TOKEN,
    assertConversationReady() {
      throw Object.assign(Error('fixed'), { code: 'SIWC_COMPACTION_REQUIRED' });
    },
  });
  assert.throws(() => assertSessionCoverage(ctx, 'live', moduleName), {
    code: 'SIWC_COMPACTION_REQUIRED',
  });
  assert.doesNotThrow(() => assertSessionCoverage(ctx, 'live', moduleName, 'compaction'));
  ctx.agents.get = () => {
    throw Error('PRIVATE_DIAGNOSTIC_MUST_NOT_ESCAPE');
  };
  assert.throws(() => assertSessionCoverage(ctx, 'live', moduleName), {
    code: 'DSH_SIWC_PRESET_CONTRACT_MISSING',
    message: 'DSH_SIWC_PRESET_CONTRACT_MISSING',
  });
});

for (const kind of ['deadline', 'disposal'])
  test(`preset reconciliation ${kind} is bounded without late updates`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const ctx = coverageFixture();
    let dispose,
      removed = false,
      updated = false;
    ctx.loader = {
      entries: () => [
        {
          options: { name: '@deepseek-ai/dsh-agent-preset' },
          fiber: {
            await: () => new Promise(() => {}),
            update: () => {
              updated = true;
            },
          },
        },
      ],
    };
    ctx.on = () => () => {
      removed = true;
    };
    ctx.effect = (start) => {
      dispose = start();
    };
    const applying = installPresetIntegration(ctx, class NativePreset {}, moduleName);
    const checked = assert.rejects(applying, {
      code: kind === 'deadline' ? 'DSH_SIWC_PRESET_STARTUP_TIMEOUT' : 'PLUGIN_DISPOSED',
    });
    if (kind === 'deadline') t.mock.timers.tick(30000);
    else dispose();
    await checked;
    assert.equal(removed, true);
    assert.equal(updated, false);
  });

test('unknown sessions and retained native/duplicate/leaked revisions fail closed', () => {
  const ctx = coverageFixture();
  assert.doesNotThrow(() => assertSessionCoverage(ctx, undefined, moduleName));
  assert.throws(() => assertSessionCoverage(ctx, 'missing', moduleName), {
    code: 'SIWC_SESSION_COVERAGE_UNAVAILABLE',
  });
  ctx.agentPresets.serviceFor = () => ({});
  assert.throws(() => assertSessionCoverage(ctx, 'live', moduleName), {
    code: 'SIWC_COMPACTION_NOT_COVERED',
  });
  for (const entry of [
    {
      id: 'cordis',
      modules: [{ moduleName }, { moduleName: NATIVE_COMPACTION }],
      leakedServices: [],
    },
    { id: 'cordis', modules: [{ moduleName }, { moduleName }], leakedServices: [] },
    { id: 'cordis', modules: [{ moduleName }], leakedServices: ['compaction'] },
  ]) {
    ctx.agentPresets.serviceFor = () => ({ [COVERAGE]: COVERAGE_TOKEN });
    ctx.agentPresets.inspectCompositions = () => [entry];
    assert.throws(() => assertSessionCoverage(ctx, 'live', moduleName), {
      code: 'SIWC_COMPACTION_NOT_COVERED',
    });
  }
});
