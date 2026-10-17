import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapterClass } from '../src/siwc/adapter.js';
import { createHostPlugin } from '../src/siwc/host.js';
import { PROVIDER } from '../src/siwc/controller.js';
import { SiwcError } from '../src/siwc/protocol.js';
import {
  DEFAULT_REQUEST_POLICY,
  MAX_TIMER_MS,
  NORMAL_RETRY_CODES,
  createPluginConfig,
  createTimingTrace,
  normalizePluginConfig,
  normalizeRequestPolicy,
} from '../src/siwc/request-policy.js';

// Unlike the older broad test double, this mirrors the inspected native
// LlmFailure whitelist. No providerCode/responseShape/private details survive.
class NativeShapeError extends Error {
  constructor(message, code, options = {}) {
    super(message);
    this.code = code;
    this.failure = { message, code };
    for (const key of ['status', 'providerRetryAfterMs', 'requestId', 'offloadImages'])
      if (options[key] !== undefined) this.failure[key] = options[key];
  }
}
const native = {
  APP_IDENTITY: { version: '0.2.0-rc.2' },
  LlmAdapter: class {},
  LlmError: NativeShapeError,
  attributionHeaders: () => ({ 'user-agent': 'DSH-synthetic-test' }),
};
const Adapter = createAdapterClass(native);
const turn = () => new Promise(setImmediate);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const options = (extra = {}) => ({
  provider: PROVIDER,
  model: 'test-model',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'PRIVATE_USER_BODY_中文' }] }],
  sessionId: 'PRIVATE_SESSION_ID',
  ...extra,
});
const collect = async (iterable) => {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
};
const event = (value) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
const text = (value) => ({
  id: 'PRIVATE_PROVIDER_ITEM',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text: value, annotations: [] }],
});
const completed = () => ({
  type: 'response.completed',
  response: {
    id: 'PRIVATE_RESPONSE_ID',
    status: 'completed',
    output: [text('PRIVATE_ASSISTANT_BODY')],
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 18,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens_details: { reasoning_tokens: 2 },
      private_usage: 'PRIVATE_USAGE_METADATA',
    },
  },
});
const success = () => new Response(event(completed()));
function stalled({ status = 200, neverCancel = false } = {}) {
  let controller;
  let cancelled = 0;
  const body = new ReadableStream({
    start(value) {
      controller = value;
    },
    cancel() {
      cancelled++;
      if (neverCancel) return new Promise(() => {});
    },
  });
  return {
    response: new Response(body, { status }),
    push: (value) => controller.enqueue(event(value)),
    bytes: (value) => controller.enqueue(new TextEncoder().encode(value)),
    close: () => controller.close(),
    get cancelled() {
      return cancelled;
    },
  };
}
function clock(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const schedule = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  const active = new Map();
  const durations = [];
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    const id = schedule(() => {
      active.delete(id);
      callback(...args);
    }, ms);
    active.set(id, ms);
    durations.push(ms);
    return id;
  });
  t.mock.method(globalThis, 'clearTimeout', (id) => {
    active.delete(id);
    return clear(id);
  });
  return {
    active,
    durations,
    async tick(ms) {
      t.mock.timers.tick(ms);
      await turn();
    },
    empty() {
      assert.equal(active.size, 0, `unreleased timers: ${[...active.values()]}`);
    },
  };
}
function fixture(
  t,
  { requestPolicy, respond = success, catalog, logger, access, idleTimeoutMs } = {},
) {
  const accountAbort = new AbortController();
  let selection = { key: 'PRIVATE_ACCOUNT_KEY', generation: 1 };
  let accessCalls = 0;
  const requests = [];
  const accounts = { selection: async () => selection };
  const sessions = {
    access: async (...args) => {
      accessCalls++;
      if (access) return access(...args);
      return { accessToken: 'PRIVATE_ACCESS_TOKEN', signal: accountAbort.signal };
    },
  };
  const adapter = new Adapter({
    accounts,
    sessions,
    requestPolicy,
    idleTimeoutMs,
    logger,
    timingNow: Date.now,
    fetchImpl(url, init) {
      requests.push({ url, ...init });
      if (url.endsWith('/models'))
        return catalog
          ? catalog(url, init)
          : Response.json({ models: [{ slug: 'test-model', visibility: 'list' }] });
      return respond(url, init);
    },
  });
  t.after(() => adapter.dispose());
  return {
    adapter,
    accounts,
    sessions,
    requests,
    accountAbort,
    prepare: () => adapter.prepareCall(PROVIDER, 'test-model'),
    change() {
      selection = { ...selection, generation: selection.generation + 1 };
    },
    get accessCalls() {
      return accessCalls;
    },
    get inferenceRequests() {
      return requests.filter((request) => request.url.endsWith('/responses'));
    },
  };
}
const failure = (chunks) => {
  const finishes = chunks.filter((chunk) => chunk.type === 'finish');
  assert.equal(finishes.length, 1);
  assert.ok(['error', 'aborted'].includes(finishes[0].reason.kind));
  return finishes[0].reason.failure;
};

