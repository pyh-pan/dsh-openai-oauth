import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { AccountStore } from '../src/siwc/accounts.js';
import { SessionManager } from '../src/siwc/sessions.js';
import { DIRECT_SCOPE, ISSUER, SiwcError } from '../src/siwc/protocol.js';
import { CLIENT, NOW, MemoryCredentials } from './siwc-fixtures.js';
async function setup(
  t,
  protocol,
  { credentials = new MemoryCredentials(), expiresAt = NOW - 1 } = {},
) {
  let now = NOW;
  const accounts = new AccountStore(credentials, { now: () => now });
  const key = await accounts.beginRegistration(CLIENT);
  const grant = {
    issuer: ISSUER,
    subject: 'boundary-fixture',
    clientId: CLIENT,
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    idToken: 'old-id',
    scopes: [DIRECT_SCOPE],
    expiresAt,
  };
  await accounts.saveValidated(grant);
  await accounts.select(key);
  const managers = [];
  const manager = () => {
    const value = new SessionManager({ accounts, protocol, now: () => now, revokeBackoffMs: 1 });
    managers.push(value);
    return value;
  };
  t.after(async () => {
    for (const value of managers) await value.dispose();
  });
  return {
    accounts,
    key,
    credentials,
    grant,
    manager,
    advance(ms) {
      now += ms;
    },
  };
}

test('proven not-sent failures merge waiters, preserve valid read-only access and permit one later retry', async (t) => {
  let calls = 0,
    ready = false;
  const f = await setup(
    t,
    {
      async refresh(old) {
        calls++;
        if (!ready) {
          const error = new SiwcError('AUTH_DNS_FAILED', 502);
          error.renewalOutcome = 'not_sent';
          throw error;
        }
        return {
          ...old,
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          expiresAt: NOW + 3600000,
        };
      },
    },
    { expiresAt: NOW + 59000 },
  );
  const a = f.manager(),
    b = f.manager();
  const failures = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).access(f.key)),
  );
  assert.ok(failures.every((value) => value.status === 'rejected'));
  assert.equal(calls, 1);
  assert.equal(
    (await a.access(f.key, { allowNearExpiry: true, allowRefresh: false })).accessToken,
    'old-access',
  );
  assert.equal(calls, 1);
  f.advance(1001);
  ready = true;
  const values = await Promise.all(
    Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).access(f.key)),
  );
  assert.ok(values.every((value) => value.accessToken === 'new-access'));
  assert.equal(calls, 2);
});

test('malformed or foreign-generation renewal markers cannot authorize a replay', async (t) => {
  let calls = 0;
  const f = await setup(t, {
    async refresh() {
      calls++;
      assert.fail('must not refresh malformed state');
    },
  });
  await f.credentials.modifyRecord(f.key, (current) => ({
    ...current,
    payload: {
      ...current.payload,
      renewal: { state: 'retryable', generation: 999, failureCode: 'AUTH_DNS_FAILED', retryAt: 0 },
    },
  }));
  await assert.rejects(f.manager().access(f.key), { code: 'ACCOUNT_RECORD_INVALID' });
  assert.equal(calls, 0);
});

test('legacy accounts are fenced with schema v2 before any rotating request; old readers cannot ignore the marker', async (t) => {
  let calls = 0;
  const f = await setup(t, {
    async refresh(old) {
      calls++;
      assert.equal(old.schema, 2);
      throw new SiwcError('AUTH_REQUEST_UNCONFIRMED', 502);
    },
  });
  await f.credentials.modifyRecord(f.key, (current) => {
    const { credentialGeneration, ...legacy } = current.payload;
    return { ...current, payload: { ...legacy, schema: 1 } };
  });
  await assert.rejects(f.manager().access(f.key), { code: 'AUTH_REQUEST_UNCONFIRMED' });
  const saved = await f.credentials.readRecord(f.key);
  assert.equal(saved.payload.schema, 2);
  assert.equal(saved.payload.renewal.state, 'uncertain');
  const legacyRead = (value) =>
    value?.kind === 'grant' && value.payload?.schema === 1 ? value.payload : undefined;
  assert.equal(legacyRead(saved), undefined);
  assert.equal(calls, 1);
});

test('a replacement cannot overwrite a newer verified authorization', async (t) => {
  let enter, release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const f = await setup(t, {
    async refresh(old) {
      enter();
      await held;
      return {
        ...old,
        accessToken: 'late-access',
        refreshToken: 'late-refresh',
        expiresAt: NOW + 3600000,
      };
    },
  });
  const pending = assert.rejects(f.manager().access(f.key), { code: 'ACCOUNT_CHANGED' });
  await entered;
  await f.accounts.saveValidated({
    ...f.grant,
    accessToken: 'explicit-new-access',
    refreshToken: 'explicit-new-refresh',
    expiresAt: NOW + 7200000,
  });
  release();
  await pending;
  assert.equal((await f.accounts.registration(f.key)).refreshToken, 'explicit-new-refresh');
});

