import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelCache } from '../src/siwc/model-cache.js';
import { AccountStore } from '../src/siwc/accounts.js';
import { SessionManager } from '../src/siwc/sessions.js';
import { createAdapterClass } from '../src/siwc/adapter.js';
import { SiwcError, ISSUER, DIRECT_SCOPE, digest } from '../src/siwc/protocol.js';
import { PROVIDER } from '../src/siwc/controller.js';
import { CLIENT, NOW, MemoryCredentials } from './siwc-fixtures.js';
class LlmError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}
const Adapter = createAdapterClass({
  LlmAdapter: class {},
  LlmError,
  attributionHeaders: () => ({}),
});
const model = {
  provider: PROVIDER,
  id: 'fixture-model',
  name: 'Verified model',
  reasoning: {
    efforts: [
      { id: 'low', name: 'Low' },
      { id: 'high', name: 'High' },
    ],
    defaultEffort: 'low',
  },
};

async function fixture(t, { root, renewal, expiresAt = NOW + 120000 } = {}) {
  let now = NOW,
    refreshes = 0,
    catalogs = 0;
  const accounts = new AccountStore(new MemoryCredentials());
  const key = await accounts.beginRegistration(CLIENT);
  await accounts.saveValidated({
    issuer: ISSUER,
    subject: 'synthetic-subject',
    clientId: CLIENT,
    scopes: [DIRECT_SCOPE],
    accessToken: 'synthetic-access',
    refreshToken: 'synthetic-refresh',
    idToken: 'synthetic-id',
    expiresAt,
  });
  await accounts.select(key);
  const cache = new ModelCache({ root, now: () => now });
  const sessions = new SessionManager({
    accounts,
    now: () => now,
    protocol: {
      async refresh(previous) {
        refreshes++;
        if (renewal) return renewal(previous);
        throw new SiwcError('AUTH_REQUEST_UNCONFIRMED', 502);
      },
    },
  });
  const adapter = new Adapter({
    accounts,
    sessions,
    now: () => now,
    catalogCache: cache,
    fetchImpl: async (url) => {
      assert.ok(url.endsWith('/models'), 'no real inference in catalog fixture');
      catalogs++;
      return Response.json({
        models: [
          {
            slug: model.id,
            display_name: model.name,
            visibility: 'list',
            supported_reasoning_levels: ['low', 'high'],
            default_reasoning_level: 'low',
            context_window: 4096,
            input_modalities: ['text'],
          },
        ],
      });
    },
  });
  t.after(async () => {
    adapter.dispose();
    await sessions.dispose();
    await cache.dispose();
  });
  return {
    accounts,
    key,
    cache,
    sessions,
    adapter,
    expire() {
      now += 180000;
    },
    counts: () => ({ refreshes, catalogs }),
  };
}

test('persistent catalog contains only verified selection metadata, not credentials or authoritative capabilities', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'siwc-model-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scope = digest('synthetic host/account/subject'),
    cache = new ModelCache({ root, now: () => NOW });
  await cache.set(scope, [
    {
      ...model,
      context: { contextWindow: 4096 },
      inputModalities: ['text'],
      accessToken: 'MUST_NOT_PERSIST',
    },
  ]);
  const bytes = await readFile(join(root, scope + '.json'), 'utf8');
  assert.doesNotMatch(bytes, /MUST_NOT_PERSIST|accessToken|contextWindow|inputModalities/);
  const second = new ModelCache({ root });
  assert.deepEqual((await second.get(scope)).models, [model]);
  assert.equal(await second.get(digest('another profile/account/subject')), undefined);
  await cache.dispose();
  await second.dispose();
});

test('corrupt, foreign-scope and unsupported cache envelopes are misses, not provider failures', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'siwc-model-cache-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scope = digest('synthetic scope'),
    path = join(root, scope + '.json');
  for (const value of [
    'not JSON',
    JSON.stringify({ schema: 1, scope: digest('foreign'), cachedAt: NOW, models: [model] }),
    JSON.stringify({ schema: 999, scope, cachedAt: NOW, models: [model] }),
  ]) {
    await writeFile(path, value);
    const cache = new ModelCache({ root });
    assert.equal(await cache.get(scope), undefined);
    await cache.dispose();
  }
});

test('expired access and stale catalog do not renew during local model/effort selection, while preparation remains strict', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.adapter.listModels(PROVIDER))[0].id, model.id);
  f.expire();
  assert.deepEqual((await f.adapter.listModels(PROVIDER))[0], model);
  assert.deepEqual((await f.adapter.resolveModel(PROVIDER, model.id)).reasoning, model.reasoning);
  assert.deepEqual(f.counts(), { refreshes: 0, catalogs: 1 });
  await assert.rejects(f.adapter.prepareCall(PROVIDER, model.id), {
    code: 'AUTH_REQUEST_UNCONFIRMED',
  });
  await assert.rejects(f.adapter.prepareCall(PROVIDER, model.id), {
    code: 'ACCOUNT_RENEWAL_UNCONFIRMED',
  });
  assert.equal((await f.adapter.listModels(PROVIDER))[0].id, model.id);
  assert.deepEqual(f.counts(), { refreshes: 1, catalogs: 1 });
});