test('request policy retains all old clocks and finite native retry defaults', () => {
  assert.deepEqual(normalizeRequestPolicy(), {
    responseHeadersTimeoutMs: 60000,
    streamIdleTimeoutMs: 120000,
    streamTotalTimeoutMs: 1800000,
    catalogTimeoutMs: 15000,
    maxRetries: 5,
    timing: false,
  });
  assert.deepEqual(normalizePluginConfig(), { requestPolicy: DEFAULT_REQUEST_POLICY });
  assert.ok(Object.isFrozen(normalizeRequestPolicy()));
});

test('policy input rejects unknown keys/types, nonfinite/fractional/overflow timers and retries', () => {
  for (const value of [null, [], true, 'secret', 5, new Date(), { unknown: 'PRIVATE_VALUE' }])
    assert.throws(() => normalizeRequestPolicy(value), /^TypeError: SIWC_REQUEST_POLICY_INVALID$/);
  for (const name of [
    'responseHeadersTimeoutMs',
    'streamIdleTimeoutMs',
    'streamTotalTimeoutMs',
    'catalogTimeoutMs',
  ])
    for (const value of [undefined, null, 0, -1, 1.5, NaN, Infinity, '60000', MAX_TIMER_MS + 1])
      assert.throws(() => normalizeRequestPolicy({ [name]: value }), /SIWC_REQUEST_POLICY_INVALID/);
  for (const value of [-1, 0.5, 6, Infinity, '1', null, undefined])
    assert.throws(
      () => normalizeRequestPolicy({ maxRetries: value }),
      /SIWC_REQUEST_POLICY_INVALID/,
    );
  for (const value of ['false', 0, null, undefined])
    assert.throws(() => normalizeRequestPolicy({ timing: value }), /SIWC_REQUEST_POLICY_INVALID/);
  for (const value of [null, [], { other: 1 }, { requestPolicy: null }])
    assert.throws(() => normalizePluginConfig(value), /SIWC_REQUEST_POLICY_INVALID/);
  assert.throws(() => normalizeRequestPolicy({ [Symbol('PRIVATE_KEY')]: 1 }), /POLICY_INVALID/);
  assert.equal(
    normalizeRequestPolicy({ catalogTimeoutMs: MAX_TIMER_MS }).catalogTimeoutMs,
    MAX_TIMER_MS,
  );
});

test('higher headers budgets require explicit <=1 retry and preserve 360s headers-only bound', () => {
  for (const value of [
    { responseHeadersTimeoutMs: 180000 },
    { responseHeadersTimeoutMs: 60001, maxRetries: 2 },
    { responseHeadersTimeoutMs: 180001, maxRetries: 1 },
    { responseHeadersTimeoutMs: 360001, maxRetries: 0 },
  ])
    assert.throws(() => normalizeRequestPolicy(value), /SIWC_REQUEST_POLICY_INVALID/);
  for (const value of [
    { responseHeadersTimeoutMs: 180000, maxRetries: 1 },
    { responseHeadersTimeoutMs: 360000, maxRetries: 0 },
    { responseHeadersTimeoutMs: 60000, maxRetries: 5 },
  ])
    assert.equal(
      normalizeRequestPolicy(value).responseHeadersTimeoutMs,
      value.responseHeadersTimeoutMs,
    );
});

