import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import {
  AGENT_NAME,
  AUTHORIZE,
  DIRECT_SCOPE,
  DISCOVERY,
  DYNAMIC_CLIENT_ID,
  ISSUER,
  RESOURCE,
  SCOPES,
  TOKEN_ENDPOINT,
  OpenAIProtocol,
  SiwcError,
  boundedJson,
  digest,
  safeCode,
  tokenSet,
} from '../src/siwc/protocol.js';
import { OAuthAttempt } from '../src/siwc/oauth.js';
import { AccountStore } from '../src/siwc/accounts.js';
import {
  CLIENT,
  HOST,
  NOW,
  MemoryCredentials,
  fixture,
  json,
  jwk,
  jwt,
  tokens,
} from './siwc-fixtures.js';

const errorCode = (expected) => (error) => {
  assert.equal(error.code, expected);
  return true;
};
const verifyOptions = { clientId: CLIENT, nonce: 'test-nonce' };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const [name, claims, header, code] of [
  ['wrong nonce', { nonce: 'other' }, {}, 'ID_TOKEN_NONCE_INVALID'],
  ['wrong issuer', { iss: 'https://evil.test' }, {}, 'ID_TOKEN_AUDIENCE_INVALID'],
  ['wrong audience', { aud: 'oaiapp_other_registration' }, {}, 'ID_TOKEN_AUDIENCE_INVALID'],
  ['multi audience missing azp', { aud: [CLIENT, 'other'] }, {}, 'ID_TOKEN_AUDIENCE_INVALID'],
  ['wrong azp', { azp: 'other' }, {}, 'ID_TOKEN_AUDIENCE_INVALID'],
  ['expired token', { exp: NOW / 1000 }, {}, 'ID_TOKEN_EXPIRED'],
  ['future iat', { iat: NOW / 1000 + 1000 }, {}, 'ID_TOKEN_EXPIRED'],
  ['future nbf', { nbf: NOW / 1000 + 1000 }, {}, 'ID_TOKEN_EXPIRED'],
  ['invalid expiry', { exp: 'not-a-number' }, {}, 'ID_TOKEN_EXPIRED'],
  ['empty subject', { sub: '' }, {}, 'ACCOUNT_MISMATCH'],
  ['none algorithm', {}, { alg: 'none' }, 'ID_TOKEN_INVALID'],
  ['HMAC confusion', {}, { alg: 'HS256' }, 'ID_TOKEN_INVALID'],
  ['unknown critical header', {}, { crit: ['evil'] }, 'ID_TOKEN_INVALID'],
  ['unknown kid', {}, { kid: 'unknown' }, 'ID_TOKEN_KEY_INVALID'],
])
  test(`ID token rejects ${name}`, async () => {
    const { protocol } = fixture();
    await assert.rejects(
      protocol.verifyIdToken(jwt(claims, header), verifyOptions),
      errorCode(code),
    );
  });

test('ID token validates signature and only uses verified identity', async () => {
  const { protocol, requests } = fixture();
  const identity = await protocol.verifyIdToken(jwt(), verifyOptions);
  assert.deepEqual(identity, {
    issuer: ISSUER,
    subject: 'test-subject',
    email: 'example@example.test',
  });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.redirect === 'error'));
  await assert.rejects(
    protocol.verifyIdToken(jwt({ sub: 'another' }), {
      ...verifyOptions,
      subject: identity.subject,
    }),
    errorCode('ACCOUNT_MISMATCH'),
  );
  const parts = jwt().split('.');
  parts[1] = Buffer.from(JSON.stringify({ sub: 'attacker' })).toString('base64url');
  await assert.rejects(
    protocol.verifyIdToken(parts.join('.'), verifyOptions),
    errorCode('ID_TOKEN_SIGNATURE_INVALID'),
  );
});

