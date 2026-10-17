// Installed Desktop services, disposable synthetic Sessions, mock transport only.
// Never loads a profile, credentials, account grants or a real inference endpoint.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire, registerHooks } from 'node:module';
import { createAdapterClass } from '../src/siwc/adapter.js';
import { COMPACTION_INSTRUCTION } from '../src/siwc/compaction-instruction.js';
import { SAFETY_KEY } from '../src/siwc/compaction.js';

const asar = process.env.DSH_ASAR;
if (!asar) throw new Error('Set DSH_ASAR');
const req = createRequire(pathToFileURL(join(asar, 'dsh/package.json')));
// Mirror native package-root resolution, using ONLY installed exported peers.
// This hook belongs to this disposable test process, never the production app.
const peers = new Map(
  [
    '@deepseek-ai/dsh-compaction-basic',
    '@deepseek-ai/dsh-compaction-basic/package.json',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/schemastery',
    'zod',
  ].map((name) => [name, pathToFileURL(req.resolve(name)).href]),
);
const resolver = registerHooks({
  resolve(specifier, context, next) {
    if (context.conditions.includes('require')) return next(specifier, context);
    return peers.has(specifier)
      ? { url: peers.get(specifier), shortCircuit: true }
      : next(specifier, context);
  },
});
const load = async (name) => import(pathToFileURL(req.resolve(name)).href);
const [
  { Context },
  native,
  sessionModule,
  projections,
  meterModule,
  persistence,
  { default: Engine },
  { default: Basic },
] = await Promise.all([
  load('@deepseek-ai/cordis'),
  load('@deepseek-ai/dsh-llm'),
  load('@deepseek-ai/dsh-session'),
  load('@deepseek-ai/dsh-session-projection'),
  load('@deepseek-ai/dsh-token-meter'),
  load('@deepseek-ai/dsh-session-persistence-jsonl'),
  import('../src/compaction.js'),
  load('@deepseek-ai/dsh-compaction-basic'),
]);
const P = 'chatgpt-subscription',
  model = 'synthetic-compaction-model';
const dir = await mkdtemp(join(tmpdir(), 'dsh-siwc-compaction-'));
const ctx = new Context();
const clockLimit = setTimeout(() => {
  console.error('NATIVE_COMPACTION_FIXTURE_TIMEOUT');
  process.exit(1);
}, 30000);
const calls = [];
let mode = 'success',
  onFetch;