test('effective policy can be revalidated without bypassing higher headers retry limits', () => {
  const valid = normalizePluginConfig({
    requestPolicy: { responseHeadersTimeoutMs: 180000, maxRetries: 1 },
  });
  assert.deepEqual(normalizePluginConfig(valid), valid);
  assert.deepEqual(normalizeRequestPolicy(valid.requestPolicy), valid.requestPolicy);
  assert.ok(Object.isFrozen(valid.requestPolicy));
  const defaults = normalizePluginConfig();
  assert.throws(
    () => normalizeRequestPolicy({ ...defaults.requestPolicy, responseHeadersTimeoutMs: 180000 }),
    /POLICY_INVALID/,
  );
  assert.throws(
    () => normalizeRequestPolicy({ responseHeadersTimeoutMs: 180000 }),
    /POLICY_INVALID/,
  );
});

test('public Config factory declares just requestPolicy and exposes its strict value validator', () => {
  const leaf = () => ({
    default() {
      return this;
    },
    description() {
      return this;
    },
  });
  const Schema = {
    number: leaf,
    boolean: leaf,
    any: leaf,
    object: (fields) => ({
      fields,
      default() {
        return this;
      },
    }),
    transform: (inner, validate) => ({ inner, validate }),
    intersect: (parts) => parts,
  };
  const config = createPluginConfig(Schema);
  assert.deepEqual(Object.keys(config[1].fields), ['requestPolicy']);
  assert.deepEqual(
    Object.keys(config[1].fields.requestPolicy.fields),
    Object.keys(DEFAULT_REQUEST_POLICY),
  );
  assert.throws(
    () => config[0].validate({ requestPolicy: { secret: 'PRIVATE' } }),
    /POLICY_INVALID/,
  );
  assert.deepEqual(config[0].validate({}), normalizePluginConfig());
});

test('adapter exposes detached finite normal retry policy; deterministic/lifecycle codes excluded', (t) => {
  const f = fixture(t, { requestPolicy: { maxRetries: 1, responseHeadersTimeoutMs: 180000 } });
  const policy = f.adapter.providerRetryPolicy(PROVIDER);
  assert.deepEqual(policy, {
    mode: 'normal',
    maxRetries: 1,
    retryableCodes: [...NORMAL_RETRY_CODES],
    initialDelayMs: 500,
    maxDelayMs: 10000,
    jitterRatio: 0.1,
  });
  policy.retryableCodes.push('PLUGIN_DISPOSED');
  assert.ok(!f.adapter.providerRetryPolicy(PROVIDER).retryableCodes.includes('PLUGIN_DISPOSED'));
  for (const code of [
    'STREAM_IDLE_TIMEOUT',
    'ACCOUNT_CHANGED',
    'NO_ADAPTER',
    'UNSUPPORTED_MAX_TOKENS',
  ])
    assert.ok(!f.adapter.providerRetryPolicy(PROVIDER).retryableCodes.includes(code));
  assert.throws(() => f.adapter.providerRetryPolicy('other-provider'), { code: 'NO_ADAPTER' });
});

test('headers deadline is exactly 60s, native-compatible TIMEOUT, no internal retries, late Response cancelled', async (t) => {
  const c = clock(t);
  const pending = deferred();
  const f = fixture(t, { respond: () => pending.promise });
  const prepared = await f.prepare();
  const chunks = collect(prepared.stream(options()));
  let settled = false;
  chunks.then(() => {
    settled = true;
  });
  await turn();
  assert.deepEqual([...c.active.values()], [60000]);
  await c.tick(59999);
  assert.equal(settled, false);
  await c.tick(1);
  assert.deepEqual(failure(await chunks), {
    code: 'TIMEOUT',
    message: 'SIWC_RESPONSE_HEADERS_TIMEOUT',
  });
  assert.equal(f.inferenceRequests.length, 1);
  const late = stalled({ neverCancel: true });
  pending.resolve(late.response);
  await turn();
  assert.equal(late.cancelled, 1);
  assert.equal(late.response.body.locked, false);
  await c.tick(360000);
  assert.equal(f.inferenceRequests.length, 1);
  c.empty();
});

test('headers arrival removes the old timer; default idle and from-headers 30min total remain independent', async (t) => {
  const c = clock(t);
  const pending = deferred();
  const stream = stalled();
  const f = fixture(t, { respond: () => pending.promise });
  const prepared = await f.prepare();
  const chunks = collect(prepared.stream(options()));
  let settled = false;
  chunks.then(() => {
    settled = true;
  });
  await turn();
  await c.tick(59999);
  pending.resolve(stream.response);
  await turn();
  assert.ok(c.durations.includes(1800000));
  assert.ok(c.durations.includes(120000));
  await c.tick(1); // The original headers deadline must not abort this stream.
  assert.equal(settled, false);
  await c.tick(119998);
  assert.equal(settled, false);
  await c.tick(1);
  assert.equal(failure(await chunks).code, 'STREAM_IDLE_TIMEOUT');
  assert.equal(stream.cancelled, 1);
  assert.equal(stream.response.body.locked, false);
  c.empty();
});

