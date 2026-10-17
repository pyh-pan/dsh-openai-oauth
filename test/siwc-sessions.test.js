import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore, SELECTION_KEY } from '../src/siwc/accounts.js';
import { SessionManager } from '../src/siwc/sessions.js';
import { DIRECT_SCOPE, ISSUER, RESOURCE, SiwcError } from '../src/siwc/protocol.js';
import { CLIENT, NOW, MemoryCredentials, fixture, json, tokens } from './siwc-fixtures.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function setup({
  protocol,
  now = () => NOW,
  expiresAt = NOW - 1000,
  credentials = new MemoryCredentials(),
  ...options
} = {}) {
  const accounts = new AccountStore(credentials);
  const key = await accounts.beginRegistration(CLIENT);
  const grant = {
    issuer: ISSUER,
    subject: 'test-subject',
    clientId: CLIENT,
    email: 'test@example.test',
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    idToken: 'old-validated-id-token',
    tokenType: 'Bearer',
    scopes: [DIRECT_SCOPE, 'openid', 'offline_access'],
    expiresAt,
    savedAt: NOW - 3600000,
  };
  await accounts.saveValidated(grant);
  await accounts.select(key);
  const sessions = new SessionManager({
    accounts,
    protocol: protocol ?? fixture().protocol,
    now,
    revokeBackoffMs: 1,
    ...options,
  });
  return { accounts, key, sessions, credentials, grant };
}

test('near-expiry refresh uses issued client/resource, rotates atomically and serializes concurrent callers', async (t) => {
  let refreshed = 0;
  const { protocol, requests } = fixture({
    tokenResponse: async (request) => {
      refreshed++;
      const body = new URLSearchParams(request.body);
      assert.equal(body.get('client_id'), CLIENT);
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('refresh_token'), 'old-refresh');
      assert.equal(body.get('resource'), RESOURCE);
      assert.equal(body.has('scope'), false);
      await wait(10);
      return json(
        tokens(
          {},
          {
            access_token: 'rotated-access',
            refresh_token: 'rotated-refresh',
            id_token: undefined,
            scope: undefined,
          },
        ),
      );
    },
  });
  const { sessions, key, accounts, credentials } = await setup({ protocol });
  t.after(() => sessions.dispose());
  const otherProcessStore = new AccountStore(new MemoryCredentials(credentials.shared));
  const otherProcess = new SessionManager({
    accounts: otherProcessStore,
    protocol,
    now: () => NOW,
  });
  t.after(() => otherProcess.dispose());
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) => (i % 2 ? otherProcess : sessions).access(key)),
  );
  assert.equal(refreshed, 1);
  assert.ok(results.every((access) => access.accessToken === 'rotated-access'));
  const saved = await accounts.registration(key);
  assert.equal(saved.refreshToken, 'rotated-refresh');
  assert.equal(saved.idToken, 'old-validated-id-token');
  assert.equal(saved.expiresAt, NOW + 3600000);
  assert.ok(saved.scopes.includes(DIRECT_SCOPE));
  assert.equal(requests.length, 1); // No fresh ID token: no needless JWKS fetch.
});

test('unexpired token resumes without network after manager recreation', async (t) => {
  let calls = 0;
  const protocol = {
    refresh: async () => {
      calls++;
      throw new Error('must not refresh');
    },
  };
  const { sessions, accounts, key } = await setup({ protocol, expiresAt: NOW + 3600000 });
  assert.equal((await sessions.access(key)).accessToken, 'old-access');
  await sessions.dispose();
  const restarted = new SessionManager({ accounts, protocol, now: () => NOW });
  t.after(() => restarted.dispose());
  assert.equal((await restarted.access(key)).accessToken, 'old-access');
  assert.equal(calls, 0);
});

for (const remoteCode of [
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
])
  test(`terminal refresh ${remoteCode} clears unusable tokens but retains registration`, async (t) => {
    const { protocol } = fixture({
      tokenResponse: () => json({ error: remoteCode, error_description: 'SECRET_NEVER_ECHO' }, 400),
    });
    const { sessions, accounts, key } = await setup({ protocol });
    t.after(() => sessions.dispose());
    await assert.rejects(sessions.access(key), { code: 'ACCOUNT_REAUTH_REQUIRED' });
    const stored = await accounts.registration(key);
    assert.equal(stored.clientId, CLIENT);
    assert.equal(stored.subject, 'test-subject');
    assert.equal(stored.status, 'reauth-required');
    for (const field of ['accessToken', 'refreshToken', 'idToken'])
      assert.equal(field in stored, false);
    assert.equal(JSON.stringify(stored).includes('SECRET_NEVER_ECHO'), false);
  });

