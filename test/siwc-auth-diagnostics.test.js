import test from 'node:test';
import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { observeAuthRequest, formatAuthDiagnostic } from '../src/siwc/auth-diagnostics.js';
import { requestAuth } from '../src/siwc/auth-network.js';
import { OpenAIProtocol, TOKEN_ENDPOINT } from '../src/siwc/protocol.js';
import { CLIENT, NOW } from './siwc-fixtures.js';

const publish = (name, value) => channel('undici:' + name).publish(value);
const socketFailure = (code) =>
  new TypeError('PRIVATE_URL_AND_TOKEN', {
    cause: Object.assign(Error('PRIVATE_RESPONSE'), { code }),
  });
const previous = { clientId: CLIENT, refreshToken: 'PRIVATE_REFRESH_TOKEN', expiresAt: NOW - 1 };
const created = () => {
  const request = {
    origin: 'https://auth.openai.com',
    path: '/api/accounts/oauth/token',
    method: 'POST',
    body: 'PRIVATE_BODY',
  };
  publish('request:create', { request });
  return request;
};
const expired = { phase: 'refresh', tokenState: 'expired' };

function noPrivateData(value) {
  assert.doesNotMatch(
    JSON.stringify(value),
    /PRIVATE|https?:|client_id|refresh_token|headers|body\"|account/i,
  );
}

test('observation preserves arguments, errors and this; only fixed metadata survives', async () => {
  const failure = socketFailure('ECONNRESET');
  const init = { method: 'POST', body: 'PRIVATE_TOKEN_FORM', signal: new AbortController().signal };
  const observer = observeAuthRequest(
    async function (url, options) {
      assert.equal(this, undefined);
      assert.equal(url, TOKEN_ENDPOINT);
      assert.equal(options, init);
      const request = created();
      publish('client:beforeConnect', {});
      publish('client:connected', {});
      publish('request:bodySent', { request });
      throw failure;
    },
    TOKEN_ENDPOINT,
    expired,
    { env: { HTTPS_PROXY: 'http://PRIVATE_USER:PRIVATE_PASSWORD@private.invalid' } },
  );
  try {
    await assert.rejects(observer.fetch(TOKEN_ENDPOINT, init), (error) => error === failure);
    const diagnostic = observer.snapshot('AUTH_REQUEST_UNCONFIRMED', 12000);
    assert.equal(diagnostic.stage, 'body_sent');
    assert.equal(diagnostic.proxy.https, true);
    assert.deepEqual(diagnostic.transportCodes, ['ECONNRESET']);
    assert.equal(diagnostic.attempts, 1);
    assert.equal(Object.isFrozen(diagnostic), true);
    noPrivateData(diagnostic);
    noPrivateData(formatAuthDiagnostic(diagnostic));
  } finally {
    observer.dispose();
  }
});

