import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapterClass } from '../src/siwc/adapter.js';
import { responsesBody, sessionAffinity } from '../src/siwc/wire.js';
import { PROVIDER } from '../src/siwc/controller.js';
class LlmError extends Error {
  constructor(message, code, detail = {}) {
    super(message);
    this.code = code;
    this.failure = { message, code, ...detail };
  }
}
const Adapter = createAdapterClass({
  LlmAdapter: class {},
  LlmError,
  attributionHeaders: () => ({ 'user-agent': 'DSH-affinity-regression' }),
});
function fixture() {
  let selected = { key: 'account-A', generation: 1 },
    tokenVersion = 0;
  const requests = [];
  const adapter = new Adapter({
    accounts: { selection: async () => selected },
    sessions: { access: async () => ({ accessToken: `MOCK-token-${++tokenVersion}` }) },
    fetchImpl: async (url, init) => {
      requests.push({
        url,
        headers: init.headers,
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      if (url.endsWith('/models'))
        return Response.json({ models: [{ slug: 'test-model', visibility: 'list' }] });
      const output = [
        {
          type: 'message',
          role: 'assistant',
          id: 'msg_cache_fixture',
          content: [{ type: 'output_text', text: 'OK', annotations: [] }],
        },
      ];
      const event = {
        type: 'response.completed',
        response: {
          id: 'resp_cache_fixture',
          status: 'completed',
          output,
          usage: {
            input_tokens: 2000,
            input_tokens_details: { cached_tokens: 1800 },
            output_tokens: 1,
          },
        },
      };
      return new Response(`data: ${JSON.stringify(event)}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  return {
    adapter,
    requests,
    setAccount: (key) => {
      selected = { key, generation: selected.generation + 1 };
    },
  };
}
const options = (sessionId) => ({
  provider: PROVIDER,
  model: 'test-model',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  ...(sessionId !== undefined ? { sessionId } : {}),
});
async function run(adapter, sessionId, prepared = false) {
  const call = prepared ? await adapter.prepareCall(PROVIDER, 'test-model') : adapter;
  const out = [];
  for await (const chunk of call.stream(options(sessionId))) out.push(chunk);
  assert.equal(out.at(-1).reason.kind, 'stop');
  return out;
}

test('affinity is deterministic, opaque, bounded, account/session scoped and rejects invalid contexts', () => {
  const value = sessionAffinity('private/session/中文', 'private-account');
  assert.match(value, /^dsh_[A-Za-z0-9_-]{43}$/);
  assert.equal(value, sessionAffinity('private/session/中文', 'private-account'));
  assert.notEqual(value, sessionAffinity('different-session', 'private-account'));
  assert.notEqual(value, sessionAffinity('private/session/中文', 'different-account'));
  assert.ok(!value.includes('private'));
  assert.equal(sessionAffinity(undefined, 'a'), undefined);
  for (const id of [null, 1, '', '  ', 'x'.repeat(16385)])
    assert.throws(() => sessionAffinity(id, 'a'), { code: 'INVALID_SESSION_CONTEXT' });
  assert.throws(() => sessionAffinity('s', undefined), { code: 'INVALID_SESSION_CONTEXT' });
  assert.doesNotThrow(() => new Headers({ session_id: sessionAffinity('path\r\n值', 'account') }));
});

test('wire emits the same derived prompt_cache_key without unsupported retention/options', () => {
  const body = responsesBody(options('session-A'), { accountKey: 'account-A' });
  assert.equal(body.prompt_cache_key, sessionAffinity('session-A', 'account-A'));
  assert.equal(body.store, false);
  assert.ok(!('prompt_cache_options' in body));
  assert.ok(!('prompt_cache_retention' in body));
});

test('real adapter and prepared-call path preserve affinity across turns and refreshed tokens', async (t) => {
  const f = fixture();
  t.after(() => f.adapter.dispose());
  await run(f.adapter, 'session-A');
  await run(f.adapter, 'session-A', true);
  const calls = f.requests.filter((r) => r.url.endsWith('/responses'));
  assert.equal(calls.length, 2);
  for (const r of calls) {
    assert.equal(r.headers.session_id, sessionAffinity('session-A', 'account-A'));
    assert.equal(r.headers['x-client-request-id'], r.headers.session_id);
    assert.equal(r.body.prompt_cache_key, r.headers.session_id);
    assert.equal(r.headers['user-agent'], 'DSH-affinity-regression');
  }
  assert.notEqual(calls[0].headers.authorization, calls[1].headers.authorization);
  assert.equal(calls[0].headers.session_id, calls[1].headers.session_id);
});

test('different sessions and accounts cannot accidentally share affinity', async (t) => {
  const f = fixture();
  t.after(() => f.adapter.dispose());
  await run(f.adapter, 'session-A');
  await run(f.adapter, 'session-B');
  f.setAccount('account-B');
  await run(f.adapter, 'session-A');
  assert.equal(
    new Set(f.requests.filter((r) => r.url.endsWith('/responses')).map((r) => r.headers.session_id))
      .size,
    3,
  );
});

test('model catalog calls do not acquire per-conversation headers', async (t) => {
  const f = fixture();
  t.after(() => f.adapter.dispose());
  await run(f.adapter, 'session-A');
  for (const r of f.requests.filter((r) => r.url.endsWith('/models'))) {
    assert.equal(r.headers.session_id, undefined);
    assert.equal(r.headers['x-client-request-id'], undefined);
  }
});

test('legacy non-session callers do not silently share a global cache identity', async (t) => {
  const f = fixture();
  t.after(() => f.adapter.dispose());
  await run(f.adapter);
  const r = f.requests.find((r) => r.url.endsWith('/responses'));
  assert.equal(r.headers.session_id, undefined);
  assert.equal(r.body.prompt_cache_key, undefined);
});

test('derived affinity remains identical after adapter recreation', async (t) => {
  const a = fixture(),
    b = fixture();
  t.after(() => {
    a.adapter.dispose();
    b.adapter.dispose();
  });
  await run(a.adapter, 'durable-session');
  await run(b.adapter, 'durable-session');
  assert.equal(a.requests.at(-1).headers.session_id, b.requests.at(-1).headers.session_id);
});

test('selection generation changes and account round trips do not rotate affinity', async (t) => {
  const f = fixture();
  t.after(() => f.adapter.dispose());
  await run(f.adapter, 'durable-main');
  f.setAccount('account-A');
  await run(f.adapter, 'durable-main', true);
  f.setAccount('account-B');
  await run(f.adapter, 'durable-main');
  f.setAccount('account-A');
  await run(f.adapter, 'durable-main');
  const requests = f.requests.filter((r) => r.url.endsWith('/responses'));
  assert.equal(requests[0].headers.session_id, requests[1].headers.session_id);
  assert.notEqual(requests[0].headers.session_id, requests[2].headers.session_id);
  assert.equal(requests[0].headers.session_id, requests[3].headers.session_id);
});
test('main and child sessions remain isolated under the same account', async (t) => {
  const f = fixture();
  t.after(() => f.adapter.dispose());
  await run(f.adapter, 'main-session');
  await run(f.adapter, 'child-session');
  const calls = f.requests.filter((r) => r.url.endsWith('/responses'));
  assert.notEqual(calls[0].body.prompt_cache_key, calls[1].body.prompt_cache_key);
});
