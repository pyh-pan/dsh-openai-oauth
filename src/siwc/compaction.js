import { COMPACTION_INSTRUCTION } from './compaction-instruction.js';

const PROVIDER = 'chatgpt-subscription';
export const SAFETY_KEY = 'siwcCompactionSafety';
const nonempty = (value) => typeof value === 'string' && value.length > 0;
const fail = (code) => Object.assign(new Error(code), { code });
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Resolve only the documented hook's route selection, not pressure/retention.
// modelPolicies match the conversation route, NOT the summarizer route.
export function summaryTarget(config, agent) {
  const latest = agent.session.requestHeader()?.config;
  const fallback =
    nonempty(agent.options.provider) && nonempty(agent.options.model)
      ? { provider: agent.options.provider, model: agent.options.model }
      : undefined;
  const conversation = nonempty(latest?.provider) && nonempty(latest?.model) ? latest : fallback;
  const policy = config.modelPolicies?.find(
    (entry) => entry.provider === conversation?.provider && entry.model === conversation?.model,
  );
  const provider = policy?.summarizationProvider ?? config.summarizationProvider;
  const model = policy?.summarizationModel ?? config.summarizationModel;
  return nonempty(provider) ? { provider, model } : (latest ?? fallback);
}

export function resolveSummaryLimits(config = {}) {
  if (
    !object(config) ||
    Object.keys(config).some(
      (key) => !['basic', 'summaryTimeoutMs', 'maxSummaryBytes'].includes(key),
    )
  )
    throw fail('SIWC_COMPACTION_CONFIG_INVALID');
  if (config.basic !== undefined && !object(config.basic))
    throw fail('SIWC_COMPACTION_CONFIG_INVALID');
  const limits = {
    summaryTimeoutMs: config.summaryTimeoutMs ?? 300000,
    maxSummaryBytes: config.maxSummaryBytes ?? 262144,
  };
  for (const [key, maximum] of [
    ['summaryTimeoutMs', 1800000],
    ['maxSummaryBytes', 8388608],
  ])
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > maximum)
      throw fail('SIWC_COMPACTION_CONFIG_INVALID');
  return Object.freeze(limits);
}

// No session text, errors or route identifiers enter this persisted projection.
export function safetyDefinition(stateSchema) {
  return {
    key: SAFETY_KEY,
    stateVersion: 1,
    stateSchema,
    init: () => ({ failed: false }),
    apply: (state, event) =>
      event.type === 'compaction/end' ? { failed: event.data.error !== undefined } : state,
  };
}

