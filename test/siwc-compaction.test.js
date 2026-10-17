import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCompactionClass,
  resolveSummaryLimits,
  summaryTarget,
  safetyDefinition,
  SAFETY_KEY,
} from '../src/siwc/compaction.js';
import { responsesBody } from '../src/siwc/wire.js';

const P = 'chatgpt-subscription';
class ErrorFixture extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}
class Assembler {
  values = [];
  usage;
  push(chunk) {
    if (chunk.type === 'block-end') this.values.push(chunk.block);
    if (chunk.type === 'usage') this.usage = chunk.usage;
  }
  blocks() {
    return this.values;
  }
}
class Basic {
  static inject = ['llm', 'tokenMeter', 'sessions'];
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = {
      summarizationProvider: '',
      summarizationModel: '',
      modelPolicies: [],
      ...config,
    };
  }
  async summarize() {
    return { native: true };
  }
  async compactIfNeeded() {
    if (this.ctx.pressureError) throw this.ctx.pressureError;
    return null;
  }
}
const Engine = createCompactionClass({
  BasicCompactionEngine: Basic,
  BlockAssembler: Assembler,
  LlmError: ErrorFixture,
});
const block = (text, type = 'text') => ({ type: 'block-end', index: 0, block: { type, text } });
const finish = (kind = 'stop') => ({ type: 'finish', reason: { kind } });
const input = {
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'prefix' }] },
    { role: 'user', content: [{ type: 'text', text: 'synthetic' }] },
  ],
  tools: [{ name: 'offline', parameters: {} }],
};
function fixture({ config = {}, chunks = [block('smaller'), finish()], stream } = {}) {
  const hooks = new Map(),
    effects = [],
    calls = [],
    history = { tools: [] };
  const agent = {
    options: { provider: 'other', model: 'fallback' },
    session: {
      id: 'synthetic',
      requestHeader: () => ({ config: { provider: P, model: 'actual' } }),
      toolHistory: () => history,
    },
  };
  const ctx = {
    effect: (fn) => effects.push(fn()),
    on: (key, fn) => hooks.set(key, fn),
    logger: { warn() {} },
    sessionProjections: { stateOf: () => ({ failed: false }) },
    llm: {
      stream: (options) => {
        calls.push(options);
        return stream
          ? stream(options)
          : (async function* () {
              yield* chunks;
            })();
      },
    },
  };
  return { ctx, agent, calls, history, hooks, effects, engine: new Engine(ctx, config) };
}
test('original cap conflict stays strict, including caller-supplied purpose', () => {
  for (const purpose of [undefined, 'compaction'])
    assert.throws(
      () =>
        responsesBody(
          { provider: P, model: 'mock', messages: input.messages, purpose, maxTokens: 65536 },
          { accountKey: 'mock' },
        ),
      { code: 'UNSUPPORTED_MAX_TOKENS' },
    );
});
test('SIWC hook keeps prefix/tools/affinity and honest no-cap metadata', async () => {
  const f = fixture();
  const result = await f.engine.summarize(input, f.agent);
  const call = f.calls[0];
  assert.deepEqual(call.messages.slice(0, -1), input.messages);
  assert.equal(call.toolHistory, f.history);
  assert.deepEqual(call.tools, input.tools);
  assert.equal(call.sessionId, f.agent.session.id);
  assert.equal(call.provider, P);
  assert.equal(call.model, 'actual');
  assert.equal(call.purpose, 'compaction');
  assert.equal(Object.hasOwn(call, 'maxTokens'), false);
  assert.equal(Object.hasOwn(result, 'maxTokens'), false);
  assert.equal(responsesBody(call, { accountKey: 'mock' }).max_output_tokens, undefined);
  assert.deepEqual(result.summary, [{ type: 'text', text: 'smaller' }]);
});
test('explicit summary route and conversation modelPolicies determine isolation', async () => {
  const f = fixture({
    config: { basic: { summarizationProvider: 'other', summarizationModel: 'summary' } },
  });
  assert.deepEqual(await f.engine.summarize(input, f.agent), { native: true });
  assert.equal(f.calls.length, 0);
  const config = {
    summarizationProvider: 'global',
    summarizationModel: 'global-model',
    modelPolicies: [
      { provider: P, model: 'actual', summarizationProvider: '', summarizationModel: '' },
    ],
  };
  assert.deepEqual(summaryTarget(config, f.agent), { provider: P, model: 'actual' });
  config.modelPolicies[0] = {
    provider: P,
    model: 'actual',
    summarizationProvider: P,
    summarizationModel: 'special',
  };
  assert.deepEqual(summaryTarget(config, f.agent), { provider: P, model: 'special' });
  f.agent.session.requestHeader = () => undefined;
  assert.deepEqual(
    summaryTarget({ summarizationProvider: '', modelPolicies: [] }, f.agent),
    f.agent.options,
  );
});
for (const [label, chunks, code] of [
  ['missing terminal', [block('partial')], 'SIWC_SUMMARY_INCOMPLETE'],
  ['truncated', [block('partial'), finish('max-tokens')], 'SIWC_SUMMARY_INCOMPLETE'],
  ['tools only', [finish('tool-calls')], 'SIWC_SUMMARY_INCOMPLETE'],
  ['empty', [block('   '), finish()], 'SIWC_SUMMARY_EMPTY'],
  ['reasoning only', [block('private', 'reasoning'), finish()], 'SIWC_SUMMARY_EMPTY'],
  ['image', [block('bad', 'image'), finish()], 'SIWC_SUMMARY_UNSUPPORTED_OUTPUT'],
  ['double terminal', [block('bad'), finish(), finish()], 'SIWC_SUMMARY_INVALID_TERMINAL'],
])
  test(`summary rejects ${label} rather than landing partial output`, async () => {
    const f = fixture({ chunks });
    await assert.rejects(f.engine.summarize(input, f.agent), { code });
  });
