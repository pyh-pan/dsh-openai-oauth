import {
  installPresetIntegration,
  retainedCompositionReader,
  unavailablePresetIntegration,
} from './preset-integration.js';
import { readCoverageReport } from './coverage-report.js';

// Optional dependency lifecycle, not a second provider. Missing session services
// leave account management available while every session dispatch stays denied.
export function watchPresetIntegration(ctx, moduleName, loadNative) {
  let current = unavailablePresetIntegration();
  let active,
    closed = false;
  ctx.effect(
    () => () => {
      closed = true;
      active = undefined;
      current = unavailablePresetIntegration({ code: 'PLUGIN_DISPOSED' });
    },
    'siwc: preset capability lifetime',
  );
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['loader', 'agentPresets', 'agents', 'sessionProjections'], async (scope) => {
        const lease = {};
        active = lease;
        current = unavailablePresetIntegration();
        scope.effect(
          () => () => {
            if (active === lease) {
              active = undefined;
              current = unavailablePresetIntegration();
            }
          },
          'siwc: session capability',
        );
        try {
          const { NativePreset, nativeRegistry } = await loadNative();
          if (closed || active !== lease) return;
          const inspect = retainedCompositionReader(scope, nativeRegistry);
          const integration = await installPresetIntegration(
            scope,
            NativePreset,
            moduleName,
            inspect,
          );
          if (closed || active !== lease) return;
          current = {
            assertCoverage: integration.assertCoverage,
            readCoverage: () =>
              readCoverageReport(scope, moduleName, 2000, integration.assertCoverage),
          };
        } catch (error) {
          if (!closed && active === lease) current = unavailablePresetIntegration(error);
        }
      });
    } catch (error) {
      current = unavailablePresetIntegration(error);
    }
  }
  return {
    assertCoverage: (sessionId, purpose) => current.assertCoverage(sessionId, purpose),
    readCoverage: () => current.readCoverage(),
  };
}