const Adapter = createAdapterClass(native);
const selection = { key: 'synthetic-account', generation: 1 };
const adapter = new Adapter({
  accounts: { selection: async () => selection },
  sessions: { access: async () => ({ accessToken: 'mock-native-compaction-only' }) },
  fetchImpl: async (url, options) => {
    if (url.endsWith('/models'))
      return Response.json({
        models: [{ slug: model, visibility: 'list', context_window: 20000 }],
      });
    const body = JSON.parse(options.body);
    calls.push(body);
    onFetch?.(body);
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(Object.hasOwn(body, 'max_output_tokens'), false);
    if (mode === 'stall')
      return new Promise((_, reject) =>
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        }),
      );
    const text =
      mode === 'oversized'
        ? 'too-large '.repeat(30000)
        : mode === 'large'
          ? 'not-smaller '.repeat(10000)
          : mode === 'empty'
            ? ''
            : '## Current Work\n- Synthetic checkpoint verified.\n## Next Step\n- Continue the retained task.';
    const event =
      mode === 'incomplete'
        ? { type: 'response.incomplete', response: { status: 'incomplete' } }
        : {
            type: 'response.completed',
            response: {
              id: 'resp_compaction_fixture',
              status: 'completed',
              output: [
                {
                  type: 'message',
                  id: 'mock-message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text, annotations: [] }],
                },
              ],
              usage: { input_tokens: 1000, output_tokens: 30 },
            },
          };
    return new Response(`data: ${JSON.stringify(event)}\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  },
});
function fixture(id, owner = ctx) {
  const session = owner.sessions.create(id);
  session.append('turn/start', { turn: 1 });
  session.append('request/header', {
    reason: 'initial',
    header: { config: { provider: P, model } },
  });
  session.append('request/context', { provider: P, model, contextWindow: 20000 });
  session.append('step/start', { turn: 1, step: 1 });
  session.append(
    'system/message',
    {
      turn: 1,
      step: 1,
      message: {
        id: `${id}-system`,
        role: 'system',
        source: { kind: 'system-prompt' },
        content: [{ type: 'text', text: 'Synthetic system prefix: no real conversation.' }],
      },
    },
    { surfaceOp: 'append' },
  );
  const start = session.append(
    'user/message',
    native.createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'synthetic old context '.repeat(1200) }],
    }),
    { surfaceOp: 'append' },
  ).seq;
  session.append(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      message: {
        id: `${id}-assistant`,
        role: 'assistant',
        source: { kind: 'model', provider: P, model },
        content: [{ type: 'text', text: 'synthetic old answer '.repeat(1000) }],
      },
      stream: [],
    },
    { surfaceOp: 'append' },
  );
  session.append('step/end', { turn: 1, step: 1 });
  const end = session.surface.nodes.at(-1);
  session.append(
    'user/message',
    native.createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Recent tail must remain verbatim.' }],
    }),
    { surfaceOp: 'append' },
  );
  return { session, options: { provider: P, model }, start, end };
}
const eventsOf = (s) => s.snapshotEvents();
try {
  // Provider Schema/retry contracts are separately tested by native-siwc so
  // this optional compaction change remains independently revertible.
  assert.throws(() => Engine.Config({ summaryTimeoutMs: 0 }));
  await ctx.plugin(native.default);
  await ctx.plugin(sessionModule.default);
  await ctx.plugin(projections.default);
  await ctx.plugin(meterModule.default);
  await ctx.plugin(persistence, { root: dir, compression: 'none' });
  ctx.llm.registerAdapter([P], adapter);
  await ctx.plugin(Engine, {
    basic: { auto: false, headroomTokens: 1024, retainTokens: 1000 },
    summaryTimeoutMs: 2000,
    maxSummaryBytes: 262144,
  });
  assert.ok(ctx.compaction instanceof Engine);

  const original = fixture('native-original');
  // Public original hook proves the regression without another backend owner.
  await assert.rejects(
    Basic.prototype.summarize.call(
      ctx.compaction,
      { messages: original.session.deriveMessages() },
      original,
    ),
    { code: 'UNSUPPORTED_MAX_TOKENS' },
  );
  assert.equal(calls.length, 0);

  const f = fixture('native-success');
  const before = ctx.tokenMeter.measure(f.session).totalTokens;
  const oldNodes = [...f.session.surface.nodes];
  const result = await ctx.compaction.compactRegion(
    f.start,
    f.end,
    f,
    new AbortController().signal,
  );
  assert.ok(result.shadowedSeqs.length >= 2);
  assert.equal(f.session.surface.nodes.length, oldNodes.length - result.shadowedSeqs.length + 1);
  assert.equal(
    f.session.deriveMessages().at(-1).content[0].text,
    'Recent tail must remain verbatim.',
  );
  const rows = eventsOf(f.session);
  assert.equal(rows.filter((r) => r.type === 'compaction/start').length, 1);
  assert.equal(rows.filter((r) => r.type === 'compaction/end').length, 1);
  const recorded = rows.find((r) => r.type === 'compaction/summary');
  assert.ok(recorded);
  assert.equal(Object.hasOwn(recorded.data, 'maxTokens'), false);
  const after = ctx.tokenMeter.measure(f.session).totalTokens;
  assert.ok(Number.isFinite(before) && Number.isFinite(after) && after < before);
  assert.ok(
    f.session
      .deriveMessages()
      .map((m) => JSON.stringify(m))
      .join('').length < 2000,
  );
  assert.equal(calls[0].input.at(-1).content[0].text, COMPACTION_INSTRUCTION);
  assert.equal(ctx.sessionProjections.stateOf(f.session, SAFETY_KEY).failed, false);

  // Native physical format + restore replays the checkpoint, never old surface.
  f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const write = await ctx.sessionPersistence.create(f.session.header);
  await write.append(eventsOf(f.session));
  await write.flush();
  await write.close();
  const read = await ctx.sessionPersistence.open(f.session.id, 'read');
  const stored = await read.read();
  await read.close();
  const restored = sessionModule.Session.fromRestore(
    f.session.id,
    stored.events,
    read.header,
    read.inheritedEventCount,
    stored.eventState,
  );
  assert.deepEqual(restored.surface.nodes, f.session.surface.nodes);
  assert.deepEqual(restored.deriveMessages(), f.session.deriveMessages());

  for (const outcome of ['empty', 'incomplete', 'large', 'oversized']) {
    mode = outcome;
    const bad = fixture(`native-${outcome}`),
      saved = [...bad.session.surface.nodes];
    await assert.rejects(
      ctx.compaction.compactRegion(bad.start, bad.end, bad, new AbortController().signal),
    );
    assert.deepEqual(bad.session.surface.nodes, saved);
    assert.equal(eventsOf(bad.session).filter((r) => r.type === 'compaction/summary').length, 0);
    assert.equal(eventsOf(bad.session).filter((r) => r.type === 'compaction/end').length, 1);
    assert.equal(ctx.sessionProjections.stateOf(bad.session, SAFETY_KEY).failed, true);
    const decision = await ctx.waterfall(
      'agent/pre-step',
      { agent: bad, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    );
    assert.equal(decision.kind, 'reject');
    if (outcome === 'empty') {
      bad.session.append('turn/end', { turn: 1, reason: { kind: 'blocked' } });
      mode = 'success';
      const manual = { ...bad, runMaintenance: (task) => task(new AbortController().signal) };
      await ctx.compaction.compactNow(manual, new AbortController().signal);
      assert.equal(ctx.sessionProjections.stateOf(bad.session, SAFETY_KEY).failed, false);
    }
  }
  mode = 'success';
  const changed = fixture('native-changed'),
    saved = [...changed.session.surface.nodes];
  onFetch = () => {
    onFetch = undefined;
    changed.session.append(
      'user/message',
      native.createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'concurrent append' }],
      }),
      { surfaceOp: 'append' },
    );
  };
  await assert.rejects(
    ctx.compaction.compactRegion(changed.start, changed.end, changed, new AbortController().signal),
  );
  assert.deepEqual(changed.session.surface.nodes.slice(0, saved.length), saved);
  assert.equal(eventsOf(changed.session).filter((r) => r.type === 'compaction/summary').length, 0);

  mode = 'stall';
  const cancelled = fixture('native-cancelled');
  const cancel = new AbortController();
  onFetch = () => {
    onFetch = undefined;
    queueMicrotask(() => cancel.abort(new Error('synthetic user cancellation')));
  };
  await assert.rejects(
    ctx.compaction.compactRegion(cancelled.start, cancelled.end, cancelled, cancel.signal),
  );
  assert.equal(eventsOf(cancelled.session).filter((r) => r.type === 'compaction/end').length, 1);
  assert.equal(
    eventsOf(cancelled.session).filter((r) => r.type === 'compaction/summary').length,
    0,
  );
  // Native successful transactions can still fail overall convergence. The
  // outer wrapper must block before any main request despite successful ends.
  mode = 'success';
  const pressureCtx = new Context();
  try {
    await pressureCtx.plugin(native.default);
    await pressureCtx.plugin(sessionModule.default);
    await pressureCtx.plugin(projections.default);
    await pressureCtx.plugin(meterModule.default);
    pressureCtx.llm.registerAdapter([P], adapter);
    await pressureCtx.plugin(Engine, {
      basic: {
        auto: true,
        thresholdRatio: 0.002,
        headroomTokens: 1024,
        retainTokens: 0,
        compactionRetries: 0,
      },
      summaryTimeoutMs: 2000,
    });
    const pressure = fixture('native-nonconverged', pressureCtx);
    const decision = await pressureCtx.waterfall(
      'agent/pre-step',
      { agent: pressure, messages: [], turn: 1, step: 2, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    );
    const ends = eventsOf(pressure.session).filter((row) => row.type === 'compaction/end');
    assert.ok(ends.length > 0 && ends.every((row) => row.data.error === undefined));
    assert.equal(
      pressureCtx.sessionProjections.stateOf(pressure.session, SAFETY_KEY).failed,
      false,
    );
    assert.equal(decision.kind, 'reject');
  } finally {
    await pressureCtx.fiber.dispose();
  }
  console.log(
    JSON.stringify({
      nativeCompaction: 'passed',
      serverCalls: 0,
      mockResponsesCalls: calls.length,
      originalConflictReproduced: true,
      checkpointReplacement: true,
      honestNoTokenCap: true,
      tailPreserved: true,
      nativePersistenceRestore: true,
      failClosedGuard: true,
      failureTransactionBalanced: true,
      meterBefore: before,
      meterAfter: after,
    }),
  );
} finally {
  adapter.dispose();
  await ctx.fiber.dispose();
  resolver.deregister();
  clearTimeout(clockLimit);
  await rm(dir, { recursive: true, force: true });
}