test('total clock starts on headers; intervening SSE resets idle but cannot extend stream total', async (t) => {
  const c = clock(t);
  const pending = deferred();
  const stream = stalled({ neverCancel: true });
  const f = fixture(t, {
    requestPolicy: {
      responseHeadersTimeoutMs: 60,
      streamIdleTimeoutMs: 50,
      streamTotalTimeoutMs: 100,
    },
    respond: () => pending.promise,
  });
  const prepared = await f.prepare();
  const chunks = collect(prepared.stream(options()));
  let settled = false;
  chunks.then(() => {
    settled = true;
  });
  await turn();
  await c.tick(40);
  pending.resolve(stream.response);
  await turn();
  for (let i = 0; i < 3; i++) {
    await c.tick(30);
    stream.push({ type: 'ping' });
    await turn();
    assert.equal(settled, false);
  }
  await c.tick(9);
  assert.equal(settled, false);
  await c.tick(1);
  assert.deepEqual(failure(await chunks), {
    code: 'TIMEOUT',
    message: 'SIWC_STREAM_TOTAL_TIMEOUT_FROM_HEADERS',
  });
  assert.equal(stream.cancelled, 1);
  assert.equal(stream.response.body.locked, false);
  c.empty();
});

test('legacy idleTimeoutMs injection still works and each received read resets idle', async (t) => {
  const c = clock(t);
  const stream = stalled();
  const f = fixture(t, { idleTimeoutMs: 30, respond: () => stream.response });
  const prepared = await f.prepare();
  const chunks = collect(prepared.stream(options()));
  let settled = false;
  chunks.then(() => {
    settled = true;
  });
  await turn();
  await c.tick(29);
  stream.bytes(': keepalive\n\n');
  await turn();
  await c.tick(29);
  assert.equal(settled, false);
  await c.tick(1);
  assert.equal(failure(await chunks).code, 'STREAM_IDLE_TIMEOUT');
  assert.equal(stream.cancelled, 1);
  c.empty();
});

for (const [label, code] of [
  ['user abort', 'ABORTED'],
  ['plugin disposal', 'PLUGIN_DISPOSED'],
  ['account switch', 'ACCOUNT_CHANGED'],
  ['account signout', 'ACCOUNT_SIGNED_OUT'],
])
  test(`${label} aborts an active stream, is not a network code and releases timers/reader`, async (t) => {
    const c = clock(t);
    const stream = stalled({ neverCancel: true });
    const caller = new AbortController();
    const f = fixture(t, { respond: () => stream.response });
    const prepared = await f.prepare();
    const chunks = collect(prepared.stream(options({ signal: caller.signal })));
    await turn();
    if (code === 'ABORTED') caller.abort(new Error('PRIVATE_CANCEL_REASON'));
    else if (code === 'PLUGIN_DISPOSED') f.adapter.dispose();
    else f.accountAbort.abort(new SiwcError(code));
    const result = await chunks;
    assert.equal(failure(result).code, code);
    assert.equal(result.at(-1).reason.kind, code === 'ABORTED' ? 'aborted' : 'error');
    assert.ok(!JSON.stringify(result).includes('PRIVATE_CANCEL_REASON'));
    assert.equal(stream.cancelled, 1);
    assert.equal(stream.response.body.locked, false);
    c.empty();
  });

test('pre-aborted caller performs no account/access/fetch work and produces one aborted finish', async (t) => {
  const c = clock(t);
  const f = fixture(t);
  const caller = new AbortController();
  caller.abort();
  assert.equal(
    failure(await collect(f.adapter.stream(options({ signal: caller.signal })))).code,
    'ABORTED',
  );
  assert.equal(f.accessCalls, 0);
  assert.equal(f.requests.length, 0);
  c.empty();
});

test('pre-aborted account signal and changed selection stop prepared calls before fetch', async (t) => {
  const c = clock(t);
  for (const change of ['abort', 'generation']) {
    const f = fixture(t);
    const prepared = await f.prepare();
    if (change === 'abort') f.accountAbort.abort(new SiwcError('ACCOUNT_SIGNED_OUT'));
    else f.change();
    const expected = change === 'abort' ? 'ACCOUNT_SIGNED_OUT' : 'ACCOUNT_CHANGED';
    assert.equal(failure(await collect(prepared.stream(options()))).code, expected);
    assert.equal(f.inferenceRequests.length, 0);
    c.empty();
  }
});