for (const remoteCode of ['temporarily_unavailable', 'invalid_client'])
  test(`non-terminal refresh ${remoteCode} does not erase credentials`, async (t) => {
    const { protocol } = fixture({
      tokenResponse: () => json({ error: remoteCode }, remoteCode === 'invalid_client' ? 400 : 503),
    });
    const { sessions, accounts, key } = await setup({ protocol });
    t.after(() => sessions.dispose());
    const before = await accounts.registration(key);
    await assert.rejects(sessions.access(key), {
      code: remoteCode === 'invalid_client' ? 'INVALID_CLIENT' : 'TOKEN_EXCHANGE_FAILED',
    });
    assert.deepEqual(await accounts.registration(key), before);
  });

test('refresh validates new ID token identity before replacing a selected account', async (t) => {
  const { protocol } = fixture({
    tokenResponse: () => json(tokens({ sub: 'wrong-subject' }, { refresh_token: 'new-refresh' })),
  });
  const { sessions, accounts, key } = await setup({ protocol });
  t.after(() => sessions.dispose());
  await assert.rejects(sessions.access(key), { code: 'ACCOUNT_MISMATCH' });
  assert.equal((await accounts.registration(key)).refreshToken, 'old-refresh');
});

test('permission removed by refresh disables inference without pretending the account signed out', async (t) => {
  const { protocol } = fixture({
    tokenResponse: () => json(tokens({}, { scope: 'openid email offline_access' })),
  });
  const { sessions, accounts, key } = await setup({ protocol });
  t.after(() => sessions.dispose());
  await assert.rejects(sessions.access(key), { code: 'DIRECT_PERMISSION_MISSING' });
  assert.equal((await accounts.registration(key)).status, 'disabled');
  const info = (await accounts.accounts())[0];
  assert.equal(info.signedIn, true);
  assert.equal(info.inferenceEnabled, false);
  await assert.rejects(accounts.select(key), { code: 'ACCOUNT_REAUTH_REQUIRED' });
});

test('caller cancellation during rotating refresh still persists replacement before refusing inference', async (t) => {
  const entered = deferred(),
    release = deferred();
  const { sessions, accounts, key, grant } = await setup({
    protocol: {
      refresh: async (old, maintenanceSignal) => {
        entered.resolve();
        await release.promise;
        assert.equal(maintenanceSignal.aborted, false);
        return {
          ...old,
          accessToken: 'committed-access',
          refreshToken: 'committed-refresh',
          expiresAt: NOW + 3600000,
        };
      },
    },
  });
  t.after(() => sessions.dispose());
  const abort = new AbortController();
  const pending = sessions.access(key, { signal: abort.signal });
  await entered.promise;
  abort.abort();
  release.resolve();
  await assert.rejects(pending, { name: 'AbortError' });
  const saved = await accounts.registration(key);
  assert.equal(saved.refreshToken, 'committed-refresh');
  assert.equal((await sessions.access(key)).accessToken, 'committed-access');
  assert.equal(grant.refreshToken, 'old-refresh');
});

test('account selection generations cancel running requests and reject stale dispatch', async (t) => {
  const { sessions, accounts, key, grant } = await setup({ expiresAt: NOW + 3600000 });
  t.after(() => sessions.dispose());
  const selected = await accounts.selection();
  const first = await sessions.access(key, { selection: selected });
  const otherId = 'oaiapp_saved_other_account_456789';
  const otherKey = await accounts.beginRegistration(otherId);
  await accounts.saveValidated({
    ...grant,
    clientId: otherId,
    subject: 'another-subject',
    expiresAt: NOW + 3600000,
  });
  await accounts.select(otherKey);
  sessions.selectionChanged(await accounts.selection());
  assert.equal(first.signal.aborted, true);
  assert.equal(first.signal.reason.code, 'ACCOUNT_CHANGED');
  await assert.rejects(sessions.access(key, { selection: selected }), { code: 'ACCOUNT_CHANGED' });
  assert.equal((await sessions.access(otherKey)).accessToken, 'old-access');
});