export function createCompactionClass(
  { BasicCompactionEngine, BlockAssembler, LlmError },
  { now = () => performance.now() } = {},
) {
  if (
    typeof BasicCompactionEngine?.prototype?.summarize !== 'function' ||
    typeof BlockAssembler !== 'function' ||
    typeof LlmError !== 'function'
  )
    throw fail('DSH_SIWC_COMPACTION_CONTRACT_MISSING');
  return class SiwcCompactionEngine extends BasicCompactionEngine {
    static inject = [...BasicCompactionEngine.inject, 'sessionProjections'];
    _siwcSummaryLimits;
    _siwcSummaryClosed = new AbortController();
    // Transient outcome of a native pressure operation, not a replay cache.
    // Recomputed by super on every admitted pre-step; no history is rewritten.
    _siwcFailedPressure = new WeakSet();
    constructor(ctx, config = {}) {
      const limits = resolveSummaryLimits(config);
      super(ctx, config.basic ?? {});
      this._siwcSummaryLimits = limits;
      ctx.effect(() => () => this._siwcSummaryClosed.abort(fail('PLUGIN_DISPOSED')));
      // The native pre-step listener runs first. The projection includes its
      // closed attempt before this guard reads, including failures AFTER hook
      // return (not smaller, changed history, commit failure). No duplicate backend.
      ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
        if (!signal.aborted && summaryTarget(this.config, agent)?.provider === PROVIDER) {
          const state = ctx.sessionProjections.stateOf(agent.session, SAFETY_KEY);
          if (state === undefined) throw fail('DSH_SIWC_COMPACTION_SAFETY_MISSING');
          if (state.failed || this._siwcFailedPressure.has(agent.session)) {
            ctx.logger.warn(
              'SIWC_COMPACTION_REQUIRED: turn paused after failed compaction; original history retained. Fix the failure and run /compact, or use a reviewed handoff to a new session.',
            );
            return { kind: 'reject' };
          }
        }
        return next();
      });
    }
    // Preserve the native algorithm and its transaction owner. This outer
    // catch observes convergence/config/active-lock failures that occur outside
    // summarize() and therefore may have no failed compaction/end to project.
    async compactIfNeeded(agent, trigger, signal) {
      try {
        const result = await super.compactIfNeeded(agent, trigger, signal);
        this._siwcFailedPressure.delete(agent.session);
        return result;
      } catch (error) {
        if (!signal?.aborted && summaryTarget(this.config, agent)?.provider === PROVIDER)
          this._siwcFailedPressure.add(agent.session);
        throw error;
      }
    }
    async summarize(input, agent, signal) {
      const target = summaryTarget(this.config, agent);
      if (target?.provider !== PROVIDER) return super.summarize(input, agent, signal);
      const local = new AbortController();
      const combined = AbortSignal.any([
        local.signal,
        this._siwcSummaryClosed.signal,
        ...(signal ? [signal] : []),
      ]);
      const deadline = now() + this._siwcSummaryLimits.summaryTimeoutMs;
      const assertLive = () => {
        combined.throwIfAborted();
        if (now() >= deadline) {
          local.abort(fail('SIWC_SUMMARY_DEADLINE'));
          combined.throwIfAborted();
        }
      };
      const timer = setTimeout(
        () => local.abort(fail('SIWC_SUMMARY_DEADLINE')),
        this._siwcSummaryLimits.summaryTimeoutMs,
      );
      let iterator, onAbort;
      try {
        assertLive();
        const abort = new Promise((_, reject) => {
          onAbort = () => reject(combined.reason);
          combined.addEventListener('abort', onAbort, { once: true });
          if (combined.aborted) onAbort();
        });
        const assembler = new BlockAssembler();
        const bytes = new Map(),
          used = new Set(),
          closed = new Set();
        let total = 0,
          terminal;
        const options = {
          provider: target.provider,
          model: target.model,
          messages: [
            ...input.messages,
            Object.freeze({
              role: 'user',
              content: Object.freeze([
                Object.freeze({ type: 'text', text: COMPACTION_INSTRUCTION }),
              ]),
            }),
          ],
          toolHistory: agent.session.toolHistory(),
          ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
          sessionId: agent.session.id,
          purpose: 'compaction',
          signal: combined,
          // Explicit policy: NO server output-token cap for this SIWC hook.
        };
        iterator = this.ctx.llm.stream(options)[Symbol.asyncIterator]();
        for (;;) {
          assertLive();
          const { value: chunk, done } = await Promise.race([iterator.next(), abort]);
          assertLive();
          if (done) break;
          if (terminal) throw fail('SIWC_SUMMARY_INVALID_TERMINAL');
          if (Object.hasOwn(chunk, 'index')) {
            if (
              !Number.isSafeInteger(chunk.index) ||
              chunk.index < 0 ||
              chunk.index >= 1024 ||
              closed.has(chunk.index)
            )
              throw fail('SIWC_SUMMARY_INVALID_OUTPUT');
            used.add(chunk.index);
            const previous = bytes.get(chunk.index) ?? 0;
            let next = previous;
            if (['text-delta', 'reasoning-delta'].includes(chunk.type))
              next += Buffer.byteLength(chunk.text, 'utf8');
            else if (chunk.type === 'tool-call-delta')
              next += Buffer.byteLength(chunk.argumentsDelta, 'utf8');
            else if (chunk.type === 'block-end') {
              next = Math.max(
                previous,
                Buffer.byteLength(chunk.block.text ?? chunk.block.arguments ?? '', 'utf8'),
              );
              closed.add(chunk.index);
            }
            bytes.set(chunk.index, next);
            total += next - previous;
            if (total > this._siwcSummaryLimits.maxSummaryBytes)
              throw fail('SIWC_SUMMARY_SIZE_LIMIT');
          }
          assembler.push(chunk);
          assertLive();
          if (chunk.type === 'finish') {
            terminal = chunk.reason;
            if (terminal.kind === 'error' || terminal.kind === 'aborted')
              throw new LlmError(terminal.failure.message, terminal.failure.code, terminal.failure);
            if (terminal.kind !== 'stop') throw fail('SIWC_SUMMARY_INCOMPLETE');
          }
        }
        assertLive();
        if (!terminal || terminal.kind !== 'stop' || [...used].some((index) => !closed.has(index)))
          throw fail('SIWC_SUMMARY_INCOMPLETE');
        const rawOutput = assembler.blocks();
        assertLive();
        if (rawOutput.some((block) => ['image', 'file', 'tool-call'].includes(block.type)))
          throw fail('SIWC_SUMMARY_UNSUPPORTED_OUTPUT');
        const summary = rawOutput.filter((block) => block.type === 'text');
        if (!summary.some((block) => block.text.trim().length > 0))
          throw fail('SIWC_SUMMARY_EMPTY');
        if (
          rawOutput.reduce(
            (sum, block) => sum + Buffer.byteLength(block.text ?? block.arguments ?? '', 'utf8'),
            0,
          ) > this._siwcSummaryLimits.maxSummaryBytes
        )
          throw fail('SIWC_SUMMARY_SIZE_LIMIT');
        assertLive();
        return {
          summary,
          rawOutput,
          llmStreamCall: true,
          provider: target.provider,
          model: target.model,
          ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
          // Omitting maxTokens is supported by native result and log types.
        };
      } finally {
        clearTimeout(timer);
        if (onAbort) combined.removeEventListener('abort', onAbort);
        local.abort(fail('SIWC_SUMMARY_CLOSED'));
        // An adapter must honor the supplied signal. Never let a broken adapter's
        // pending return() keep the native transaction/lock open indefinitely.
        try {
          Promise.resolve(iterator?.return?.()).catch(() => {});
        } catch {
          /* cleanup only */
        }
      }
    }
  };
}
