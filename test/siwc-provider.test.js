import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore } from '../src/siwc/accounts.js';
import { PROVIDER } from '../src/siwc/controller.js';
import { DIRECT_SCOPE, ISSUER, RESOURCE } from '../src/siwc/protocol.js';
import { createAdapterClass } from '../src/siwc/adapter.js';
import { ResponseStream, REPLAY_KIND, callId, responsesBody, sseEvents } from '../src/siwc/wire.js';
import { CLIENT, NOW, MemoryCredentials, json } from './siwc-fixtures.js';

class BaseAdapter {
  providerRetryPolicy() {}
}
class TestLlmError extends Error {
  constructor(message, code, detail = {}) {
    super(message);
    this.code = code;
    this.failure = { message, code, ...detail };
  }
}
const Adapter = createAdapterClass({
  LlmAdapter: BaseAdapter,
  LlmError: TestLlmError,
  attributionHeaders: () => ({ 'user-agent': 'DSH-test-attribution/0.2.0-rc.2' }),
});
const message = (role, text, extra = {}) => ({ role, content: [{ type: 'text', text }], ...extra });
const options = (messages = [message('user', 'hello')], extra = {}) => ({
  provider: PROVIDER,
  model: 'test-model',
  messages,
  ...extra,
});
const textItem = (text) => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  phase: 'final_answer',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const toolItem = {
  id: 'fc_test',
  type: 'function_call',
  call_id: 'call_test',
  name: 'calculate',
  arguments: '{"x":1}',
};
const complete = (output, extra = {}) => ({
  type: 'response.completed',
  response: {
    id: 'resp_test',
    status: 'completed',
    output,
    usage: { input_tokens: 20, output_tokens: 5, input_tokens_details: { cached_tokens: 3 } },
    ...extra,
  },
});
const encodeEvents = (events) =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
const streamResponse = (events) =>
  new Response(encodeEvents(events), {
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_test' },
  });