test('JWKS rejects ambiguous keys, signing misuse, and metadata URL injection', async () => {
  for (const keys of [[jwk, jwk], [{ ...jwk, use: 'enc' }], [{ ...jwk, key_ops: ['sign'] }]]) {
    await assert.rejects(
      fixture({ keys }).protocol.verifyIdToken(jwt(), verifyOptions),
      errorCode('ID_TOKEN_KEY_INVALID'),
    );
  }
  for (const uri of [
    'https://evil.test/jwks',
    'http://auth.openai.com/jwks',
    'https://auth.openai.com@evil.test/jwks',
  ]) {
    const { protocol } = fixture({
      metadata: {
        issuer: ISSUER,
        jwks_uri: uri,
        revocation_endpoint: `${ISSUER}/revoke`,
        id_token_signing_alg_values_supported: ['RS256'],
      },
    });
    await assert.rejects(
      protocol.verifyIdToken(jwt(), verifyOptions),
      errorCode('OIDC_METADATA_INVALID'),
    );
  }
});

test('JWKS caches and reloads after signing-key rotation without a per-kid request storm', async () => {
  let clock = NOW;
  const { protocol, requests } = fixture({ now: () => clock });
  await protocol.verifyIdToken(jwt(), verifyOptions);
  await assert.rejects(protocol.verifyIdToken(jwt({}, { kid: 'unknown' }), verifyOptions));
  assert.equal(requests.length, 2);
  clock += 6000;
  await assert.rejects(protocol.verifyIdToken(jwt({}, { kid: 'unknown' }), verifyOptions));
  assert.equal(requests.length, 3);
  await assert.rejects(protocol.verifyIdToken(jwt({}, { kid: 'unknown-again' }), verifyOptions));
  assert.equal(requests.length, 3);
});

test('missing direct permission keeps sign-in disabled; token lifetimes remain bounded', () => {
  assert.equal(
    tokenSet(tokens({}, { scope: 'openid profile email' }), { now: NOW }).scopes.includes(
      DIRECT_SCOPE,
    ),
    false,
  );
  assert.equal(
    tokenSet(tokens({}, { scope: undefined }), { now: NOW }).scopes.includes(DIRECT_SCOPE),
    false,
  );
  for (const overrides of [
    { token_type: 'MAC' },
    { expires_in: 0 },
    { expires_in: '3600' },
    { refresh_token: '' },
    { id_token: undefined },
    { access_token: '' },
  ]) {
    assert.throws(
      () => tokenSet(tokens({}, overrides), { now: NOW }),
      errorCode('INVALID_TOKEN_RESPONSE'),
    );
  }
  const saved = tokenSet(tokens(), { now: NOW });
  assert.equal(saved.expiresAt, NOW + 3600_000);
  assert.ok(saved.scopes.includes(DIRECT_SCOPE));
});

test('token exchange uses issued public client, exact redirect, resource and no secret', async () => {
  const { protocol, requests } = fixture();
  const redirectUri = 'http://127.0.0.1:54321/auth/callback';
  const grant = await protocol.authorizationGrant({
    clientId: CLIENT,
    code: 'mock-code',
    verifier: 'mock-verifier',
    redirectUri,
    nonce: 'test-nonce',
  });
  assert.equal(grant.subject, 'test-subject');
  const request = requests.find((request) => request.url === TOKEN_ENDPOINT);
  const body = new URLSearchParams(request.body);
  assert.equal(request.method, 'POST');
  assert.equal(body.get('client_id'), CLIENT);
  assert.equal(body.get('resource'), RESOURCE);
  assert.equal(body.get('redirect_uri'), redirectUri);
  assert.equal(body.get('code_verifier'), 'mock-verifier');
  assert.equal(body.get('client_secret'), null);
  await assert.rejects(
    protocol.exchange({
      client_id: DYNAMIC_CLIENT_ID,
      grant_type: 'authorization_code',
      resource: RESOURCE,
    }),
    errorCode('INVALID_TOKEN_REQUEST'),
  );
});

test('network errors and OAuth error descriptions never escape as messages', async () => {
  const protocol = new OpenAIProtocol({
    fetchImpl: async () => {
      throw new Error('token=SHOULD_NOT_ESCAPE');
    },
  });
  await assert.rejects(protocol.metadata(), errorCode('NETWORK'));
  const { protocol: rejected } = fixture({
    tokenResponse: () =>
      json({ error: 'invalid_grant', error_description: 'SHOULD_NOT_ESCAPE' }, 400),
  });
  await assert.rejects(rejected.authorizationGrant({ clientId: CLIENT }), (error) => {
    assert.equal(error.message, 'INVALID_GRANT');
    assert.equal(safeCode(error), 'INVALID_GRANT');
    return true;
  });
  assert.equal(safeCode(new Error('SHOULD_NOT_ESCAPE')), 'INTERNAL');
});