test('failed local clear after confirmed revocation remains fenced across recreation and metadata acknowledgement', async (t) => {
  const credentials = new MemoryCredentials(),
    modify = credentials.modifyRecord.bind(credentials);
  credentials.modifyRecord = (key, action) =>
    modify(key, async (current) => {
      const value = await action(current);
      if (value?.payload?.status === 'signed-out') throw Error('synthetic clear failure');
      return value;
    });
  let revokes = 0,
    refreshes = 0;
  const f = await setup(
    t,
    {
      async revoke() {
        revokes++;
      },
      async refresh() {
        refreshes++;
        assert.fail('revoked generation must not renew');
      },
    },
    { credentials, expiresAt: NOW + 3600000 },
  );
  await assert.rejects(f.manager().logout(f.key), { code: 'ACCOUNT_STORAGE_FAILED' });
  assert.equal(revokes, 1);
  assert.equal((await f.accounts.registration(f.key)).renewal.state, 'revoking');
  await f.accounts.acknowledgeWelcome(f.key);
  const next = f.manager();
  await next.accountChanged(f.key);
  await assert.rejects(next.access(f.key), { code: 'ACCOUNT_SIGNED_OUT' });
  assert.equal(refreshes, 0);
});

test('revocation does not hold the shared credential-file lock during network work', async (t) => {
  let credentials;
  const f = await setup(t, {
    async revoke() {
      await credentials.modifyRecord('another-provider/sentinel', () => ({
        kind: 'grant',
        payload: { synthetic: true },
      }));
      await pause(1);
    },
  });
  credentials = f.credentials;
  const result = await f.manager().logout(f.key);
  assert.equal(result.remoteConfirmed, true);
  assert.deepEqual((await credentials.readRecord('another-provider/sentinel')).payload, {
    synthetic: true,
  });
});

test('a deadline consumed by claim storage cannot be misreported as a possibly sent renewal', async (t) => {
  const credentials = new MemoryCredentials(),
    modify = credentials.modifyRecord.bind(credentials);
  let calls = 0;
  credentials.modifyRecord = (key, action) =>
    modify(key, async (current) => {
      const value = await action(current);
      if (value?.payload?.renewal?.state === 'pending') await pause(35);
      return value;
    });
  const f = await setup(
    t,
    {
      async refresh() {
        calls++;
        assert.fail('expired maintenance must not invoke protocol');
      },
    },
    { credentials },
  );
  const manager = new SessionManager({
    accounts: f.accounts,
    now: () => NOW,
    maintenanceTimeoutMs: 15,
    protocol: {
      async refresh() {
        calls++;
      },
    },
  });
  t.after(() => manager.dispose());
  await assert.rejects(manager.access(f.key), { code: 'AUTH_NETWORK_TIMEOUT' });
  assert.equal(calls, 0);
  assert.equal((await f.accounts.registration(f.key)).renewal.state, 'retryable');
});

test('sign-out without a renewable token cannot claim remote confirmation', async (t) => {
  let calls = 0;
  const f = await setup(
    t,
    {
      async revoke() {
        calls++;
      },
    },
    { expiresAt: NOW + 3600000 },
  );
  await f.accounts.saveValidated({ ...f.grant, refreshToken: undefined });
  const result = await f.manager().logout(f.key);
  assert.equal(calls, 0);
  assert.deepEqual(result, {
    remoteConfirmed: false,
    warning: 'REMOTE_REVOCATION_UNCONFIRMED',
    reason: 'NO_RENEWABLE_TOKEN',
  });
  assert.equal((await f.accounts.registration(f.key)).accessToken, undefined);
});

test('a second local sign-out after unknown remote revocation cannot turn the result green', async (t) => {
  let calls = 0;
  const f = await setup(t, {
    async revoke() {
      calls++;
      throw new SiwcError('REVOCATION_FAILED', 502);
    },
  });
  const manager = f.manager();
  assert.equal((await manager.logout(f.key)).remoteConfirmed, false);
  const second = await manager.logout(f.key);
  assert.equal(calls, 1);
  assert.equal(second.remoteConfirmed, false);
  assert.equal(second.warning, 'REMOTE_REVOCATION_UNCONFIRMED');
  assert.equal(second.reason, 'NO_RENEWABLE_TOKEN');
});