test('logout revokes latest token, cancels running requests and preserves other clients', async (t) => {
  const entered = deferred(),
    release = deferred();
  const { protocol, requests } = fixture({
    revocationResponse: async (request) => {
      const body = new URLSearchParams(request.body);
      assert.equal(body.get('token'), 'old-refresh');
      assert.equal(body.get('client_id'), CLIENT);
      assert.equal(body.get('token_type_hint'), 'refresh_token');
      entered.resolve();
      await release.promise;
      return new Response(null, { status: 200 });
    },
  });
  const { sessions, accounts, credentials, key } = await setup({
    protocol,
    expiresAt: NOW + 3600000,
  });
  t.after(() => sessions.dispose());
  const sentinel = { kind: 'grant', payload: { untouched: 'another-client' } };
  credentials.shared.records.set('llm-pi-ai/openai-codex', structuredClone(sentinel));
  credentials.shared.records.set('deepseek-account/default', structuredClone(sentinel));
  await accounts.acknowledgeWelcome(key);
  assert.equal((await accounts.accounts())[0].welcomeRequired, false);
  const access = await sessions.access(key);
  const logout = sessions.logout(key);
  await entered.promise;
  assert.equal(access.signal.aborted, true);
  await assert.rejects(sessions.access(key), { code: 'ACCOUNT_SIGNED_OUT' });
  release.resolve();
  assert.deepEqual(await logout, { remoteConfirmed: true });
  const saved = await accounts.registration(key);
  assert.equal(saved.status, 'signed-out');
  assert.equal(saved.clientId, CLIENT);
  assert.equal(await accounts.selection(), undefined);
  for (const name of ['accessToken', 'refreshToken', 'idToken'])
    assert.equal(saved[name], undefined);
  for (const key of ['llm-pi-ai/openai-codex', 'deepseek-account/default'])
    assert.deepEqual(await credentials.readRecord(key), sentinel);
  assert.equal(requests.at(-1).url, `${ISSUER}/api/accounts/oauth/revoke`);
  assert.equal((await credentials.readRecord(SELECTION_KEY)).payload.generation, 2);
  assert.equal(saved.welcomeSeen, true); // Signing out must not repeat first-use UI.
  const previous = {
    ...saved,
    accessToken: 'reauthorized-access',
    refreshToken: 'reauthorized-refresh',
    idToken: 'reauthorized-id',
    expiresAt: NOW + 3600000,
    scopes: [DIRECT_SCOPE],
  };
  await accounts.saveValidated(previous);
  assert.equal((await new AccountStore(credentials).accounts())[0].welcomeRequired, false);
});

test('revocation retries transient 5xx with bounded backoff', async (t) => {
  let calls = 0;
  const { protocol } = fixture({
    revocationResponse: () =>
      ++calls === 1 ? new Response(null, { status: 503 }) : new Response(null, { status: 200 }),
  });
  const { sessions, key } = await setup({ protocol });
  t.after(() => sessions.dispose());
  assert.deepEqual(await sessions.logout(key), { remoteConfirmed: true });
  assert.equal(calls, 2);
});

test('unconfirmed remote revocation is reported explicitly while local tokens are cleared', async (t) => {
  let calls = 0;
  const { protocol } = fixture({
    revocationResponse: () => {
      calls++;
      return new Response(null, { status: 503 });
    },
  });
  const { sessions, accounts, key } = await setup({ protocol });
  t.after(() => sessions.dispose());
  const result = await sessions.logout(key);
  assert.equal(result.remoteConfirmed, false);
  assert.equal(result.warning, 'REMOTE_REVOCATION_UNCONFIRMED');
  assert.equal(calls, 2);
  assert.equal((await accounts.registration(key)).accessToken, undefined);
  assert.equal((await accounts.registration(key)).clientId, CLIENT);
});

test('refresh maintenance has a total deadline and never destroys tokens on timeout', async (t) => {
  const protocol = {
    refresh: async (account, signal) => {
      await new Promise((resolve, rejectPromise) => {
        const hold = setTimeout(resolve, 1000);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(hold);
            rejectPromise(new SiwcError('NETWORK_TIMEOUT'));
          },
          { once: true },
        );
      });
      return account;
    },
  };
  const { sessions, accounts, key } = await setup({ protocol, maintenanceTimeoutMs: 15 });
  t.after(() => sessions.dispose());
  await assert.rejects(sessions.access(key), { code: 'NETWORK_TIMEOUT' });
  assert.equal((await accounts.registration(key)).refreshToken, 'old-refresh');
});

test('graceful disposal waits for in-flight rotation, commits it, then refuses request dispatch', async () => {
  const entered = deferred(),
    release = deferred();
  const { sessions, accounts, key } = await setup({
    protocol: {
      refresh: async (old) => {
        entered.resolve();
        await release.promise;
        return {
          ...old,
          accessToken: 'after-dispose',
          refreshToken: 'after-dispose-refresh',
          expiresAt: NOW + 3600000,
        };
      },
    },
  });
  const access = sessions.access(key);
  await entered.promise;
  const disposed = sessions.dispose();
  release.resolve();
  await assert.rejects(access, { code: 'PLUGIN_DISPOSED' });
  await disposed;
  assert.equal((await accounts.registration(key)).refreshToken, 'after-dispose-refresh');
  await assert.rejects(sessions.access(key), { code: 'PLUGIN_DISPOSED' });
});