test('cancellation during pending auth/access is prompt but does not pretend to be a headers timeout', async (t) => {
  const c = clock(t);
  const f = fixture(t);
  const prepared = await f.prepare();
  f.sessions.access = () => new Promise(() => {});
  const caller = new AbortController();
  const chunks = collect(prepared.stream(options({ signal: caller.signal })));
  await turn();
  c.empty(); // No headers clock has started during access acquisition.
  caller.abort();
  assert.equal(failure(await chunks).code, 'ABORTED');
  assert.equal(f.inferenceRequests.length, 0);
  c.empty();
});

test('fetch success/abort race cannot consume a Response or report success after cancellation', async (t) => {
  const c = clock(t);
  const caller = new AbortController();
  const stream = stalled({ neverCancel: true });
  const f = fixture(t, {
    respond: () => {
      caller.abort();
      return stream.response;
    },
  });
  const prepared = await f.prepare();
  assert.equal(
    failure(await collect(prepared.stream(options({ signal: caller.signal })))).code,
    'ABORTED',
  );
  await turn();
  assert.equal(stream.cancelled, 1);
  assert.equal(stream.response.body.locked, false);
  c.empty();
});

test('transport rejection is sanitized and deterministic maxTokens failure never dispatches/retries', async (t) => {
  const c = clock(t);
  const f = fixture(t, { respond: () => Promise.reject(new Error('PRIVATE_TRANSPORT_DETAILS')) });
  const prepared = await f.prepare();
  assert.deepEqual(failure(await collect(prepared.stream(options()))), {
    code: 'TRANSPORT',
    message: 'TRANSPORT',
  });
  assert.equal(
    failure(await collect(prepared.stream(options({ maxTokens: 10, purpose: 'compaction' })))).code,
    'UNSUPPORTED_MAX_TOKENS',
  );
  assert.equal(f.inferenceRequests.length, 1);
  c.empty();
});

test('catalog headers timeout is still exactly 15s and cancels a late body', async (t) => {
  const c = clock(t);
  const pending = deferred();
  const f = fixture(t, { catalog: () => pending.promise });
  const result = f.adapter.listModels(PROVIDER);
  const checked = assert.rejects(result, { code: 'TIMEOUT', message: 'SIWC_CATALOG_TIMEOUT' });
  await turn();
  assert.deepEqual([...c.active.values()], [15000]);
  await c.tick(14999);
  assert.equal(f.requests.length, 1);
  await c.tick(1);
  await checked;
  const late = stalled();
  pending.resolve(late.response);
  await turn();
  assert.equal(late.cancelled, 1);
  assert.equal(late.response.body.locked, false);
  c.empty();
});

test('catalog body timeout cancels and releases even a never-resolving transport cancel promise', async (t) => {
  const c = clock(t);
  const stream = stalled({ neverCancel: true });
  const f = fixture(t, { catalog: () => stream.response });
  const checked = assert.rejects(f.adapter.listModels(PROVIDER), {
    code: 'TIMEOUT',
    message: 'SIWC_CATALOG_TIMEOUT',
  });
  await turn();
  await c.tick(15000);
  await checked;
  assert.equal(stream.cancelled, 1);
  assert.equal(stream.response.body.locked, false);
  c.empty();
});

test('catalog non-2xx body cannot reset/extend its original 15s headers+body budget', async (t) => {
  const c = clock(t);
  const pending = deferred();
  const stream = stalled({ status: 503, neverCancel: true });
  const f = fixture(t, { catalog: () => pending.promise });
  const checked = assert.rejects(f.adapter.listModels(PROVIDER), {
    code: 'TIMEOUT',
    message: 'SIWC_CATALOG_TIMEOUT',
  });
  await turn();
  await c.tick(14999);
  pending.resolve(stream.response);
  await turn();
  assert.deepEqual([...c.active.values()], [15000]);
  await c.tick(1);
  await checked;
  assert.equal(stream.cancelled, 1);
  assert.equal(stream.response.body.locked, false);
  assert.throws(() => stream.bytes('late'), { code: 'ERR_INVALID_STATE' });
  c.empty();
});