const collect = async (iterator) => {
  const chunks = [];
  for await (const chunk of iterator) chunks.push(chunk);
  return chunks;
};
const textEvents = (text) => [
  { type: 'response.created', response: { id: 'resp_test' } },
  { type: 'response.output_item.added', output_index: 0, item: { ...textItem(''), content: [] } },
  { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
  { type: 'response.output_item.done', output_index: 0, item: textItem(text) },
  complete([textItem(text)]),
];
async function setup({ response, models, idleTimeoutMs, noSelection = false, fetchOverride } = {}) {
  const credentials = new MemoryCredentials();
  const accounts = new AccountStore(credentials);
  const grant = {
    issuer: ISSUER,
    subject: 'test-subject',
    clientId: CLIENT,
    scopes: [DIRECT_SCOPE],
    accessToken: 'MOCK-account-access',
    refreshToken: 'MOCK-refresh',
    idToken: 'MOCK-id',
    expiresAt: NOW + 3600000,
    email: 'a@example.test',
  };
  const key = await accounts.beginRegistration(CLIENT);
  await accounts.saveValidated(grant);
  if (!noSelection) await accounts.select(key);
  const requests = [];
  const sessions = {
    access: async (selected, { signal }) => {
      assert.equal(selected, (await accounts.selection()).key);
      if (signal?.aborted) throw signal.reason;
      return { accessToken: (await accounts.registration(selected)).accessToken };
    },
  };
  const adapter = new Adapter({
    accounts,
    sessions,
    idleTimeoutMs,
    fetchImpl: async (url, init) => {
      requests.push({ url, ...init });
      if (fetchOverride) return fetchOverride(url, init);
      if (url === `${RESOURCE}/models`)
        return json(
          models ?? {
            models: [
              { slug: 'test-model', display_name: 'Account model', visibility: 'list' },
              { slug: 'hidden', visibility: 'hidden' },
              { slug: 'other-model', display_name: 'Other account model', visibility: 'list' },
            ],
          },
        );
      if (url === `${RESOURCE}/responses`)
        return response ? response(url, init) : streamResponse(textEvents('你好'));
      throw new Error('Unexpected destination');
    },
  });
  return { adapter, accounts, credentials, key, grant, requests };
}

test('model catalog is account-specific, ordered, visibility-filtered and attributed', async (t) => {
  const { adapter, requests } = await setup();
  t.after(() => adapter.dispose());
  const models = await adapter.listModels(PROVIDER);
  assert.deepEqual(
    models.map((model) => model.id),
    ['test-model', 'other-model'],
  );
  assert.deepEqual(models[0].inputModalities, ['text']);
  assert.equal(models[0].name, 'Account model');
  assert.equal(requests[0].url, 'https://api.openai.com/v1/models');
  assert.equal(requests[0].headers.authorization, 'Bearer MOCK-account-access');
  assert.match(requests[0].headers['user-agent'], /^DSH-test-attribution/);
  assert.equal(requests[0].redirect, 'error');
  models[0].name = 'mutated-by-caller';
  assert.equal((await adapter.listModels(PROVIDER))[0].name, 'Account model');
  assert.equal(requests.length, 1);
  await assert.rejects(adapter.resolveModel(PROVIDER, 'not-in-this-account'), {
    code: 'UNKNOWN_MODEL',
  });
});

test('realistic rich catalog has a separate bound from OAuth JSON', async (t) => {
  const { adapter } = await setup({
    models: { models: [{ slug: 'test-model', visibility: 'list', metadata: 'x'.repeat(700000) }] },
  });
  t.after(() => adapter.dispose());
  assert.equal((await adapter.listModels(PROVIDER))[0].id, 'test-model');
});

test('oversized catalog is rejected with a redacted UI notice', async (t) => {
  const { adapter } = await setup({
    models: {
      models: [{ slug: 'test-model', visibility: 'list', metadata: 'x'.repeat(8 * 1024 * 1024) }],
    },
  });
  t.after(() => adapter.dispose());
  await assert.rejects(adapter.listModels(PROVIDER), { code: 'RESPONSE_TOO_LARGE' });
  assert.deepEqual(adapter.notice, { code: 'RESPONSE_TOO_LARGE' });
});

for (const supportsSummary of [false, true])
  test(`actual catalog reasoning options and conditional summary (${supportsSummary}) reach Responses`, async (t) => {
    const { adapter, requests } = await setup({
      models: {
        models: [
          {
            slug: 'test-model',
            visibility: 'list',
            supported_reasoning_levels: [
              { effort: 'low', description: 'Fast' },
              { effort: 'high', description: 'Deep' },
            ],
            default_reasoning_level: 'high',
            supports_reasoning_summary_parameter: supportsSummary,
          },
        ],
      },
    });
    t.after(() => adapter.dispose());
    const model = (await adapter.listModels(PROVIDER))[0];
    assert.deepEqual(model.reasoning, {
      efforts: [
        { id: 'low', name: 'Low', description: 'Fast' },
        { id: 'high', name: 'High', description: 'Deep' },
      ],
      defaultEffort: 'high',
    });
    await collect(adapter.stream(options(undefined, { reasoningEffort: 'low' })));
    assert.deepEqual(
      JSON.parse(requests.find((r) => r.url.endsWith('/responses')).body).reasoning,
      { effort: 'low', ...(supportsSummary ? { summary: 'auto' } : {}) },
    );
  });

for (const levels of [[{ effort: 'high' }, { effort: 'high' }], [{ effort: 'invalid effort' }]])
  test('malformed reasoning capability is rejected, not advertised', async (t) => {
    const { adapter } = await setup({
      models: {
        models: [{ slug: 'test-model', visibility: 'list', supported_reasoning_levels: levels }],
      },
    });
    t.after(() => adapter.dispose());
    await assert.rejects(adapter.listModels(PROVIDER), { code: 'MODEL_CATALOG_INVALID' });
  });

test('unauthenticated source has no invented static model catalog', async (t) => {
  const { adapter, requests } = await setup({ noSelection: true });
  t.after(() => adapter.dispose());
  assert.deepEqual(await adapter.listModels(PROVIDER), []);
  assert.equal(requests.length, 0);
  await assert.rejects(adapter.prepareCall(PROVIDER, 'test-model'), {
    code: 'ACCOUNT_REAUTH_REQUIRED',
  });
});

for (const [name, models] of [
  ['API-style data instead of models', { data: [{ id: 'test-model' }] }],
  [
    'duplicate IDs',
    {
      models: [
        { slug: 'a', visibility: 'list' },
        { slug: 'a', visibility: 'list' },
      ],
    },
  ],
  ['unsafe slug', { models: [{ slug: '\nmalformed', visibility: 'list' }] }],
])
  test(`catalog rejects ${name}`, async (t) => {
    const { adapter } = await setup({ models });
    t.after(() => adapter.dispose());
    await assert.rejects(adapter.listModels(PROVIDER), { code: 'MODEL_CATALOG_INVALID' });
  });

test('stateless empty terminal aggregate requires finalized contiguous streamed items', async (t) => {
  const good = await setup({
    response: () => streamResponse([...textEvents('OK').slice(0, -1), complete([])]),
  });
  t.after(() => good.adapter.dispose());
  const chunks = await collect(good.adapter.stream(options()));
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  assert.equal(chunks.at(-1).replayState.response.output[0].content[0].text, 'OK');
  for (const events of [
    textEvents('unfinished')
      .filter((e) => e.type !== 'response.output_item.done')
      .map((e) => (e.type === 'response.completed' ? complete([]) : e)),
    [{ type: 'response.output_item.done', output_index: 1, item: textItem('gap') }, complete([])],
  ]) {
    const bad = await setup({ response: () => streamResponse(events) });
    t.after(() => bad.adapter.dispose());
    assert.equal((await collect(bad.adapter.stream(options()))).at(-1).reason.kind, 'error');
  }
});

test('generic transport MIME cannot hide valid SSE or authorize a plain JSON response', async (t) => {
  const good = await setup({
    response: () =>
      new Response(encodeEvents(textEvents('OK')), {
        headers: { 'content-type': 'application/octet-stream' },
      }),
  });
  t.after(() => good.adapter.dispose());
  assert.equal((await collect(good.adapter.stream(options()))).at(-1).reason.kind, 'stop');
  const bad = await setup({
    response: () => new Response(JSON.stringify(complete([textItem('not SSE')]))),
  });
  t.after(() => bad.adapter.dispose());
  const chunks = await collect(bad.adapter.stream(options()));
  assert.equal(chunks.at(-1).reason.kind, 'error');
  assert.equal(chunks.at(-1).reason.failure.code, 'STREAM_CLOSED');
});

test('Responses call is public, stream/store constrained, and translates terminal usage', async (t) => {
  const { adapter, requests } = await setup();
  t.after(() => adapter.dispose());
  const chunks = await collect(adapter.stream(options()));
  assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1);
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  assert.deepEqual(chunks.find((chunk) => chunk.type === 'usage').usage, {
    inputTokens: 17,
    outputTokens: 5,
    totalTokens: 25,
    cacheReadTokens: 3,
  });
  assert.equal(chunks.find((chunk) => chunk.type === 'text-delta').text, '你好');
  const request = requests.find((request) => request.url.endsWith('/responses'));
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.method, 'POST');
  assert.match(request.headers['user-agent'], /^DSH-test-attribution/);
  const body = JSON.parse(request.body);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.model, 'test-model');
  assert.deepEqual(body.input, [
    { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
  ]);
  assert.ok(!JSON.stringify(body).includes('MOCK-account-access'));
  assert.ok(!requests.some((request) => request.url.includes('backend-api')));
});

