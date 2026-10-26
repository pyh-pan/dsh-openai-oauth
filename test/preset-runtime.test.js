import test from 'node:test';
import assert from 'node:assert/strict';
import { watchPresetIntegration } from '../src/siwc/preset-runtime.js';
import {
  retainedCompositionReader,
  assertSessionCoverage,
  unavailablePresetIntegration,
  COVERAGE,
  COVERAGE_TOKEN,
} from '../src/siwc/preset-integration.js';
const moduleName = 'file:///reviewed/compaction.js';
function fixture() {
  const parentEffects = [],
    childEffects = [];
  let activate;
  const agent = { ctx: {}, session: {} };
  const scope = {
    root: { fiber: {} },
    loader: { entries: () => [] },
    agents: { get: (id) => (id === 'live' ? agent : undefined) },
    sessionProjections: { stateOf: () => 'cordis' },
    agentPresets: {
      composedPreset: () => 'cordis',
      serviceFor: () => ({ [COVERAGE]: COVERAGE_TOKEN, assertConversationReady() {} }),
      inspectCompositions: () => [{ id: 'cordis', modules: [{ moduleName }], leakedServices: [] }],
    },
    on: () => () => {},
    effect: (start) => {
      childEffects.push(start());
    },
  };
  const ctx = {
    effect: (start) => {
      parentEffects.push(start());
    },
    inject(names, apply) {
      assert.deepEqual(names, ['loader', 'agentPresets', 'agents', 'sessionProjections']);
      activate = () => apply(scope);
    },
  };
  return {
    ctx,
    scope,
    activate: () => activate(),
    unload: () => {
      for (const off of childEffects.splice(0).reverse()) off();
    },
    dispose: () => {
      for (const off of parentEffects.splice(0).reverse()) off();
    },
  };
}

test('late session services enable coverage without making them hard provider dependencies', async () => {
  const f = fixture();
  const gate = watchPresetIntegration(f.ctx, moduleName, async () => ({
    NativePreset: class {},
    nativeRegistry: {},
  }));
  assert.doesNotThrow(() => gate.assertCoverage(undefined));
  assert.throws(() => gate.assertCoverage('live'), { code: 'DSH_SIWC_PRESET_CONTRACT_MISSING' });
  assert.equal((await gate.readCoverage()).status, 'unavailable');
  await f.activate();
  assert.doesNotThrow(() => gate.assertCoverage('live'));
  // Optional report inventory can be absent without disabling real admission.
  assert.equal((await gate.readCoverage()).status, 'unavailable');
  assert.doesNotThrow(() => gate.assertCoverage('live'));
  f.unload();
  assert.throws(() => gate.assertCoverage('live'), { code: 'DSH_SIWC_PRESET_CONTRACT_MISSING' });
  await f.activate();
  assert.doesNotThrow(() => gate.assertCoverage('live'));
  f.dispose();
  f.unload();
  assert.throws(() => gate.assertCoverage('live'), { code: 'PLUGIN_DISPOSED' });
});

test('missing or rejecting session capabilities give safe diagnostics and never approve a session', async () => {
  for (const mode of ['absent-inject', 'throwing-inject', 'import-failure', 'missing-method']) {
    const f = fixture();
    if (mode === 'absent-inject') delete f.ctx.inject;
    if (mode === 'throwing-inject')
      f.ctx.inject = () => {
        throw Error('private path');
      };
    if (mode === 'missing-method') delete f.scope.agentPresets.serviceFor;
    const gate = watchPresetIntegration(f.ctx, moduleName, async () => {
      if (mode === 'import-failure') throw Error('PRIVATE_NATIVE_IMPORT_PATH');
      return { NativePreset: class {}, nativeRegistry: {} };
    });
    if (['import-failure', 'missing-method'].includes(mode)) await f.activate();
    assert.throws(() => gate.assertCoverage('live', 'compaction'), {
      code: 'DSH_SIWC_PRESET_CONTRACT_MISSING',
    });
    const report = await gate.readCoverage();
    assert.equal(report.code, 'DSH_SIWC_PRESET_CONTRACT_MISSING');
    assert.ok(!JSON.stringify(report).includes('PRIVATE'));
    f.dispose();
    f.unload();
  }
});

test('disposal while native capability imports wait cannot install late session protection', async () => {
  const f = fixture();
  let release;
  const gate = watchPresetIntegration(
    f.ctx,
    moduleName,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const loading = f.activate();
  f.dispose();
  f.unload();
  release({ NativePreset: class {}, nativeRegistry: {} });
  await loading;
  assert.throws(() => gate.assertCoverage('live'), { code: 'PLUGIN_DISPOSED' });
});

test('unavailable coverage preserves fixed error codes without serializing native errors', async () => {
  for (const code of [
    'DSH_SIWC_PRESET_STARTUP_TIMEOUT',
    'DSH_SIWC_COMPACTION_CONTRACT_MISSING',
    'PLUGIN_DISPOSED',
  ]) {
    const gate = unavailablePresetIntegration({ code, message: 'private path' });
    assert.throws(() => gate.assertCoverage('live'), { code });
    assert.equal((await gate.readCoverage()).code, code);
  }
});

test('the historical public mount Interface addresses the exact retained revision and root', () => {
  const f = fixture();
  delete f.scope.agentPresets.inspectCompositions;
  const rows = [
    { options: { group: true }, fiber: { state: 2 } },
    { options: { name: moduleName }, fiber: { state: 2 } },
    { options: { name: '@deepseek-ai/dsh-compaction-basic' }, disabled: true, fiber: { state: 2 } },
  ];
  const mount = { presetId: 'cordis', fiber: {}, tree: { entries: () => rows } };
  const native = {
    standingMountFor: () => mount,
    livePresetMounts: (root) => {
      assert.equal(root, f.scope.root.fiber);
      return [mount];
    },
    leakedServices: (ctx, fiber) => {
      assert.equal(ctx, f.scope);
      assert.equal(fiber, mount.fiber);
      return [];
    },
  };
  const inspect = retainedCompositionReader(f.scope, native);
  assert.doesNotThrow(() => assertSessionCoverage(f.scope, 'live', moduleName, undefined, inspect));
  rows.push({ options: { name: '@deepseek-ai/dsh-compaction-basic' }, fiber: { state: 2 } });
  assert.throws(() => assertSessionCoverage(f.scope, 'live', moduleName, undefined, inspect), {
    code: 'SIWC_COMPACTION_NOT_COVERED',
  });
  rows.pop();
  native.livePresetMounts = () => []; // Build a fresh reader, as a fresh native module would.
  assert.throws(() => retainedCompositionReader(f.scope, native)({}), {
    code: 'DSH_SIWC_PRESET_CONTRACT_MISSING',
  });
  native.standingMountFor = () => undefined;
  assert.deepEqual(retainedCompositionReader(f.scope, native)({}), []);
  assert.throws(() => retainedCompositionReader(f.scope, {}), {
    code: 'DSH_SIWC_PRESET_CONTRACT_MISSING',
  });
});
