import { SiwcError } from './protocol.js';

export const NATIVE_PRESET = '@deepseek-ai/dsh-agent-preset';
export const NATIVE_COMPACTION = '@deepseek-ai/dsh-compaction-basic';
export const COMPAT_COMPACTION = '@pyh-pan/dsh-openai-oauth/compaction';
export const COVERAGE = Symbol.for('@pyh-pan/dsh-openai-oauth/compaction-coverage-v1');
// Module-generation identity: even a same-path HMR must not approve an old
// engine merely because its public module name or boolean marker matches.
export const COVERAGE_TOKEN = Object.freeze({});
export const SUPPORTED_PRESETS = Object.freeze(['standard', 'cordis', 'ptc', 'minimal']);
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const failure = (code) => {
  throw new SiwcError(code);
};

// Adapt the native declaration IN MEMORY, before its own Config/registration.
// Never mutate raw Loader options, evaluate child expressions, persist a patch,
// replace a preset id or copy a user's declaration into this package.
export function adaptPresetDefinition(definition, moduleName) {
  if (!SUPPORTED_PRESETS.includes(definition?.id)) return { supported: false };
  try {
    if (!Array.isArray(definition.plugins)) return { supported: false };
    const config = structuredClone(definition);
    let count = 0;
    const walk = (rows) => {
      for (const row of rows) {
        if (!plain(row)) throw Error();
        if ([NATIVE_COMPACTION, COMPAT_COMPACTION, moduleName].includes(row.name)) throw Error();
        if (row.name !== 'cordis:group') continue;
        if (!Array.isArray(row.config)) throw Error();
        if (row.isolate?.compaction === undefined) {
          walk(row.config);
          continue;
        }
        if (!row.isolate.compaction || row.disabled) throw Error();
        const owners = row.config.filter((r) =>
          [NATIVE_COMPACTION, COMPAT_COMPACTION, moduleName].includes(r.name),
        );
        const allowed = new Set([
          NATIVE_COMPACTION,
          COMPAT_COMPACTION,
          moduleName,
          '@deepseek-ai/dsh-command-compact',
          '@deepseek-ai/dsh-compaction-tool-result-pruner',
        ]);
        if (
          owners.length !== 1 ||
          owners[0].disabled ||
          row.config.some((r) => !allowed.has(r.name))
        )
          throw Error();
        const owner = owners[0];
        if (owner.name === NATIVE_COMPACTION) {
          if (owner.config !== undefined && !plain(owner.config)) throw Error();
          owner.config = {
            basic: owner.config ?? {},
            summaryTimeoutMs: 300000,
            maxSummaryBytes: 262144,
          };
        } else {
          // The former local bundle is accepted without nesting config.basic.
          // Unknown engines/options remain unmodified and fail session coverage.
          if (
            !plain(owner.config) ||
            !plain(owner.config.basic) ||
            Object.keys(owner.config).some(
              (k) => !['basic', 'summaryTimeoutMs', 'maxSummaryBytes'].includes(k),
            )
          )
            throw Error();
        }
        owner.name = moduleName;
        count++;
      }
    };
    walk(config.plugins);
    return count === 1 ? { supported: true, config } : { supported: false };
  } catch {
    return { supported: false };
  }
}

// Exact live revision + durable selected-preset projection, NOT creation header.
// Calls lacking session identity remain ordinary standalone provider calls.
export function assertSessionCoverage(ctx, sessionId, moduleName, purpose) {
  try {
    return checkSessionCoverage(ctx, sessionId, moduleName, purpose);
  } catch (error) {
    if (error instanceof SiwcError) throw error;
    failure('DSH_SIWC_PRESET_CONTRACT_MISSING');
  }
}
function checkSessionCoverage(ctx, sessionId, moduleName, purpose) {
  if (sessionId === undefined) return;
  const agent = ctx.agents.get(sessionId);
  if (!agent) failure('SIWC_SESSION_COVERAGE_UNAVAILABLE');
  const registry = ctx.agentPresets;
  const composed = registry.composedPreset(agent.ctx);
  const selected = ctx.sessionProjections.stateOf(agent.session, 'agentPreset');
  if (!composed || selected !== composed) failure('SIWC_PRESET_REVISION_MISMATCH');
  const inspected = registry.inspectCompositions(agent.ctx);
  const engine = registry.serviceFor(agent, 'compaction');
  if (
    inspected.length !== 1 ||
    inspected[0].id !== composed ||
    inspected[0].leakedServices.length ||
    engine?.[COVERAGE] !== COVERAGE_TOKEN
  )
    failure('SIWC_COMPACTION_NOT_COVERED');
  const modules = inspected[0].modules;
  if (
    modules.filter((m) => m.moduleName === moduleName || m.moduleName === COMPAT_COMPACTION)
      .length !== 1 ||
    modules.some((m) => m.moduleName === NATIVE_COMPACTION)
  )
    failure('SIWC_COMPACTION_NOT_COVERED');
  if (purpose !== 'compaction') {
    if (typeof engine.assertConversationReady !== 'function')
      failure('SIWC_COMPACTION_NOT_COVERED');
    try {
      engine.assertConversationReady(agent.session);
    } catch (error) {
      failure(
        error?.code === 'SIWC_COMPACTION_REQUIRED'
          ? 'SIWC_COMPACTION_REQUIRED'
          : 'DSH_SIWC_COMPACTION_SAFETY_MISSING',
      );
    }
  }
}