test('function arguments stream raw JSON; tool seals only after successful response.completed', async (t) => {
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { ...toolItem, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"x":' },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '1}' },
    { type: 'response.output_item.done', output_index: 0, item: toolItem },
    complete([toolItem]),
  ];
  const state = new ResponseStream({ accountKey: 'account', model: 'test-model' });
  const beforeTerminal = events.slice(0, -1).flatMap((event) => [...state.event(event)]);
  assert.equal(
    beforeTerminal.some((chunk) => chunk.type === 'block-end'),
    false,
  );
  const { adapter, requests } = await setup({ response: () => streamResponse(events) });
  t.after(() => adapter.dispose());
  const chunks = await collect(
    adapter.stream(
      options(undefined, {
        tools: [
          {
            name: 'calculate',
            parameters: { type: 'object', properties: { x: { type: 'number' } } },
          },
        ],
      }),
    ),
  );
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
  const result = chunks.find((chunk) => chunk.type === 'block-end').block;
  assert.deepEqual(result, {
    type: 'tool-call',
    id: 'call_test',
    name: 'calculate',
    arguments: '{"x":1}',
  });
  const body = JSON.parse(requests.at(-1).body);
  assert.equal(body.tools[0].type, 'namespace');
  assert.equal(body.tools[0].name, 'dsh');
  assert.equal(body.tools[0].tools[0].type, 'function');
  assert.equal(body.tools[0].tools[0].strict, false);
  const next = responsesBody(
    options([
      { role: 'assistant', content: [result] },
      message('tool', '2', { toolCallId: result.id }),
      message('user', 'continue'),
    ]),
    { accountKey: 'account' },
  );
  assert.equal(next.input[0].call_id, next.input[1].call_id);
  assert.equal(next.input[1].type, 'function_call_output');
  assert.equal(next.input[1].output, '2');
});

