import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenAIProtocol,
  DISCOVERY,
  ISSUER,
  RESOURCE,
  TOKEN_ENDPOINT,
  DIRECT_SCOPE,
} from '../src/siwc/protocol.js';
import { AccountStore } from '../src/siwc/accounts.js';
import { SessionManager } from '../src/siwc/sessions.js';
import { createAdapterClass } from '../src/siwc/adapter.js';
import { PROVIDER } from '../src/siwc/controller.js';
import { CLIENT, NOW, MemoryCredentials, json, tokens } from './siwc-fixtures.js';

const failure = (code) =>
  new TypeError('PRIVATE_NETWORK_DETAILS', {
    cause: Object.assign(new Error('PRIVATE_TOKEN_AND_URL'), { code }),
  });
const exchange = (protocol, signal) =>
  protocol.exchange(
    {
      grant_type: 'refresh_token',
      client_id: CLIENT,
      refresh_token: 'synthetic-old-refresh',
      resource: RESOURCE,
    },
    signal,
  );
const reply = () => json(tokens({}, { id_token: undefined }));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const code of [
  'UND_ERR_CONNECT_TIMEOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
]) {
  test(`refresh recovers one confirmed pre-connect failure (${code})`, async () => {
    const requests = [];
    const protocol = new OpenAIProtocol({
      fetchImpl: async (url, init) => {
        requests.push({ url, ...init });
        if (requests.length === 1) throw failure(code);
        return reply();
      },
    });
    assert.equal((await exchange(protocol)).access_token, 'test-access-token');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body, requests[1].body);
    assert.equal(requests[0].signal, requests[1].signal);
    assert.ok(requests.every((r) => r.url === TOKEN_ENDPOINT && r.redirect === 'error'));
  });
}