test('bounded JSON rejects oversized and malformed bodies without echoing them', async () => {
  await assert.rejects(boundedJson(new Response('too long'), 2), errorCode('RESPONSE_TOO_LARGE'));
  await assert.rejects(boundedJson(new Response('SECRET-not-json')), errorCode('INVALID_RESPONSE'));
  await assert.rejects(boundedJson(json([])), errorCode('INVALID_RESPONSE'));
  await assert.rejects(
    boundedJson(new Response('x', { headers: { 'content-length': '999999999' } })),
    errorCode('RESPONSE_TOO_LARGE'),
  );
});

async function attemptFixture(options = {}) {
  let authorize;
  const { protocol, requests } = fixture({
    tokenResponse: (request) => {
      if (options.tokenResponse) return options.tokenResponse(request);
      return json(
        tokens({
          aud: new URLSearchParams(request.body).get('client_id'),
          nonce: authorize.searchParams.get('nonce'),
        }),
      );
    },
  });
  const attempt = new OAuthAttempt(protocol, { hostId: HOST, port: 0, ...options });
  const status = await attempt.start();
  authorize = status.authorizeUrl ? new URL(status.authorizeUrl) : undefined;
  const callback = authorize ? new URL(authorize.searchParams.get('redirect_uri')) : undefined;
  function returnUrl(values = {}) {
    const url = new URL(callback);
    url.search = new URLSearchParams({
      state: authorize.searchParams.get('state'),
      code: 'mock-code',
      client_id: CLIENT,
      ...values,
    });
    return url;
  }
  return { attempt, authorize, callback, requests, returnUrl };
}

test('new OAuth attempt binds loopback before exposing dynamic registration URL', async (t) => {
  const { attempt, authorize, callback } = await attemptFixture();
  t.after(() => attempt.cancel());
  assert.equal(authorize.origin + authorize.pathname, AUTHORIZE);
  assert.equal(authorize.searchParams.get('client_id'), DYNAMIC_CLIENT_ID);
  assert.equal(authorize.searchParams.get('agent_name_hint'), AGENT_NAME);
  assert.equal(authorize.searchParams.get('ext_agent_host_id'), HOST);
  assert.equal(authorize.searchParams.get('scope'), SCOPES);
  assert.equal(authorize.searchParams.get('resource'), RESOURCE);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('state').length, 43);
  assert.notEqual(authorize.searchParams.get('nonce'), authorize.searchParams.get('state'));
  assert.equal(authorize.searchParams.get('id_token_hint'), null);
  assert.equal(callback.hostname, '127.0.0.1');
  assert.equal(callback.pathname, '/auth/callback');
  assert.equal((await fetch(callback)).status, 400);
  assert.equal(attempt.status.phase, 'waiting');
  assert.equal('nonce' in attempt.status, false);
});

test('returning authorization reuses client ID, no name/hints, and rejects mismatched client', async (t) => {
  const { attempt, authorize, returnUrl, requests } = await attemptFixture({
    registration: { clientId: CLIENT, subject: 'test-subject', idToken: 'never-rendered' },
  });
  t.after(() => attempt.cancel());
  assert.equal(authorize.searchParams.get('client_id'), CLIENT);
  assert.equal(authorize.searchParams.get('agent_name_hint'), null);
  assert.equal(authorize.searchParams.get('id_token_hint'), null);
  assert.equal((await fetch(returnUrl({ client_id: 'oaiapp_wrong_registration' }))).status, 400);
  assert.equal((await attempt.done).error, 'CLIENT_ID_MISMATCH');
  assert.equal(
    requests.some((request) => request.url === TOKEN_ENDPOINT),
    false,
  );
});

