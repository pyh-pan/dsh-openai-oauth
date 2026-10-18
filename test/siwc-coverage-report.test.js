import test from 'node:test';
import assert from 'node:assert/strict';
import { readCoverageReport } from '../src/siwc/coverage-report.js';
import { COVERAGE, COVERAGE_TOKEN, SUPPORTED_PRESETS } from '../src/siwc/preset-integration.js';
const moduleName = 'file:///reviewed/current/compaction.js';
function fixture() {
  const agent = {
    id: 'session-private',
    session: {
      header: { agentPreset: 'standard' },
      requestHeader: () => ({ config: { provider: 'chatgpt-subscription' } }),
    },
    ctx: {},
  };
  const ctx = {
    agents: { get: (id) => (id === agent.id ? agent : undefined), list: () => [agent] },
    sessionProjections: { stateOf: () => 'cordis' },
    agentPresets: {
      composedPreset: () => 'cordis',
      inspectCompositions: () => [{ id: 'cordis', modules: [{ moduleName }], leakedServices: [] }],
      serviceFor: () => ({ [COVERAGE]: COVERAGE_TOKEN, assertConversationReady() {} }),
      compositionInventory: async () =>
        SUPPORTED_PRESETS.map((id) => ({
          id,
          name: 'private-display',
          rows: [{ moduleName, enabled: true, fiberState: 2, condition: 'private-expression' }],
        })),
    },
  };
  return { ctx, agent };
}
test('owner diagnostics report actual selected-session coverage without paths, ids or conditions', async () => {
  const { ctx } = fixture();
  const report = await readCoverageReport(ctx, moduleName);
  assert.equal(report.status, 'ready');
  assert.deepEqual(report.sessions, { checked: 1, covered: 1, blocked: 0, uncovered: 0 });
  assert.ok(report.presets.every((p) => p.status === 'ready'));
  for (const privateValue of [
    'session-private',
    'private-display',
    'private-expression',
    'file:',
    'condition',
    'moduleName',
  ])
    assert.ok(!JSON.stringify(report).includes(privateValue));
});
test('no live SIWC session is pending, not a false claim of real-session validation', async () => {
  const { ctx } = fixture();
  ctx.agents.list = () => [];
  const report = await readCoverageReport(ctx, moduleName);
  assert.equal(report.status, 'pending');
  assert.equal(report.sessions.checked, 0);
});
test('covered-but-blocked and uncovered revisions are distinguished', async () => {
  const { ctx } = fixture();
  ctx.agentPresets.serviceFor = () => ({
    [COVERAGE]: COVERAGE_TOKEN,
    assertConversationReady() {
      throw Object.assign(Error('fixed'), { code: 'SIWC_COMPACTION_REQUIRED' });
    },
  });
  const blocked = await readCoverageReport(ctx, moduleName);
  assert.equal(blocked.status, 'attention');
  assert.deepEqual(blocked.sessions, { checked: 1, covered: 1, blocked: 1, uncovered: 0 });
  ctx.agentPresets.serviceFor = () => ({});
  const uncovered = await readCoverageReport(ctx, moduleName);
  assert.equal(uncovered.status, 'attention');
  assert.deepEqual(uncovered.sessions, { checked: 1, covered: 0, blocked: 0, uncovered: 1 });
});
test('broken or uncovered declarations cannot produce a ready report', async () => {
  const { ctx } = fixture();
  ctx.agentPresets.compositionInventory = async () => [
    { id: 'standard', broken: 'PRIVATE_ERROR' },
    { id: 'cordis', rows: [] },
  ];
  const report = await readCoverageReport(ctx, moduleName);
  assert.equal(report.status, 'attention');
  assert.equal(report.presets[0].status, 'broken');
  assert.equal(report.presets[1].status, 'uncovered');
  assert.equal(report.presets[2].status, 'absent');
  assert.ok(!JSON.stringify(report).includes('PRIVATE_ERROR'));
});
test('inspection failure is a fixed unavailable result, not a leaked exception', async () => {
  const { ctx } = fixture();
  ctx.agentPresets.compositionInventory = async () => {
    throw Error('PRIVATE_ERROR');
  };
  const report = await readCoverageReport(ctx, moduleName);
  assert.equal(report.status, 'unavailable');
  assert.ok(!JSON.stringify(report).includes('PRIVATE_ERROR'));
});
test('settings inspection is bounded even when native settlement stalls', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ctx } = fixture();
  ctx.agentPresets.compositionInventory = () => new Promise(() => {});
  const pending = readCoverageReport(ctx, moduleName);
  t.mock.timers.tick(2000);
  assert.equal((await pending).status, 'unavailable');
});