for (const code of ['ECONNRESET', 'UND_ERR_SOCKET', 'ETIMEDOUT', undefined]) {
  test(`refresh never replays an ambiguous request (${code ?? 'unknown'})`, async () => {
    let calls = 0;
    const protocol = new OpenAIProtocol({
      fetchImpl: async () => {
        calls++;
        throw failure(code);
      },
    });
    await assert.rejects(exchange(protocol), (error) => {
      assert.equal(error.code, 'AUTH_REQUEST_UNCONFIRMED');
      assert.equal(error.message, error.code);
      assert.equal(JSON.stringify(error).includes('PRIVATE_'), false);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls, 1);
  });
}

test('persistent DNS failure has two attempts, a specific code, and no private exception details', async () => {
  let calls = 0;
  const protocol = new OpenAIProtocol({
    fetchImpl: async () => {
      calls++;
      throw failure('EAI_AGAIN');
    },
  });
  await assert.rejects(exchange(protocol), { code: 'AUTH_DNS_FAILED', message: 'AUTH_DNS_FAILED' });
  assert.equal(calls, 2);
});

test('TLS certificate failure is not retried or bypassed, even for discovery', async () => {
  let calls = 0;
  const protocol = new OpenAIProtocol({
    fetchImpl: async (_url, options) => {
      calls++;
      assert.equal(options.redirect, 'error');
      assert.equal(options.dispatcher, undefined);
      throw failure('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    },
  });
  await assert.rejects(protocol.metadata(), { code: 'AUTH_TLS_FAILED' });
  assert.equal(calls, 1);
});

test('read-only discovery safely retries a connection reset but never retries HTTP errors', async () => {
  let calls = 0;
  const protocol = new OpenAIProtocol({
    fetchImpl: async () => {
      if (++calls === 1) throw failure('ECONNRESET');
      return json({
        issuer: ISSUER,
        jwks_uri: `${ISSUER}/jwks`,
        revocation_endpoint: `${ISSUER}/revoke`,
        id_token_signing_alg_values_supported: ['RS256'],
      });
    },
  });
  assert.equal((await protocol.metadata()).issuer, ISSUER);
  assert.equal(calls, 2);
  calls = 0;
  const denied = new OpenAIProtocol({
    fetchImpl: async () => {
      calls++;
      return json({ error: 'invalid_grant' }, 400);
    },
  });
  await assert.rejects(exchange(denied), { code: 'INVALID_GRANT' });
  assert.equal(calls, 1);
});

test('mixed aggregate failures cannot turn an ambiguous refresh into a safe retry', async () => {
  let calls = 0;
  const protocol = new OpenAIProtocol({
    fetchImpl: async () => {
      calls++;
      throw new TypeError('PRIVATE', {
        cause: new AggregateError([
          failure('UND_ERR_CONNECT_TIMEOUT').cause,
          failure('ECONNRESET').cause,
        ]),
      });
    },
  });
  await assert.rejects(exchange(protocol), { code: 'AUTH_REQUEST_UNCONFIRMED' });
  assert.equal(calls, 1);
});

for (const topCode of ['ECONNREFUSED', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT']) {
  for (const variant of ['mixed', 'empty', 'oversized']) {
    test(`aggregate ${variant} cannot trust its top-level ${topCode}`, async () => {
      let calls = 0;
      const errors =
        variant === 'mixed'
          ? [failure('ECONNREFUSED').cause, failure('ECONNRESET').cause]
          : variant === 'empty'
            ? []
            : Array.from({ length: 9 }, () => failure('ECONNREFUSED').cause);
      const protocol = new OpenAIProtocol({
        fetchImpl: async () => {
          calls++;
          const aggregate = Object.assign(new AggregateError(errors), { code: topCode });
          throw new TypeError('PRIVATE', { cause: aggregate });
        },
      });
      await assert.rejects(exchange(protocol), { code: 'AUTH_REQUEST_UNCONFIRMED' });
      assert.equal(calls, 1);
    });
  }
}

for (const code of [
  'CERT_REVOKED',
  'UNABLE_TO_GET_ISSUER_CERT',
  'INVALID_CA',
  'CRL_HAS_EXPIRED',
  'PATH_LENGTH_EXCEEDED',
  'CERT_SIGNATURE_FAILURE',
  'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
  'ERROR_IN_CERT_NOT_AFTER_FIELD',
]) {
  test(`certificate verification ${code} is terminal even for a metadata read`, async () => {
    let calls = 0;
    const protocol = new OpenAIProtocol({
      fetchImpl: async () => {
        calls++;
        throw failure(code);
      },
    });
    await assert.rejects(protocol.metadata(), { code: 'AUTH_TLS_FAILED' });
    assert.equal(calls, 1);
  });
}

test('cancellation before dispatch does not call fetch', async () => {
  let calls = 0;
  const abort = new AbortController();
  abort.abort(new Error('PRIVATE_CANCELLATION'));
  const protocol = new OpenAIProtocol({
    fetchImpl: async () => {
      calls++;
      return reply();
    },
  });
  await assert.rejects(exchange(protocol, abort.signal), { code: 'CANCELLED' });
  assert.equal(calls, 0);
});

test('one total deadline bounds retries, including retry delay', async () => {
  let calls = 0;
  const protocol = new OpenAIProtocol({
    timeoutMs: 30,
    fetchImpl: async () => {
      calls++;
      throw failure('UND_ERR_CONNECT_TIMEOUT');
    },
  });
  await assert.rejects(protocol.request(DISCOVERY), { code: 'AUTH_NETWORK_TIMEOUT' });
  assert.equal(calls, 1);
});

test('deadline bounds a transport that ignores abort, and cancels its late response', async () => {
  let resolve,
    cancelled = 0;
  const pending = new Promise((yes) => {
    resolve = yes;
  });
  const hold = setTimeout(() => {}, 1000);
  try {
    const protocol = new OpenAIProtocol({ timeoutMs: 20, fetchImpl: () => pending });
    await assert.rejects(exchange(protocol), { code: 'AUTH_REQUEST_UNCONFIRMED' });
    resolve(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
      ),
    );
    await pause(0);
    assert.equal(cancelled, 1);
  } finally {
    clearTimeout(hold);
  }
});

class LlmError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.failure = { message, code };
  }
}
const Adapter = createAdapterClass({
  LlmAdapter: class {},
  LlmError,
  APP_IDENTITY: { version: '0.2.1-rc.2' },
  attributionHeaders: () => ({}),
});
async function selectedAccount(fetchImpl) {
  const accounts = new AccountStore(new MemoryCredentials());
  const key = await accounts.beginRegistration(CLIENT);
  await accounts.saveValidated({
    issuer: ISSUER,
    subject: 'test-subject',
    clientId: CLIENT,
    accessToken: 'synthetic-old-access',
    refreshToken: 'synthetic-old-refresh',
    idToken: 'validated-old-id',
    scopes: [DIRECT_SCOPE],
    expiresAt: NOW - 1000,
    savedAt: NOW - 3600000,
  });
  await accounts.select(key);
  const sessions = new SessionManager({
    accounts,
    protocol: new OpenAIProtocol({ fetchImpl, now: () => NOW }),
    now: () => NOW,
  });
  return { accounts, key, sessions };
}

test('model selection/preparation survives auth connect failure, rotates once, and sends no inference', async (t) => {
  let authCalls = 0,
    catalogCalls = 0;
  const f = await selectedAccount(async () => {
    if (++authCalls === 1) throw failure('UND_ERR_CONNECT_TIMEOUT');
    return reply();
  });
  const adapter = new Adapter({
    ...f,
    now: () => NOW,
    fetchImpl: async (url) => {
      assert.ok(url.endsWith('/models'), 'must not send inference during model preparation');
      catalogCalls++;
      return json({ models: [{ slug: 'test-model', visibility: 'list' }] });
    },
  });
  t.after(async () => {
    adapter.dispose();
    await f.sessions.dispose();
  });
  await adapter.prepareCall(PROVIDER, 'test-model');
  assert.equal(authCalls, 2);
  assert.equal(catalogCalls, 1);
  assert.equal((await f.accounts.registration(f.key)).refreshToken, 'test-refresh-token');
});

test('unrecoverable auth failure keeps authorization and gives model preparation an actionable message', async (t) => {
  let calls = 0;
  const f = await selectedAccount(async () => {
    calls++;
    throw failure('UND_ERR_CONNECT_TIMEOUT');
  });
  t.after(() => f.sessions.dispose());
  const before = await f.accounts.registration(f.key);
  const adapter = new Adapter({
    ...f,
    fetchImpl: async () => {
      throw new Error('must not reach catalog');
    },
  });
  t.after(() => adapter.dispose());
  await assert.rejects(adapter.prepareCall(PROVIDER, 'test-model'), (error) => {
    assert.equal(error.code, 'AUTH_CONNECT_FAILED');
    assert.match(error.message, /auth\.openai\.com/);
    assert.doesNotMatch(error.message, /PRIVATE_/);
    return true;
  });
  assert.equal(calls, 2);
  assert.deepEqual(await f.accounts.registration(f.key), before);
});

test('concurrent callers share one safe recovery and commit one rotating refresh', async (t) => {
  let calls = 0;
  const f = await selectedAccount(async () => {
    if (++calls === 1) throw failure('UND_ERR_CONNECT_TIMEOUT');
    return reply();
  });
  t.after(() => f.sessions.dispose());
  const results = await Promise.all(Array.from({ length: 12 }, () => f.sessions.access(f.key)));
  assert.equal(calls, 2);
  assert.ok(results.every((result) => result.accessToken === 'test-access-token'));
  assert.equal((await f.accounts.registration(f.key)).refreshToken, 'test-refresh-token');
});

test('ambiguous refresh failure is never replayed and does not erase the saved grant', async (t) => {
  let calls = 0;
  const f = await selectedAccount(async () => {
    calls++;
    throw failure('ECONNRESET');
  });
  t.after(() => f.sessions.dispose());
  const before = await f.accounts.registration(f.key);
  await assert.rejects(f.sessions.access(f.key), { code: 'AUTH_REQUEST_UNCONFIRMED' });
  assert.equal(calls, 1);
  assert.deepEqual(await f.accounts.registration(f.key), before);
});

test('caller cancellation during retry backoff stops the second exchange', async () => {
  let calls = 0,
    entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const abort = new AbortController();
  const protocol = new OpenAIProtocol({
    fetchImpl: async () => {
      calls++;
      entered();
      throw failure('UND_ERR_CONNECT_TIMEOUT');
    },
  });
  const result = assert.rejects(exchange(protocol, abort.signal), { code: 'CANCELLED' });
  await ready;
  await pause(0);
  abort.abort(new Error('PRIVATE_ABORT'));
  await result;
  assert.equal(calls, 1);
});

test('cancelling model preparation leaves its maintenance refresh to commit, without catalog or inference', async (t) => {
  let calls = 0,
    entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const f = await selectedAccount(async () => {
    if (++calls === 1) {
      entered();
      throw failure('UND_ERR_CONNECT_TIMEOUT');
    }
    return reply();
  });
  const adapter = new Adapter({
    ...f,
    fetchImpl: async () => {
      assert.fail('cancelled preparation must not dispatch catalog or inference');
    },
  });
  t.after(async () => {
    adapter.dispose();
    await f.sessions.dispose();
  });
  const abort = new AbortController();
  const result = assert.rejects(adapter.prepareCall(PROVIDER, 'test-model', abort.signal), {
    code: 'ABORTED',
  });
  await ready;
  await pause(0);
  abort.abort(new Error('PRIVATE_ABORT'));
  await result;
  await f.accounts.credentials.shared.queue;
  assert.equal(calls, 2);
  assert.equal((await f.accounts.registration(f.key)).refreshToken, 'test-refresh-token');
});

test('an aggregate retries only when every attempted address failed before connecting', async () => {
  let calls = 0;
  const protocol = new OpenAIProtocol({
    fetchImpl: async () => {
      if (++calls === 1) {
        const aggregate = new AggregateError([
          failure('UND_ERR_CONNECT_TIMEOUT').cause,
          failure('EHOSTUNREACH').cause,
        ]);
        aggregate.code = 'ETIMEDOUT';
        throw new TypeError('PRIVATE', { cause: aggregate });
      }
      return reply();
    },
  });
  assert.equal((await exchange(protocol)).access_token, 'test-access-token');
  assert.equal(calls, 2);
});
