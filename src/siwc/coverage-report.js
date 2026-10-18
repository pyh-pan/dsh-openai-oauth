import {
  SUPPORTED_PRESETS,
  NATIVE_COMPACTION,
  COMPAT_COMPACTION,
  assertSessionCoverage,
} from './preset-integration.js';
const unavailable = () => ({
  status: 'unavailable',
  presets: [],
  sessions: { checked: 0, covered: 0, blocked: 0, uncovered: 0 },
});
// Owner-only settings diagnostics. Never serialize an Agent, module path,
// condition, config, session id, account id, messages or arbitrary error.
// Read outside plugin activation: native inventory may await Host settlement.
export async function readCoverageReport(ctx, moduleName, timeoutMs = 2000) {
  let timer;
  const started = performance.now();
  try {
    const read = (async () => {
      const inventory = await ctx.agentPresets.compositionInventory();
      const presets = SUPPORTED_PRESETS.map((id) => {
        const p = inventory.find((p) => p.id === id);
        if (!p) return { id, status: 'absent' };
        if (p.broken) return { id, status: 'broken' };
        const active = p.rows.filter((r) => r.enabled === true && r.fiberState === 2);
        const compatible = active.filter(
          (r) => r.moduleName === moduleName || r.moduleName === COMPAT_COMPACTION,
        ).length;
        const native = active.some((r) => r.moduleName === NATIVE_COMPACTION);
        return { id, status: compatible === 1 && !native ? 'ready' : 'uncovered' };
      });
      const sessions = { checked: 0, covered: 0, blocked: 0, uncovered: 0 };
      for (const agent of ctx.agents.list()) {
        if (performance.now() - started >= timeoutMs) return unavailable();
        const route = agent.session.requestHeader()?.config ?? agent.options;
        if (route?.provider !== 'chatgpt-subscription') continue;
        sessions.checked++;
        try {
          assertSessionCoverage(ctx, agent.id, moduleName, 'compaction');
          sessions.covered++;
          try {
            assertSessionCoverage(ctx, agent.id, moduleName);
          } catch (error) {
            if (error?.code === 'SIWC_COMPACTION_REQUIRED') sessions.blocked++;
            else {
              sessions.covered--;
              sessions.uncovered++;
            }
          }
        } catch {
          sessions.uncovered++;
        }
      }
      const attention =
        presets.some((p) => p.status !== 'ready') || sessions.uncovered > 0 || sessions.blocked > 0;
      return {
        status: attention ? 'attention' : sessions.checked ? 'ready' : 'pending',
        presets,
        sessions,
      };
    })();
    return await Promise.race([
      read,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(unavailable()), timeoutMs);
      }),
    ]);
  } catch {
    return unavailable();
  } finally {
    clearTimeout(timer);
  }
}