test('native encrypted reasoning and message phase replay only on same account/model and intact contents', () => {
  const native = [
    {
      type: 'reasoning',
      id: 'rs_test',
      summary: [],
      encrypted_content: 'MOCK-encrypted-reasoning',
    },
    { ...textItem('checking'), phase: 'commentary' },
    toolItem,
  ];
  const state = new ResponseStream({ accountKey: 'account-A', model: 'test-model' });
  const chunks = [...state.event(complete(native))];
  const terminal = chunks.at(-1);
  const contents = chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block);
  const previous = {
    role: 'assistant',
    source: { provider: PROVIDER, model: 'test-model', replayState: terminal.replayState },
    content: contents,
  };
  const intact = responsesBody(options([previous]), { accountKey: 'account-A' });
  assert.equal(intact.input[0].encrypted_content, 'MOCK-encrypted-reasoning');
  assert.equal(intact.input[1].phase, 'commentary');
  const switched = responsesBody(options([previous]), { accountKey: 'account-B' });
  assert.ok(!JSON.stringify(switched).includes('MOCK-encrypted-reasoning'));
  const differentModel = responsesBody(options([previous], { model: 'other-model' }), {
    accountKey: 'account-A',
  });
  assert.ok(!JSON.stringify(differentModel).includes('MOCK-encrypted-reasoning'));
  const edited = structuredClone(previous);
  edited.content[0].text = 'edited';
  assert.ok(
    !JSON.stringify(responsesBody(options([edited]), { accountKey: 'account-A' })).includes(
      'MOCK-encrypted-reasoning',
    ),
  );
});

test('foreign provider tool IDs normalize consistently without carrying foreign reasoning signatures', () => {
  const originalId = 'call_native|fc_native';
  const body = responsesBody(
    options([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'foreign private thinking' },
          { type: 'tool-call', id: originalId, name: 'lookup', arguments: '{}' },
        ],
      },
      message('tool', 'result', { toolCallId: originalId }),
    ]),
    { accountKey: 'account' },
  );
  assert.equal(body.input[0].call_id, 'call_native');
  assert.equal(body.input[1].call_id, 'call_native');
  assert.ok(!JSON.stringify(body).includes('foreign private thinking'));
  assert.equal(callId('nonstandard id'), callId('nonstandard id'));
  assert.match(callId('nonstandard id'), /^call_/);
  assert.throws(
    () =>
      responsesBody(
        options([
          {
            role: 'assistant',
            content: [
              { type: 'tool-call', id: 'same|one', name: 'x', arguments: '{}' },
              { type: 'tool-call', id: 'same|two', name: 'x', arguments: '{}' },
            ],
          },
        ]),
        { accountKey: 'account' },
      ),
    { code: 'INVALID_TOOL_HISTORY' },
  );
});

test('preview maps system history to developer, namespaces tools and rejects forbidden tuning fields', () => {
  const body = responsesBody(
    options(
      [
        message('system', 'system history'),
        message('developer', 'developer update'),
        message('tool', 'failed', { toolCallId: 'call_test', isError: true }),
      ],
      { system: 'top level', reasoningEffort: 'low' },
    ),
    { accountKey: 'account' },
  );
  assert.equal(body.instructions, 'top level');
  assert.equal(body.input[0].role, 'developer');
  assert.equal(body.input[1].role, 'developer');
  assert.match(body.input[2].output, /Tool error/);
  assert.equal('max_output_tokens' in body, false);
  assert.equal('temperature' in body, false);
  assert.deepEqual(body.reasoning, { effort: 'low' });
  assert.throws(
    () => responsesBody(options(undefined, { maxTokens: 123 }), { accountKey: 'account' }),
    { code: 'UNSUPPORTED_MAX_TOKENS' },
  );
  assert.throws(
    () => responsesBody(options(undefined, { temperature: 0.5 }), { accountKey: 'account' }),
    { code: 'UNSUPPORTED_TEMPERATURE' },
  );
  assert.throws(() => responsesBody(options(undefined, { stop: [] }), { accountKey: 'account' }), {
    code: 'UNSUPPORTED_OPTION',
  });
  assert.throws(
    () =>
      responsesBody(options([{ role: 'user', content: [{ type: 'image' }] }]), {
        accountKey: 'account',
      }),
    { code: 'UNSUPPORTED_CONTENT' },
  );
});