test('a recreated adapter reads the retained catalog without renewing an uncertain grant', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'siwc-catalog-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = await fixture(t, { root });
  await f.adapter.listModels(PROVIDER);
  await f.cache.set((await f.accounts.catalogScope(await f.accounts.selection())).scope, [model]);
  f.expire();
  await assert.rejects(f.adapter.prepareCall(PROVIDER, model.id));
  const cache = new ModelCache({ root }),
    adapter = new Adapter({
      accounts: f.accounts,
      sessions: f.sessions,
      catalogCache: cache,
      now: () => NOW + 180000,
      fetchImpl: async () => assert.fail('retained selection must not request the network'),
    });
  t.after(async () => {
    adapter.dispose();
    await cache.dispose();
  });
  assert.deepEqual(await adapter.listModels(PROVIDER), [model]);
  assert.equal(adapter.directoryStatus.cached, true);
  await assert.rejects(adapter.prepareCall(PROVIDER, model.id), {
    code: 'ACCOUNT_RENEWAL_UNCONFIRMED',
  });
  assert.deepEqual(f.counts(), { refreshes: 1, catalogs: 1 });
});

test('retained catalog cannot cross selection/account permissions or become inference authority', async (t) => {
  const f = await fixture(t);
  await f.adapter.listModels(PROVIDER);
  f.expire();
  const initial = await f.accounts.catalogScope(await f.accounts.selection());
  const secondKey = await f.accounts.beginRegistration(CLIENT + '_second');
  await f.accounts.saveValidated({
    issuer: ISSUER,
    subject: 'second-subject',
    clientId: CLIENT + '_second',
    scopes: [DIRECT_SCOPE],
    accessToken: 'synthetic-second',
    idToken: 'synthetic-second-id',
    expiresAt: NOW - 1,
  });
  await f.accounts.select(secondKey);
  assert.equal(
    await f.cache.get((await f.accounts.catalogScope(await f.accounts.selection())).scope),
    undefined,
  );
  await assert.rejects(f.adapter.listModels(PROVIDER), { code: 'ACCOUNT_REFRESH_REQUIRED' });
  assert.deepEqual(f.counts(), { refreshes: 0, catalogs: 1 });
  await f.accounts.select(f.key);
  await f.accounts.credentials.modifyRecord(f.key, (current) => ({
    ...current,
    payload: { ...current.payload, status: 'disabled', scopes: [] },
  }));
  assert.equal((await f.accounts.catalogScope(await f.accounts.selection())).scope, initial.scope);
  await assert.rejects(f.adapter.listModels(PROVIDER), { code: 'DIRECT_PERMISSION_MISSING' });
  assert.deepEqual(f.counts(), { refreshes: 0, catalogs: 1 });
});

test('a warm directory cannot hide a required refresh from actual preparation', async (t) => {
  const f = await fixture(t, {
    expiresAt: NOW + 59000,
    renewal: (old) => ({
      ...old,
      accessToken: 'synthetic-renewed',
      refreshToken: 'synthetic-renewed-refresh',
      expiresAt: NOW + 3600000,
    }),
  });
  await f.adapter.listModels(PROVIDER);
  assert.deepEqual(f.counts(), { refreshes: 0, catalogs: 1 });
  const prepared = await f.adapter.prepareCall(PROVIDER, model.id);
  assert.equal(prepared.model.id, model.id);
  assert.deepEqual(f.counts(), { refreshes: 1, catalogs: 2 });
});

test('persisted effort choices cannot authorize an unsupported effort on the actual fresh contract', async (t) => {
  const f = await fixture(t);
  await f.adapter.listModels(PROVIDER);
  f.expire();
  const adapter = new Adapter({
    accounts: f.accounts,
    sessions: new SessionManager({ accounts: f.accounts, now: () => NOW, protocol: {} }),
    now: () => NOW,
    catalogCache: f.cache,
    fetchImpl: async (url) => {
      assert.ok(url.endsWith('/models'), 'unsupported effort must never send inference');
      return Response.json({
        models: [{ slug: model.id, visibility: 'list', supported_reasoning_levels: ['low'] }],
      });
    },
  });
  t.after(() => adapter.dispose());
  const rows = await adapter.listModels(PROVIDER);
  assert.equal(
    rows[0].reasoning.efforts.some((e) => e.id === 'high'),
    true,
  );
  const prepared = await adapter.prepareCall(PROVIDER, model.id),
    chunks = [];
  for await (const chunk of prepared.stream({
    provider: PROVIDER,
    model: model.id,
    reasoningEffort: 'high',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic only' }] }],
  }))
    chunks.push(chunk);
  assert.equal(chunks.at(-1).reason.failure.code, 'MODEL_CATALOG_CHANGED');
});

test('only explicit authorization maintenance forces a still-valid grant to rotate, without inference', async (t) => {
  const f = await fixture(t, {
    renewal: (old) => ({
      ...old,
      accessToken: 'synthetic-renewed',
      refreshToken: 'synthetic-renewed-refresh',
      expiresAt: NOW + 3600000,
    }),
  });
  await f.adapter.listModels(PROVIDER);
  assert.deepEqual(await f.adapter.refreshModels(), { count: 1, authorizationRenewed: false });
  assert.deepEqual(f.counts(), { refreshes: 0, catalogs: 2 });
  assert.deepEqual(await f.adapter.refreshModels(undefined, { renewAuthorization: true }), {
    count: 1,
    authorizationRenewed: true,
  });
  assert.deepEqual(f.counts(), { refreshes: 1, catalogs: 3 });
});
