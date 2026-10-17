import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore } from '../src/siwc/accounts.js';
import { SessionManager } from '../src/siwc/sessions.js';
import { DIRECT_SCOPE } from '../src/siwc/protocol.js';
import { CLIENT, NOW, MemoryCredentials, fixture, json, tokens } from './siwc-fixtures.js';

test('valid identity can be retained without offline renewal; reauthorization never reuses an omitted old refresh token', async (t) => {
  const { protocol } = fixture({
    tokenResponse: () => json(tokens({}, { refresh_token: undefined })),
  });
  const grant = await protocol.authorizationGrant({ clientId: CLIENT, nonce: 'test-nonce' });
  assert.equal('refreshToken' in grant, false);
  const accounts = new AccountStore(new MemoryCredentials());
  const key = await accounts.beginRegistration(CLIENT);
  assert.match(key, /^chatgpt-subscription-login\/account-[a-f0-9]{64}$/);
  await accounts.saveValidated({ ...grant, refreshToken: 'older-session-refresh' });
  await accounts.saveValidated(grant);
  assert.equal('refreshToken' in (await accounts.registration(key)), false);
  await accounts.select(key);
  let clock = NOW;
  const sessions = new SessionManager({
    accounts,
    protocol: {
      refresh: async () => {
        throw new Error('No renewable token: must not call refresh');
      },
    },
    now: () => clock,
  });
  t.after(() => sessions.dispose());
  assert.equal((await sessions.access(key)).accessToken, grant.accessToken);
  clock = NOW + 3600001;
  await assert.rejects(sessions.access(key), { code: 'ACCOUNT_REAUTH_REQUIRED' });
  assert.equal((await accounts.registration(key)).clientId, CLIENT);
});

test('explicit maintenance refresh rotates a still-valid token under the normal atomic path', async (t) => {
  const accounts = new AccountStore(new MemoryCredentials());
  const { protocol } = fixture();
  const grant = await protocol.authorizationGrant({ clientId: CLIENT, nonce: 'test-nonce' });
  const key = await accounts.beginRegistration(CLIENT);
  await accounts.saveValidated(grant);
  await accounts.select(key);
  let refreshes = 0;
  const sessions = new SessionManager({
    accounts,
    now: () => NOW,
    protocol: {
      refresh: async (previous) => {
        refreshes++;
        return {
          ...previous,
          accessToken: 'forced-mock-access',
          refreshToken: 'forced-mock-refresh',
          expiresAt: NOW + 7200000,
          savedAt: NOW + 1,
        };
      },
    },
  });
  t.after(() => sessions.dispose());
  assert.equal((await sessions.access(key)).accessToken, grant.accessToken);
  assert.equal(refreshes, 0);
  assert.equal(
    (await sessions.access(key, { forceRefresh: true })).accessToken,
    'forced-mock-access',
  );
  assert.equal(refreshes, 1);
  assert.equal((await accounts.registration(key)).refreshToken, 'forced-mock-refresh');
});

test('refresh may omit nonce but cannot change a retained original OIDC nonce', async () => {
  let nonce = 'test-nonce';
  const { protocol } = fixture({ tokenResponse: () => json(tokens({ nonce })) });
  const grant = await protocol.authorizationGrant({ clientId: CLIENT, nonce: 'test-nonce' });
  assert.equal(grant.oidcNonce, 'test-nonce');
  nonce = undefined;
  assert.equal((await protocol.refresh(grant)).subject, grant.subject);
  nonce = 'different-nonce';
  await assert.rejects(protocol.refresh(grant), { code: 'ID_TOKEN_NONCE_INVALID' });
});

test('first-use acknowledgement is protected, idempotent, and survives account-store recreation', async () => {
  const credentials = new MemoryCredentials();
  const accounts = new AccountStore(credentials);
  const { protocol } = fixture();
  const grant = await protocol.authorizationGrant({ clientId: CLIENT, nonce: 'test-nonce' });
  const key = await accounts.beginRegistration(CLIENT);
  await accounts.saveValidated(grant);
  assert.equal((await accounts.accounts())[0].welcomeRequired, true);
  await accounts.acknowledgeWelcome(key);
  await accounts.acknowledgeWelcome(key);
  assert.equal((await new AccountStore(credentials).accounts())[0].welcomeRequired, false);
  const before = await accounts.registration(key);
  await accounts.saveValidated({
    ...grant,
    scopes: grant.scopes.filter((scope) => scope !== DIRECT_SCOPE),
  });
  await assert.rejects(accounts.acknowledgeWelcome(key), { code: 'DIRECT_PERMISSION_MISSING' });
  assert.equal((await accounts.registration(key)).welcomeSeen, before.welcomeSeen);
});