test('successful callback issues once, validates signature/nonce/scope, then commits', async (t) => {
  const order = [];
  const { attempt, authorize, returnUrl, requests } = await attemptFixture({
    onIssued: async (id) => {
      assert.equal(id, CLIENT);
      order.push('issued');
    },
    onAuthorized: async (grant) => {
      assert.equal(grant.subject, 'test-subject');
      assert.equal(grant.clientId, CLIENT);
      order.push('validated');
    },
  });
  t.after(() => attempt.cancel());
  const response = await fetch(returnUrl());
  assert.equal(response.status, 200);
  assert.equal((await attempt.done).phase, 'authorized');
  assert.deepEqual(order, ['issued', 'validated']);
  assert.equal(attempt.status.authorizeUrl, undefined);
  const exchanges = requests.filter((request) => request.url === TOKEN_ENDPOINT);
  assert.equal(exchanges.length, 1);
  const body = new URLSearchParams(exchanges[0].body);
  assert.equal(digest(body.get('code_verifier')), authorize.searchParams.get('code_challenge'));
  assert.equal(body.get('redirect_uri'), authorize.searchParams.get('redirect_uri'));
  await assert.rejects(fetch(returnUrl()));
});

test('returning callback may omit client ID but may not change verified account identity', async (t) => {
  const { attempt, returnUrl } = await attemptFixture({
    registration: { clientId: CLIENT, subject: 'wrong-subject' },
  });
  t.after(() => attempt.cancel());
  const callback = returnUrl();
  callback.searchParams.delete('client_id');
  assert.equal((await fetch(callback)).status, 400);
  assert.equal((await attempt.done).error, 'ACCOUNT_MISMATCH');
});

test('malicious requests cannot consume a pending attempt or cause token exchange', async (t) => {
  const { attempt, returnUrl, requests, callback } = await attemptFixture();
  t.after(() => attempt.cancel());
  assert.equal((await fetch(returnUrl({ state: 'wrong' }))).status, 400);
  const duplicate = returnUrl();
  duplicate.searchParams.append('state', 'duplicate');
  assert.equal((await fetch(duplicate)).status, 400);
  // Fetch normalizes forbidden Host headers. Exercise an actual attacker wire
  // request instead of incorrectly assuming a Fetch override reached the server.
  const wrongHost = await new Promise((resolve, rejectRequest) => {
    const request = httpRequest(returnUrl(), { headers: { host: 'evil.test' } }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', rejectRequest);
    request.end();
  });
  assert.equal(wrongHost, 403);
  assert.equal(
    (await fetch(returnUrl(), { headers: { origin: 'https://evil.test' } })).status,
    403,
  );
  assert.equal((await fetch(new URL('/other', callback))).status, 404);
  assert.equal((await fetch(returnUrl(), { method: 'POST' })).status, 405);
  assert.equal(attempt.status.phase, 'waiting');
  assert.equal(requests.length, 0);
});

for (const [values, expected] of [
  [{ error: 'access_denied' }, 'ACCESS_DENIED'],
  [{ error: 'remote-error-with-sensitive-description' }, 'AUTHORIZATION_FAILED'],
  [{ client_id: '' }, 'REGISTRATION_INCOMPLETE'],
  [{ client_id: DYNAMIC_CLIENT_ID }, 'REGISTRATION_INCOMPLETE'],
  [{ code: '' }, 'AUTHORIZATION_CODE_MISSING'],
])
  test(`callback fails safely: ${expected}`, async (t) => {
    const { attempt, returnUrl, requests } = await attemptFixture();
    t.after(() => attempt.cancel());
    assert.equal((await fetch(returnUrl(values))).status, 400);
    assert.equal((await attempt.done).error, expected);
    assert.equal(
      requests.some((request) => request.url === TOKEN_ENDPOINT),
      false,
    );
  });

test('invalid_grant preserves issued registration for retry without activating account', async (t) => {
  const credentials = new MemoryCredentials();
  const store = new AccountStore(credentials);
  const { attempt, returnUrl } = await attemptFixture({
    onIssued: (id, signal) => store.beginRegistration(id, signal),
    onAuthorized: (grant, signal) => store.saveValidated(grant, signal),
    tokenResponse: () => json({ error: 'invalid_grant' }, 400),
  });
  t.after(() => attempt.cancel());
  await fetch(returnUrl());
  assert.equal((await attempt.done).error, 'INVALID_GRANT');
  const accounts = await store.accounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].status, 'pending');
  assert.equal(await store.selection(), undefined);
  assert.equal((await store.registration(accounts[0].key)).clientId, CLIENT);
});

test('cancel and timeout release listener and hide authorization URL', async () => {
  for (const timeoutMs of [10000, 15]) {
    const { attempt, callback } = await attemptFixture({ timeoutMs });
    if (timeoutMs === 10000) attempt.cancel();
    else await wait(25);
    const result = await attempt.done;
    assert.equal(result.phase, timeoutMs === 10000 ? 'cancelled' : 'expired');
    assert.equal(attempt.status.authorizeUrl, undefined);
    await assert.rejects(fetch(callback));
    attempt.dispose();
  }
});