for (const [name, events, expected] of [
  ['stream ends without terminal', textEvents('partial').slice(0, -1), 'STREAM_CLOSED'],
  [
    'late quota failure',
    [
      {
        type: 'response.failed',
        response: {
          error: {
            code: 'subscription_sharing_usage_limit_exceeded',
            message: 'DO_NOT_ECHO_INPUT',
          },
        },
      },
    ],
    'QUOTA',
  ],
  [
    'usage availability not quota exhaustion',
    [
      {
        type: 'response.failed',
        response: { error: { code: 'subscription_sharing_usage_unavailable' } },
      },
    ],
    'SERVER',
  ],
  [
    'incomplete output',
    [
      {
        type: 'response.incomplete',
        response: { incomplete_details: { reason: 'max_output_tokens' } },
      },
    ],
    'RESPONSE_INCOMPLETE',
  ],
  ['empty completed output', [complete([])], 'EMPTY_RESPONSE'],
  [
    'mismatched response ID',
    [{ type: 'response.created', response: { id: 'resp_other' } }, complete([textItem('x')])],
    'INVALID_STREAM',
  ],
  [
    'changed terminal text',
    [...textEvents('original').slice(0, -1), complete([textItem('changed')])],
    'INVALID_STREAM',
  ],
])
  test(`non-success is not reported as completed: ${name}`, async (t) => {
    const { adapter } = await setup({ response: () => streamResponse(events) });
    t.after(() => adapter.dispose());
    const chunks = await collect(adapter.stream(options()));
    assert.equal(chunks.at(-1).type, 'finish');
    assert.equal(chunks.at(-1).reason.kind, 'error');
    assert.equal(chunks.at(-1).reason.failure.code, expected);
    assert.ok(!JSON.stringify(chunks).includes('DO_NOT_ECHO_INPUT'));
    assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1);
  });

test('HTTP status, structured provider code and request ID survive sanitized failure mapping', async (t) => {
  const { adapter } = await setup({
    response: () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'subscription_sharing_user_not_eligible',
            message: 'SECRET_PROMPT',
            param: 'model',
          },
        }),
        { status: 403, headers: { 'x-request-id': 'req_failure' } },
      ),
  });
  t.after(() => adapter.dispose());
  const failure = (await collect(adapter.stream(options()))).at(-1).reason.failure;
  assert.equal(failure.status, 403);
  assert.equal(failure.code, 'CHATGPT_NOT_ELIGIBLE');
  assert.equal(failure.providerCode, 'subscription_sharing_user_not_eligible');
  assert.equal(failure.requestId, 'req_failure');
  assert.ok(!JSON.stringify(failure).includes('SECRET_PROMPT'));
});

test('prepared calls cannot cross an account generation or silently change billing source', async (t) => {
  const { adapter, accounts, key, requests } = await setup();
  t.after(() => adapter.dispose());
  const prepared = await adapter.prepareCall(PROVIDER, 'test-model');
  await accounts.select(key); // Same account, new explicit generation.
  const chunks = await collect(prepared.stream(options()));
  assert.equal(chunks.at(-1).reason.failure.code, 'ACCOUNT_CHANGED');
  assert.equal(requests.filter((request) => request.url.endsWith('/responses')).length, 0);
});

test('SSE parser handles every-byte UTF-8 fragmentation, CRLF, comments and multiline data', async () => {
  const source =
    ': keepalive\r\nevent: ping\r\ndata: {"type":\r\ndata: "ping", "text":"中文"}\r\n\r\n';
  const bytes = new TextEncoder().encode(source);
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index < bytes.length) controller.enqueue(bytes.slice(index, ++index));
      else controller.close();
    },
  });
  assert.deepEqual(await collect(sseEvents(body)), [{ type: 'ping', text: '中文' }]);
});

test('SSE parser rejects event name confusion, partial terminal and oversized events', async () => {
  for (const [source, code] of [
    ['event: response.completed\ndata: {"type":"response.failed"}\n\n', 'INVALID_STREAM'],
    ['data: {"type":"response.completed"}', 'STREAM_CLOSED'],
    ['data: ' + 'x'.repeat(100) + '\n\n', 'STREAM_EVENT_TOO_LARGE'],
  ])
    await assert.rejects(collect(sseEvents(new Response(source).body, { maxEventBytes: 80 })), {
      code,
    });
});

test('stream stalls and caller cancellation produce one failure and cancel the reader', async (t) => {
  let cancelled = 0;
  const { adapter } = await setup({
    idleTimeoutMs: 15,
    response: () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  t.after(() => adapter.dispose());
  const stalled = await collect(adapter.stream(options()));
  assert.equal(stalled.at(-1).reason.failure.code, 'STREAM_IDLE_TIMEOUT');
  assert.equal(cancelled, 1);
  const abort = new AbortController();
  abort.abort();
  const chunks = await collect(adapter.stream(options(undefined, { signal: abort.signal })));
  assert.equal(chunks.at(-1).reason.kind, 'aborted');
  assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1);
});