test('terminal provider error retains supported failure identity', async () => {
  const f = fixture({
    chunks: [
      {
        type: 'finish',
        reason: { kind: 'error', failure: { message: 'PLUGIN_DISPOSED', code: 'PLUGIN_DISPOSED' } },
      },
    ],
  });
  await assert.rejects(f.engine.summarize(input, f.agent), { code: 'PLUGIN_DISPOSED' });
});
test('local UTF-8 output size fails; never truncates into success', async () => {
  for (const chunks of [
    [block('中文中文'), finish()],
    [{ type: 'text-delta', index: 0, text: '中文中文' }, finish()],
  ]) {
    const f = fixture({ config: { maxSummaryBytes: 10 }, chunks });
    await assert.rejects(f.engine.summarize(input, f.agent), { code: 'SIWC_SUMMARY_SIZE_LIMIT' });
  }
});
test('wall-clock limit settles and aborts even stalled iterator', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requestSignal,
    returned = false;
  const f = fixture({
    config: { summaryTimeoutMs: 100 },
    stream: (options) => ({
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        requestSignal = options.signal;
        return new Promise(() => {});
      },
      return() {
        returned = true;
        return Promise.resolve({ done: true });
      },
    }),
  });
  const done = assert.rejects(f.engine.summarize(input, f.agent), {
    code: 'SIWC_SUMMARY_DEADLINE',
  });
  t.mock.timers.tick(99);
  assert.equal(requestSignal.aborted, false);
  t.mock.timers.tick(1);
  await done;
  assert.equal(requestSignal.aborted, true);
  assert.equal(returned, true);
});
test('caller abort and plugin unload cancel summary; no late result', async () => {
  for (const dispose of [false, true]) {
    const f = fixture({
      stream: () => ({
        [Symbol.asyncIterator]() {
          return this;
        },
        next: () => new Promise(() => {}),
        return: async () => ({ done: true }),
      }),
    });
    const abort = new AbortController();
    const reason = Object.assign(new Error('cancel'), { code: 'ABORTED' });
    const done = f.engine.summarize(input, f.agent, abort.signal);
    if (dispose) f.effects.forEach((effect) => effect());
    else abort.abort(reason);
    await assert.rejects(done, dispose ? { code: 'PLUGIN_DISPOSED' } : (error) => error === reason);
  }
});
test('projection fold and guard stop over-budget continuation after native failure', async () => {
  const f = fixture();
  const unit = safetyDefinition({});
  let state = unit.init();
  assert.equal(unit.apply(state, { type: 'step/start' }), state);
  state = unit.apply(state, { type: 'compaction/end', data: { error: 'failure' } });
  f.ctx.sessionProjections.stateOf = (session, key) => {
    assert.equal(session, f.agent.session);
    assert.equal(key, SAFETY_KEY);
    return state;
  };
  const hook = f.hooks.get('agent/pre-step');
  let calls = 0;
  const next = async () => {
    calls++;
    return { kind: 'enter', messages: [] };
  };
  assert.deepEqual(await hook({ agent: f.agent, signal: new AbortController().signal }, next), {
    kind: 'reject',
  });
  assert.equal(calls, 0);
  state = unit.apply(state, { type: 'compaction/end', data: {} });
  assert.equal(
    (await hook({ agent: f.agent, signal: new AbortController().signal }, next)).kind,
    'enter',
  );
});
test('absolute monotonic deadline rejects work even when timer callback cannot run', async () => {
  let elapsed = 0;
  const StrictEngine = createCompactionClass(
    { BasicCompactionEngine: Basic, BlockAssembler: Assembler, LlmError: ErrorFixture },
    { now: () => elapsed },
  );
  const f = fixture({
    stream: () =>
      (async function* () {
        elapsed = 20;
        yield block('late');
        yield finish();
      })(),
  });
  const engine = new StrictEngine(f.ctx, { summaryTimeoutMs: 5 });
  await assert.rejects(engine.summarize(input, f.agent), { code: 'SIWC_SUMMARY_DEADLINE' });
});
test('closed block indexes cannot lower the accumulated size or hide retained reasoning', async () => {
  const f = fixture({
    config: { maxSummaryBytes: 10 },
    chunks: [
      block('1234567890', 'reasoning'),
      block('', 'reasoning'),
      { ...block('1234567890', 'reasoning'), index: 1 },
      { ...block('ok'), index: 2 },
      finish(),
    ],
  });
  await assert.rejects(f.engine.summarize(input, f.agent), { code: 'SIWC_SUMMARY_INVALID_OUTPUT' });
  for (const index of [-1, 1.5, 1024, Number.MAX_SAFE_INTEGER]) {
    const invalid = fixture({ chunks: [{ ...block('bad'), index }, finish()] });
    await assert.rejects(invalid.engine.summarize(input, invalid.agent), {
      code: 'SIWC_SUMMARY_INVALID_OUTPUT',
    });
  }
});
test('a successful terminal cannot commit an unfinished text block', async () => {
  const f = fixture({ chunks: [{ type: 'text-delta', index: 0, text: 'partial' }, finish()] });
  await assert.rejects(f.engine.summarize(input, f.agent), { code: 'SIWC_SUMMARY_INCOMPLETE' });
});
test('whole native pressure failure blocks even without a failed transaction end', async () => {
  const f = fixture();
  f.ctx.pressureError = new Error('native convergence failed');
  await assert.rejects(f.engine.compactIfNeeded(f.agent, 'pressure', new AbortController().signal));
  const hook = f.hooks.get('agent/pre-step');
  const next = async () => ({ kind: 'enter', messages: [] });
  assert.deepEqual(await hook({ agent: f.agent, signal: new AbortController().signal }, next), {
    kind: 'reject',
  });
  f.ctx.pressureError = undefined;
  await f.engine.compactIfNeeded(f.agent, 'pressure', new AbortController().signal);
  assert.equal(
    (await hook({ agent: f.agent, signal: new AbortController().signal }, next)).kind,
    'enter',
  );
});
test('local limits reject typos, zero and timer overflow', () => {
  assert.deepEqual(resolveSummaryLimits(), { summaryTimeoutMs: 300000, maxSummaryBytes: 262144 });
  for (const config of [
    null,
    [],
    { typo: true },
    { basic: [] },
    { maxSummaryBytes: 0 },
    { summaryTimeoutMs: 2 ** 31 },
    { maxSummaryBytes: 1.5 },
  ])
    assert.throws(() => resolveSummaryLimits(config), { code: 'SIWC_COMPACTION_CONFIG_INVALID' });
});