test('early cancellation cannot leave start pending or a listener alive', async () => {
  const { protocol } = fixture();
  const attempt = new OAuthAttempt(protocol, { hostId: HOST, port: 0 });
  const starting = attempt.start();
  attempt.cancel();
  assert.equal((await starting).phase, 'cancelled');
  assert.equal((await attempt.done).phase, 'cancelled');
});

test('port 1455 collision uses another available port rather than localhost', async (t) => {
  const blocker = createServer();
  try {
    await new Promise((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(1455, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
  }
  t.after(() => blocker.close());
  const { protocol } = fixture();
  const attempt = new OAuthAttempt(protocol, { hostId: HOST });
  t.after(() => attempt.cancel());
  const status = await attempt.start();
  assert.equal(status.phase, 'waiting');
  const uri = new URL(new URL(status.authorizeUrl).searchParams.get('redirect_uri'));
  assert.equal(uri.hostname, '127.0.0.1');
  assert.notEqual(uri.port, '1455');
});

test('host identity is stable across instances and concurrent initialization', async () => {
  const credentials = new MemoryCredentials();
  const stores = Array.from(
    { length: 10 },
    () => new AccountStore(new MemoryCredentials(credentials.shared)),
  );
  const ids = await Promise.all(stores.map((store) => store.hostId()));
  assert.equal(new Set(ids).size, 1);
  assert.match(ids[0], /^urn:uuid:/);
  assert.equal(await new AccountStore(credentials).hostId(), ids[0]);
});

test('verified registrations stay separate even with same email; active switch is explicit', async () => {
  const credentials = new MemoryCredentials();
  const store = new AccountStore(credentials);
  credentials.shared.records.set('llm-pi-ai/openai-codex', {
    kind: 'grant',
    payload: { token: 'other-client-untouched' },
  });
  credentials.shared.records.set('deepseek-account/default', {
    kind: 'grant',
    payload: { token: 'existing-source-untouched' },
  });
  const original = structuredClone(credentials.shared.records);
  const { protocol } = fixture();
  const grant = await protocol.authorizationGrant({ clientId: CLIENT, nonce: 'test-nonce' });
  const first = await store.beginRegistration(CLIENT);
  await store.saveValidated(grant);
  const otherClient = 'oaiapp_other_registration_98765';
  const second = await store.beginRegistration(otherClient);
  await store.saveValidated({ ...grant, clientId: otherClient, subject: 'another-subject' });
  const accounts = await store.accounts();
  assert.equal(accounts.length, 2);
  assert.notEqual(accounts[0].label, accounts[1].label);
  const exposed = JSON.stringify(accounts);
  assert.ok(!exposed.includes(grant.accessToken));
  assert.ok(!exposed.includes(grant.idToken));
  assert.ok(!exposed.includes(grant.subject));
  assert.equal(await store.selection(), undefined);
  await store.select(first);
  const initial = await store.selection();
  assert.equal(initial.key, first);
  await store.select(second);
  assert.ok((await store.selection()).generation > initial.generation);
  await assert.rejects(
    store.saveValidated({ ...grant, subject: 'attacker' }),
    errorCode('ACCOUNT_MISMATCH'),
  );
  await assert.rejects(
    store.registration('llm-pi-ai/openai-codex'),
    errorCode('ACCOUNT_NOT_FOUND'),
  );
  for (const [key, value] of original) assert.deepEqual(await credentials.readRecord(key), value);
});

test('cancellation before commit and invalid registrations never activate or overwrite accounts', async () => {
  const credentials = new MemoryCredentials();
  const store = new AccountStore(credentials);
  const pending = await store.beginRegistration(CLIENT);
  await assert.rejects(store.select(pending), errorCode('ACCOUNT_REAUTH_REQUIRED'));
  await assert.rejects(store.beginRegistration(DYNAMIC_CLIENT_ID), errorCode('CLIENT_ID_INVALID'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(store.beginRegistration(CLIENT, controller.signal), errorCode('CANCELLED'));
  assert.equal(await store.selection(), undefined);
});