export async function installPresetIntegration(ctx, NativePreset, moduleName) {
  if (
    typeof NativePreset !== 'function' ||
    typeof moduleName !== 'string' ||
    !moduleName.startsWith('file:') ||
    typeof ctx.loader?.entries !== 'function' ||
    typeof ctx.agents?.get !== 'function' ||
    ['composedPreset', 'inspectCompositions', 'serviceFor'].some(
      (k) => typeof ctx.agentPresets?.[k] !== 'function',
    ) ||
    typeof ctx.sessionProjections?.stateOf !== 'function'
  )
    failure('DSH_SIWC_PRESET_CONTRACT_MISSING');
  let closed = false;
  const lifetime = new AbortController();
  const timer = setTimeout(
    () => lifetime.abort(new SiwcError('DSH_SIWC_PRESET_STARTUP_TIMEOUT')),
    30000,
  );
  const wait = async (task) => {
    let abort;
    const observed = Promise.resolve(task);
    observed.catch(() => {});
    try {
      lifetime.signal.throwIfAborted();
      return await Promise.race([
        observed,
        new Promise((_, reject) => {
          abort = () => reject(lifetime.signal.reason);
          lifetime.signal.addEventListener('abort', abort, { once: true });
          if (lifetime.signal.aborted) abort();
        }),
      ]);
    } finally {
      if (abort) lifetime.signal.removeEventListener('abort', abort);
    }
  };
  const updated = new Map();
  const off = ctx.on(
    'internal/config',
    function (_raw, next) {
      const config = next();
      if (closed || this.runtime?.callback !== NativePreset) return config;
      const adapted = adaptPresetDefinition(config, moduleName);
      if (!adapted.supported) return config;
      // Include declarations created after initial installation as well.
      updated.set(this, { raw: _raw, entry: this.entry });
      return adapted.config;
    },
    { global: true },
  );
  const dispose = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    lifetime.abort(new SiwcError('PLUGIN_DISPOSED'));
    off();
    // Public noSave update restores raw declarations for future bindings.
    // Native registry revision retention owns existing Agents; never rebind them.
    for (const [fiber, { raw, entry }] of updated) {
      try {
        if (fiber.runtime?.callback === NativePreset)
          fiber.update(entry?.fiber === fiber ? entry.options.config : raw, true);
      } catch {
        /* owning preset may already have been removed */
      }
    }
    updated.clear();
  };
  ctx.effect(() => dispose, 'siwc: in-memory preset integration');
  // Do NOT await the whole Host Loader here: it may include this provider's
  // current activation. Await only native declaration fibers, which own trees.
  try {
    for (const entry of [...ctx.loader.entries()]) {
      if (closed) failure('PLUGIN_DISPOSED');
      if (entry.options.name !== NATIVE_PRESET || !entry.fiber) continue;
      try {
        await wait(entry.fiber.await());
      } catch (error) {
        if (lifetime.signal.aborted) throw error;
        continue;
      }
      if (closed) failure('PLUGIN_DISPOSED');
      const adapted = adaptPresetDefinition(entry.options.config, moduleName);
      if (!adapted.supported) continue;
      entry.fiber.update(entry.options.config, true);
      await wait(entry.fiber.await());
    }
  } catch (error) {
    dispose();
    throw error instanceof SiwcError ? error : new SiwcError('DSH_SIWC_PRESET_CONTRACT_MISSING');
  } finally {
    clearTimeout(timer);
  }
  return {
    assertCoverage: (sessionId, purpose) => {
      if (closed) failure('PLUGIN_DISPOSED');
      assertSessionCoverage(ctx, sessionId, moduleName, purpose);
    },
  };
}
