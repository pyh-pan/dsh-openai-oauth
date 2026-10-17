import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDshVersion,
  assertHostContract,
  HOST_VERSION_FIELDS,
} from '../src/compatibility.js';
import { validateRunningCandidate } from '../src/desktop-preflight.js';
import { createHostPlugin } from '../src/siwc/host.js';
import { API_PATH, PROVIDER } from '../src/siwc/controller.js';

for (const [expected, versions] of Object.entries({
  validated: ['0.2.0-rc.2', '0.2.1-rc.1', '0.2.1-rc.2'],
  candidate: [
    '0.2.0-rc.2+rebuild',
    '0.2.1-rc.3',
    '0.2.1-rc.1.0',
    '0.2.1-rc.999999999999999999999',
    '0.2.1',
    '0.2.1+build.7',
    '0.2.2-alpha.1',
    '0.2.2-beta.1',
    '0.2.2-rc.1',
    '0.2.9',
    '0.2.99',
  ],
  unsupported: [
    '0.2.0-rc.1',
    '0.2.0-rc.3',
    '0.2.0',
    '0.2.1-alpha.1',
    '0.2.1-beta.3',
    '0.2.1-rc',
    '0.2.1-rc.0',
    '0.3.0-0',
    '0.3.0-alpha.1',
    '0.3.0-rc.1',
    '0.3.0',
    '1.0.0',
    'v0.2.1',
    '0.02.1',
    '0.2.01',
    '0.2.1-rc.03',
    '0.2.1+',
    '0.2.1-rc..2',
    '0.2.1\n',
    '0.2.999999999999999999999',
    '',
    undefined,
    null,
    2,
  ],
}))
  test(`version policy distinguishes ${expected} releases without promoting candidates`, () => {
    for (const version of versions)
      assert.equal(classifyDshVersion(version), expected, String(version));
  });

function fixture({
  version = '0.2.1-rc.3',
  denyGuests = true,
  denyOwners = false,
  stalled = false,
  preflight = async () => {},
} = {}) {
  const trace = [];
  const cleanup = [];
  const routes = new Map();
  const native = {
    APP_IDENTITY: { version },
    LlmAdapter: class {},
    LlmError: class extends Error {},
    attributionHeaders: () => ({ 'user-agent': 'DSH-test' }),
  };
  const forbidden = () => {
    throw new Error('fixture credentials must not be accessed during startup');
  };
  const ctx = {
    effect(start) {
      cleanup.push(start());
    },
    on() {},
    credentials: { readRecord: forbidden, listRecords: forbidden, modifyRecord: forbidden },
    llm: {
      registerAdapter(providers) {
        trace.push('adapter');
        assert.deepEqual(providers, [PROVIDER]);
        return { replace() {} };
      },
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route);
        },
      },
      createSharedFetchHandler() {
        return {
          async fetch(request, peer) {
            trace.push(`${peer.principal.kind}:${request.method}`);
            if (stalled) return new Promise(() => {});
            if (
              (peer.principal.kind === 'guest' && denyGuests) ||
              (peer.principal.kind === 'owner' && denyOwners)
            )
              return new Response(null, { status: 403 });
            return routes.get(new URL(request.url).pathname).fetch(request);
          },
        };
      },
    },
  };
  const plugin = () =>
    createHostPlugin(
      native,
      () => {
        trace.push('runtime');
        return {
          accounts: { accounts: async () => [], selection: async () => undefined },
          protocol: {},
          sessions: {
            dispose: async () => {
              trace.push('disposed');
            },
          },
        };
      },
      { verifyCandidate: preflight },
    );
  const dispose = async () => {
    for (const fn of cleanup) await fn();
  };
  return { ctx, native, plugin, trace, dispose, routes };
}

test('candidate startup verifies guest denial AND owner access before creating the account runtime', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const f = fixture();
  await f.plugin().apply(f.ctx);
  assert.deepEqual(f.trace, [
    'guest:GET',
    'owner:GET',
    'guest:POST',
    'owner:POST',
    'runtime',
    'adapter',
  ]);
  assert.equal(console.warn.mock.calls.length, 1);
  const response = await f.routes.get(API_PATH).fetch(new Request(`http://localhost${API_PATH}`));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).protocol, 'siwc');
  await f.dispose();
  assert.equal(
    (await f.routes.get(API_PATH).fetch(new Request(`http://localhost${API_PATH}`))).status,
    410,
  );
});

test('changed owner semantics fail closed without touching the account runtime or registering a provider', async () => {
  for (const options of [{ denyGuests: false }, { denyOwners: true }]) {
    const f = fixture(options);
    await assert.rejects(f.plugin().apply(f.ctx), /DSH_CONNECTION_OWNER_BOUNDARY_CHANGED/);
    assert.ok(!f.trace.includes('runtime'));
    assert.ok(!f.trace.includes('adapter'));
    const response = await f.routes.get(API_PATH).fetch(new Request(`http://localhost${API_PATH}`));
    assert.equal(response.status, 503);
    await f.dispose();
  }
});