test('disabled diagnostics retain the original small error surface', async () => {
  const protocol = new OpenAIProtocol({
    fetchImpl: async () => {
      throw socketFailure('ECONNRESET');
    },
  });
  await assert.rejects(protocol.refresh(previous), (error) => {
    assert.equal(error.code, 'AUTH_REQUEST_UNCONFIRMED');
    assert.equal(error.authDiagnostic, undefined);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('protocol captures only the first failure, not another copy per failed call', async () => {
  let calls = 0;
  const protocol = new OpenAIProtocol({
    now: () => NOW,
    diagnostics: true,
    fetchImpl: async () => {
      const request = created();
      publish('request:bodySent', { request });
      throw socketFailure(++calls === 1 ? 'ECONNRESET' : 'UND_ERR_SOCKET');
    },
  });
  let first;
  for (let i = 0; i < 2; i++)
    await assert.rejects(protocol.refresh(previous), (error) => {
      assert.equal(error.code, 'AUTH_REQUEST_UNCONFIRMED');
      assert.equal(error.cause, undefined);
      assert.equal(error.authDiagnostic.phase, 'refresh');
      assert.equal(error.authDiagnostic.tokenState, 'expired');
      assert.deepEqual(error.authDiagnostic.transportCodes, ['ECONNRESET']);
      if (i === 0) first = error.authDiagnostic;
      else assert.equal(error.authDiagnostic, first);
      noPrivateData(error);
      return true;
    });
  assert.equal(calls, 2, 'two explicit calls, not an automatic replay');
});

test('safe pre-connect retry keeps its existing two-attempt bound', async () => {
  let calls = 0;
  const protocol = new OpenAIProtocol({
    now: () => NOW,
    diagnostics: true,
    fetchImpl: async () => {
      throw socketFailure(++calls === 1 ? 'ENOTFOUND' : 'ECONNRESET');
    },
  });
  await assert.rejects(protocol.refresh(previous), (error) => {
    assert.equal(error.authDiagnostic.attempts, 2);
    assert.deepEqual(error.authDiagnostic.transportCodes, ['ENOTFOUND', 'ECONNRESET']);
    return true;
  });
  assert.equal(calls, 2);
});

test('timeout records the deadline without replaying or inventing a socket error', async () => {
  let calls = 0;
  const protocol = new OpenAIProtocol({
    now: () => NOW,
    diagnostics: true,
    timeoutMs: 15,
    fetchImpl: async (_url, init) => {
      calls++;
      return new Promise((_, reject) => {
        const keepAlive = setTimeout(() => reject(Error('synthetic late result')), 150);
        init.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(keepAlive);
            reject(init.signal.reason);
          },
          { once: true },
        );
      });
    },
  });
  await assert.rejects(protocol.refresh(previous), (error) => {
    assert.equal(error.code, 'AUTH_REQUEST_UNCONFIRMED');
    assert.equal(error.authDiagnostic.timeout, true);
    assert.equal(error.authDiagnostic.stage, 'fetch_started');
    assert.equal(error.authDiagnostic.budgetMs, 15);
    assert.ok(error.authDiagnostic.elapsedMs >= 10);
    assert.deepEqual(error.authDiagnostic.transportCodes, []);
    return true;
  });
  assert.equal(calls, 1);
});

test('terminal HTTP errors and cancellation do not consume the one transport diagnostic', async () => {
  let terminal = true;
  const protocol = new OpenAIProtocol({
    now: () => NOW,
    diagnostics: true,
    fetchImpl: async () => {
      if (terminal) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      throw socketFailure('ECONNRESET');
    },
  });
  await assert.rejects(
    protocol.refresh(previous),
    (error) => error.code === 'INVALID_GRANT' && error.authDiagnostic === undefined,
  );
  const cancelled = new AbortController();
  cancelled.abort(Error('PRIVATE_CANCELLATION'));
  await assert.rejects(
    protocol.refresh(previous, cancelled.signal),
    (error) => error.code === 'CANCELLED' && error.authDiagnostic === undefined,
  );
  terminal = false;
  await assert.rejects(
    protocol.refresh(previous),
    (error) => error.authDiagnostic?.outcome === 'AUTH_REQUEST_UNCONFIRMED',
  );
});

test('concurrent observers ignore each other and foreign request events; subscriptions are removed', async () => {
  const before = channel('undici:request:create').hasSubscribers;
  const observe = (code) =>
    observeAuthRequest(
      async () => {
        const request = created();
        await new Promise((resolve) => setTimeout(resolve, 2));
        publish('request:bodySent', { request });
        throw socketFailure(code);
      },
      TOKEN_ENDPOINT,
      expired,
    );
  const a = observe('ECONNRESET'),
    b = observe('UND_ERR_SOCKET');
  try {
    await Promise.allSettled([a.fetch(TOKEN_ENDPOINT, {}), b.fetch(TOKEN_ENDPOINT, {})]);
    assert.deepEqual(a.snapshot('AUTH_REQUEST_UNCONFIRMED', 12000).transportCodes, ['ECONNRESET']);
    assert.deepEqual(b.snapshot('AUTH_REQUEST_UNCONFIRMED', 12000).transportCodes, [
      'UND_ERR_SOCKET',
    ]);
    const foreign = created();
    publish('request:headers', { request: foreign });
    assert.equal(a.snapshot('AUTH_REQUEST_UNCONFIRMED', 12000).stage, 'body_sent');
  } finally {
    a.dispose();
    b.dispose();
  }
  assert.equal(channel('undici:request:create').hasSubscribers, before);
});

test('actual Node fetch stages are observed against a disposable local server, no real upstream', async () => {
  const server = createServer((request) => request.resume());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/token`;
  const observer = observeAuthRequest(globalThis.fetch, url, expired);
  try {
    await assert.rejects(
      requestAuth(observer.fetch, url, { method: 'POST', body: 'synthetic' }, 500),
      { code: 'AUTH_REQUEST_UNCONFIRMED' },
    );
    const diagnostic = observer.snapshot('AUTH_REQUEST_UNCONFIRMED', 500);
    assert.equal(diagnostic.stage, 'body_sent');
    assert.equal(diagnostic.timeout, true);
    assert.equal(diagnostic.attempts, 1);
    noPrivateData(diagnostic);
  } finally {
    observer.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('formatter never serializes unknown fields, getters or toJSON hooks', () => {
  const diagnostic = {
    schema: 1,
    outcome: 'AUTH_REQUEST_UNCONFIRMED',
    phase: 'PRIVATE_PHASE',
    tokenState: 'PRIVATE_STATE',
    stage: 'PRIVATE_STAGE',
    transportCodes: ['ECONNRESET', 'PRIVATE_CODE'],
    privateToken: 'PRIVATE_TOKEN',
    proxy: { http: 'PRIVATE_PROXY', https: true },
    toJSON() {
      throw Error('must not execute');
    },
  };
  const formatted = formatAuthDiagnostic(diagnostic);
  assert.match(formatted, /ECONNRESET/);
  assert.match(formatted, /unknown/);
  noPrivateData(formatted);
  assert.equal(
    formatAuthDiagnostic({
      get schema() {
        throw Error('PRIVATE');
      },
    }),
    '',
  );
  assert.equal(formatAuthDiagnostic({ schema: 1, outcome: 'PRIVATE_CODE' }), '');
});
