import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore } from '../src/siwc/accounts.js';
import { SessionManager } from '../src/siwc/sessions.js';
import { DIRECT_SCOPE, ISSUER, SiwcError } from '../src/siwc/protocol.js';
import { CLIENT, NOW, MemoryCredentials } from './siwc-fixtures.js';

async function setup(protocol, credentials = new MemoryCredentials()) {
  const accounts = new AccountStore(credentials);
  const key = await accounts.beginRegistration(CLIENT);
  await accounts.saveValidated({
    issuer: ISSUER,
    subject: 'renewal-fixture',
    clientId: CLIENT,
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    idToken: 'old-id',
    scopes: [DIRECT_SCOPE],
    expiresAt: NOW - 1,
  });
  await accounts.select(key);
  return {
    accounts,
    key,
    credentials,
    manager: () =>
      new SessionManager({
        accounts: new AccountStore(new MemoryCredentials(credentials.shared)),
        protocol,
        now: () => NOW,
      }),
  };
}

test('twelve waiters in two managers never resubmit an ambiguously rotated generation', async (t) => {
  let calls = 0;
  const state = await setup({
    refresh: async () => {
      calls++;
      throw new SiwcError('AUTH_REQUEST_UNCONFIRMED', 502);
    },
  });
  const managers = [state.manager(), state.manager()];
  t.after(async () => {
    for (const manager of managers) await manager.dispose();
  });
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) => managers[i % 2].access(state.key)),
  );
  assert.equal(
    results.every((result) => result.status === 'rejected'),
    true,
  );
  assert.equal(
    calls,
    1,
    'writer serialization must not turn waiters into sequential write replays',
  );
  assert.equal((await state.accounts.registration(state.key)).refreshToken, 'old-refresh');
});

test('an unconfirmed generation remains blocked after manager recreation, without deleting tokens', async (t) => {
  let calls = 0;
  const state = await setup({
    refresh: async () => {
      calls++;
      throw new SiwcError('AUTH_REQUEST_UNCONFIRMED', 502);
    },
  });
  const first = state.manager();
  await assert.rejects(first.access(state.key));
  await first.dispose();
  const next = state.manager();
  t.after(() => next.dispose());
  await assert.rejects(next.access(state.key));
  assert.equal(calls, 1);
  assert.equal((await state.accounts.registration(state.key)).refreshToken, 'old-refresh');
});

test('a post-issuance identity validation failure cannot authorize reusing the old refresh token', async (t) => {
  let calls = 0;
  const state = await setup({
    refresh: async () => {
      calls++;
      throw new SiwcError('ACCOUNT_MISMATCH', 502);
    },
  });
  const first = state.manager();
  await assert.rejects(first.access(state.key));
  await first.dispose();
  const next = state.manager();
  t.after(() => next.dispose());
  await assert.rejects(next.access(state.key));
  assert.equal(calls, 1);
  assert.equal((await state.accounts.registration(state.key)).refreshToken, 'old-refresh');
});

test('a failed replacement commit leaves a durable fence rather than a reusable old generation', async (t) => {
  const credentials = new MemoryCredentials();
  const originalModify = credentials.modifyRecord.bind(credentials);
  credentials.modifyRecord = (key, action) =>
    originalModify(key, async (current) => {
      const result = await action(current);
      if (result?.payload?.accessToken === 'replacement-access')
        throw Error('synthetic storage failure');
      return result;
    });
  let calls = 0;
  const protocol = {
    refresh: async (previous) => {
      calls++;
      return {
        ...previous,
        accessToken: 'replacement-access',
        refreshToken: 'replacement-refresh',
        expiresAt: NOW + 3600000,
      };
    },
  };
  const state = await setup(protocol, credentials);
  const first = new SessionManager({ accounts: state.accounts, protocol, now: () => NOW });
  await assert.rejects(first.access(state.key));
  await first.dispose();
  const next = state.manager();
  t.after(() => next.dispose());
  await assert.rejects(next.access(state.key));
  assert.equal(calls, 1);
  assert.equal((await state.accounts.registration(state.key)).refreshToken, 'old-refresh');
});