test('missing service methods and outside-family versions fail before route registration or account access', async () => {
  for (const [service, method] of [
    ['credentials', 'readRecord'],
    ['credentials', 'modifyRecord'],
    ['credentials', 'listRecords'],
    ['llm', 'registerAdapter'],
    ['connection', 'createSharedFetchHandler'],
  ]) {
    const f = fixture();
    delete f.ctx[service][method];
    await assert.rejects(f.plugin().apply(f.ctx), /DSH_HOST_CONTRACT_MISSING/);
    assert.equal(f.routes.size, 0);
    assert.deepEqual(f.trace, []);
  }
  const f = fixture({ version: '0.3.0-rc.1' });
  await assert.rejects(f.plugin().apply(f.ctx), /UNSUPPORTED_DSH_VERSION/);
  assert.equal(f.routes.size, 0);
});

test('missing Llm exports produce a safe contract diagnostic, not a low-level subclass error', () => {
  for (const name of ['LlmAdapter', 'LlmError', 'attributionHeaders']) {
    const f = fixture();
    delete f.native[name];
    assert.throws(() => f.plugin(), /DSH_HOST_CONTRACT_MISSING/);
  }
  const f = fixture();
  delete f.native.APP_IDENTITY;
  assert.throws(() => assertHostContract(f.native, f.ctx), /UNSUPPORTED_DSH_VERSION/);
});

test('a stalled local owner probe times out without opening the runtime', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ version: '0.2.1-rc.2', stalled: true });
  const applying = f.plugin().apply(f.ctx);
  t.mock.timers.tick(5000);
  await assert.rejects(applying, /DSH_CONNECTION_OWNER_BOUNDARY_TIMEOUT/);
  assert.ok(!f.trace.includes('runtime'));
  await f.dispose();
});

test('disposal during a pending owner probe cannot initialize a late account runtime', async () => {
  const f = fixture({ version: '0.2.1-rc.2' });
  let release;
  f.ctx.connection.createSharedFetchHandler = () => ({
    fetch: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const applying = f.plugin().apply(f.ctx);
  await f.dispose();
  release(new Response(null, { status: 403 }));
  await applying;
  assert.deepEqual(f.trace, []);
});

test('the historical 0.2.0 baseline remains separate from the newer owner-carrier contract', async () => {
  const f = fixture({ version: '0.2.0-rc.2' });
  await f.plugin().apply(f.ctx);
  assert.deepEqual(f.trace, ['runtime', 'adapter']);
  await f.dispose();
});

test('direct-update candidates require successful isolated preflight before routes or real account runtime', async () => {
  for (const preflight of [
    null,
    async () => {
      throw new Error('DSH_CANDIDATE_NATIVE_CHECK_FAILED');
    },
  ]) {
    const f = fixture({ preflight });
    await assert.rejects(
      f.plugin().apply(f.ctx),
      /DSH_CANDIDATE_VALIDATION_REQUIRED|DSH_CANDIDATE_NATIVE_CHECK_FAILED/,
    );
    assert.equal(f.routes.size, 0);
    assert.deepEqual(f.trace, []);
    await f.dispose();
  }
});

test('unload while candidate preflight is pending never initializes the account runtime', async () => {
  let release;
  const f = fixture({
    preflight: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const applying = f.plugin().apply(f.ctx);
  await f.dispose();
  release();
  await applying;
  assert.equal(f.routes.size, 0);
  assert.deepEqual(f.trace, []);
});

test('production candidate preflight pins the running executable and rejects installation/version drift', () => {
  const info = (version) => ({
    desktopVersion: version,
    ...Object.fromEntries(HOST_VERSION_FIELDS.map((field) => [field, version])),
    contractIssues: [],
  });
  const checked = [];
  const host = { fixture: 'running-installation' };
  const options = {
    executable: 'D:\\Applications\\Harness.exe',
    platform: 'win32',
    find(input) {
      assert.deepEqual(input, {
        platform: 'win32',
        env: { DSH_APP: 'D:\\Applications\\Harness.exe' },
      });
      return host;
    },
    inspect(input) {
      assert.equal(input, host);
      return info('0.2.2');
    },
    check(input) {
      checked.push(input);
    },
  };
  validateRunningCandidate('0.2.2', options);
  assert.deepEqual(checked, [host]);
  for (const metadataVersion of ['0.2.1-rc.2', '0.2.3', '0.3.0']) {
    assert.throws(
      () =>
        validateRunningCandidate('0.2.2', {
          ...options,
          inspect: () => info(metadataVersion),
        }),
      /DSH_RUNNING_INSTALLATION_MISMATCH/,
    );
  }
  assert.equal(checked.length, 1);
});