test('non-2xx body has a short from-headers deadline, never 30min; native TIMEOUT retains only status', async (t) => {
  const c = clock(t);
  const pending = deferred();
  const stream = stalled({ status: 403, neverCancel: true });
  const f = fixture(t, { requestPolicy: { catalogTimeoutMs: 15 }, respond: () => pending.promise });
  const prepared = await f.prepare();
  const chunks = collect(prepared.stream(options()));
  await turn();
  await c.tick(40);
  pending.resolve(stream.response);
  await turn();
  assert.deepEqual([...c.active.values()], [15]);
  await c.tick(15);
  assert.deepEqual(failure(await chunks), {
    message: 'SIWC_ERROR_BODY_TIMEOUT',
    code: 'TIMEOUT',
    status: 403,
  });
  assert.equal(stream.cancelled, 1);
  assert.equal(stream.response.body.locked, false);
  assert.ok(!c.durations.includes(1800000));
  c.empty();
});

test('ordinary HTTP errors retain native failure fields but never fabricated details/providerCode', async (t) => {
  const c = clock(t);
  const f = fixture(t, {
    respond: () =>
      Response.json(
        { error: { code: 'rate_limit_exceeded', message: 'PRIVATE_PROVIDER_ERROR' } },
        { status: 429, headers: { 'x-request-id': 'req_synthetic' } },
      ),
  });
  const prepared = await f.prepare();
  assert.deepEqual(failure(await collect(prepared.stream(options()))), {
    code: 'RATE_LIMIT',
    message: 'RATE_LIMIT',
    status: 429,
    requestId: 'req_synthetic',
  });
  c.empty();
});

test('successful terminal releases timers/reader before consumer resumes after finish', async (t) => {
  const c = clock(t);
  const stream = stalled({ neverCancel: true });
  const f = fixture(t, { respond: () => stream.response });
  const prepared = await f.prepare();
  const iterator = prepared.stream(options());
  const first = iterator.next();
  await turn();
  stream.push(completed());
  let next = await first;
  while (next.value.type !== 'finish') next = await iterator.next();
  assert.equal(next.value.reason.kind, 'stop');
  c.empty();
  assert.equal(stream.cancelled, 1);
  assert.equal(stream.response.body.locked, false);
  await c.tick(1800000);
  c.empty();
  await iterator.return();
});

test('generator return closes SSE reader/timers without awaiting transport cancel acknowledgement', async (t) => {
  const c = clock(t);
  const stream = stalled({ neverCancel: true });
  const logs = [];
  const f = fixture(t, {
    requestPolicy: { timing: true },
    logger: { info: (value) => logs.push(value) },
    respond: () => stream.response,
  });
  const prepared = await f.prepare();
  const iterator = prepared.stream(options());
  const first = iterator.next();
  await turn();
  stream.push({
    type: 'response.output_item.added',
    output_index: 0,
    item: { ...text(''), content: [] },
  });
  stream.push({
    type: 'response.output_text.delta',
    output_index: 0,
    content_index: 0,
    delta: 'PRIVATE_DELTA',
  });
  assert.equal((await first).value.type, 'block-start');
  await iterator.return();
  assert.equal(stream.cancelled, 1);
  assert.equal(stream.response.body.locked, false);
  assert.equal(JSON.parse(logs.at(-1).slice('SIWC_TIMING '.length)).code, 'CONSUMER_RETURN');
  c.empty();
});

test('opt-in timing logs ordered allowlisted metadata only, without body/account/session/headers/replay IDs', async (t) => {
  const c = clock(t);
  const logs = [];
  const f = fixture(t, {
    requestPolicy: { timing: true },
    logger: { info: (value) => logs.push(value) },
  });
  const prepared = await f.prepare();
  await collect(prepared.stream(options()));
  const records = logs.map((value) => {
    assert.ok(value.startsWith('SIWC_TIMING '));
    return JSON.parse(value.slice('SIWC_TIMING '.length));
  });
  assert.deepEqual(
    records.map((value) => value.stage),
    ['request-built', 'fetch-start', 'response-headers', 'first-sse', 'first-content', 'terminal'],
  );
  assert.equal(new Set(records.map((value) => value.callId)).size, 1);
  assert.match(records[0].callId, /^[0-9a-f-]{36}$/);
  assert.equal(records[0].requestBytes, Buffer.byteLength(f.inferenceRequests[0].body));
  assert.equal(records.at(-1).code, 'STOP');
  // Keep native wire usage semantics unchanged (uncached input plus cacheRead).
  assert.deepEqual(records.at(-1).usage, {
    inputTokens: 7,
    outputTokens: 7,
    totalTokens: 18,
    cacheReadTokens: 4,
  });
  for (const record of records) {
    assert.deepEqual(record.effectivePolicy, { ...DEFAULT_REQUEST_POLICY, timing: true });
    assert.ok(
      Object.keys(record).every((key) =>
        [
          'callId',
          'stage',
          'elapsedMs',
          'requestBytes',
          'usage',
          'code',
          'effectivePolicy',
        ].includes(key),
      ),
    );
    assert.ok(Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0);
  }
  assert.ok(!logs.join('').includes('PRIVATE_'));
  const oldId = records[0].callId;
  const offset = logs.length;
  await collect(prepared.stream(options()));
  assert.notEqual(JSON.parse(logs[offset].slice('SIWC_TIMING '.length)).callId, oldId);
  c.empty();
});

test('timing is off by default and throwing/rejecting loggers cannot affect inference', async (t) => {
  const c = clock(t);
  const logs = [];
  const off = fixture(t, { logger: { info: (value) => logs.push(value) } });
  await collect((await off.prepare()).stream(options()));
  assert.deepEqual(logs, []);
  for (const info of [
    () => {
      throw new Error('PRIVATE_LOGGER');
    },
    () => Promise.reject(new Error('PRIVATE_LOGGER')),
  ]) {
    const f = fixture(t, { requestPolicy: { timing: true }, logger: { info } });
    assert.equal((await collect((await f.prepare()).stream(options()))).at(-1).reason.kind, 'stop');
  }
  await turn();
  c.empty();
});

test('timing projection drops unrecognized stages, fields, usage and arbitrary error-code strings', () => {
  const logs = [];
  const trace = createTimingTrace(
    normalizeRequestPolicy({ timing: true }),
    { info: (value) => logs.push(value) },
    () => 1,
  );
  trace('PRIVATE_STAGE', { body: 'PRIVATE_BODY' });
  trace('terminal', {
    code: 'PRIVATE_ERROR_CODE',
    body: 'PRIVATE_BODY',
    requestBytes: NaN,
    usage: {
      inputTokens: 1,
      outputTokens: Infinity,
      token: 'PRIVATE_TOKEN',
      sessionId: 'PRIVATE_SESSION',
    },
  });
  trace('terminal', { code: 'STOP' });
  assert.equal(logs.length, 1);
  const result = JSON.parse(logs[0].slice('SIWC_TIMING '.length));
  assert.equal(result.code, 'OTHER');
  assert.deepEqual(result.usage, { inputTokens: 1 });
  assert.ok(!logs[0].includes('PRIVATE_'));
});

test('host validates policy before runtime creation and forwards exactly one public policy to adapter', async (t) => {
  let adapter,
    runtimeCalls = 0;
  const dispose = [];
  const ctx = {
    credentials: { readRecord() {}, modifyRecord() {}, listRecords() {} },
    connection: { fetch: { register() {} }, createSharedFetchHandler() {} },
    llm: {
      registerAdapter(providers, value) {
        assert.deepEqual(providers, [PROVIDER]);
        adapter = value;
        return { replace() {} };
      },
    },
    effect(start) {
      dispose.push(start());
    },
    on() {},
    logger: { info() {} },
  };
  const plugin = createHostPlugin(native, () => {
    runtimeCalls++;
    return { accounts: { selection: async () => undefined }, sessions: {}, protocol: {} };
  });
  // The native optional Config can pass root null through unchanged. apply
  // must reject it before runtime creation, including after that Schema step.
  for (const config of [
    null,
    { requestPolicy: null },
    { requestPolicy: { responseHeadersTimeoutMs: 180000 } },
  ])
    await assert.rejects(plugin.apply(ctx, config), /POLICY_INVALID/);
  assert.equal(runtimeCalls, 0);
  await plugin.apply(ctx, { requestPolicy: { responseHeadersTimeoutMs: 180000, maxRetries: 1 } });
  assert.equal(runtimeCalls, 1);
  assert.equal(adapter.providerRetryPolicy(PROVIDER).maxRetries, 1);
  t.after(async () => {
    for (const cleanup of dispose) await cleanup();
  });
});
