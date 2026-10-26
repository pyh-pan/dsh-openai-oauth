import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDshVersion, assertHostContract } from '../src/compatibility.js';
import { createHostPlugin } from '../src/siwc/host.js';
import { API_PATH, PROVIDER } from '../src/siwc/controller.js';

for (const [expected, versions] of Object.entries({
  validated: ['0.2.0-rc.2', '0.2.1-rc.1', '0.2.1-rc.2'],
  compatible: [
    '0.2.0-rc.2+rebuild',
    '0.2.0-rc.3',
    '0.2.0',
    '0.2.1-alpha.1',
    '0.2.1-rc.3',
    '0.2.1-rc.999999999999999999999',
    '0.2.2-alpha.1',
    '0.2.99',
    '0.3.0-0',
    '0.3.0-rc.1',
    '0.3.0',
    '1.0.0',
    '9.0.0',
  ],
  unsupported: ['0.1.99', '0.2.0-alpha.1', '0.2.0-rc.1', '0.2.0-rc.1.9'],
  unknown: ['nightly', '0.02.1', '0.2.1-rc.03', '0.2.1\n', '', undefined, null, 2],
}))
  test(`release evidence distinguishes ${expected} without an upper admission limit`, () => {
    for (const version of versions)
      assert.equal(classifyDshVersion(version), expected, String(version));
  });

function fixture({
  version = '0.2.1-rc.3',
  denyGuests = true,
  denyOwners = false,
  stalled = false,
  integration,
  connectionNative,
} = {}) {
  const trace = [],
    cleanup = [],
    routes = new Map();
  const native = {
    APP_IDENTITY: { version },
    LlmAdapter: class {},
    LlmError: class extends Error {},
    attributionHeaders: () => ({ 'user-agent': 'DSH-test' }),
  };
  const forbidden = () => {
    throw Error('No credential access during admission');
  };
  const ctx = {
    effect(start) {
      cleanup.push(start());
    },
    on() {},
    logger: { warn() {} },
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
      { installPresetIntegration: integration, connectionNative },
    );
  const dispose = async () => {
    for (const fn of cleanup) await fn();
  };
  const response = () => routes.get(API_PATH).fetch(new Request(`http://localhost${API_PATH}`));
  return { ctx, native, plugin, trace, dispose, routes, response };
}

test('changing only release metadata preserves owner admission, integration and provider registration', async () => {
  for (const version of [
    '0.2.0-rc.2',
    '0.2.1-rc.2',
    '0.2.1-rc.3',
    '0.3.0-rc.1',
    '1.0.0',
    'nightly',
    undefined,
  ]) {
    let f;
    f = fixture({
      version,
      integration: async () => {
        f.trace.push('integration');
        return { assertCoverage() {} };
      },
    });
    if (version === undefined) delete f.native.APP_IDENTITY;
    await f.plugin().apply(f.ctx);
    assert.deepEqual(
      f.trace,
      ['guest:GET', 'owner:GET', 'guest:POST', 'owner:POST', 'integration', 'runtime', 'adapter'],
      String(version),
    );
    const response = await f.response();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).protocol, 'siwc');
    await f.dispose();
    assert.equal((await f.response()).status, 410);
  }
});

test('owner boundary failures remain inert and return a fixed JSON diagnostic', async () => {
  for (const options of [{ denyGuests: false }, { denyOwners: true }]) {
    const f = fixture(options);
    await assert.rejects(f.plugin().apply(f.ctx), /DSH_CONNECTION_OWNER_BOUNDARY_CHANGED/);
    assert.ok(!f.trace.includes('runtime') && !f.trace.includes('adapter'));
    const response = await f.response();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'DSH_CONNECTION_OWNER_BOUNDARY_CHANGED' });
    await f.dispose();
  }
});

test('missing necessary methods and a proven below-floor Host fail before account access', async () => {
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
  const f = fixture({ version: '0.2.0-rc.1' });
  await assert.rejects(f.plugin().apply(f.ctx), /UNSUPPORTED_DSH_VERSION/);
  assert.equal(f.routes.size, 0);
});

test('necessary native exports and the actual Llm class identity are checked, not version equality', () => {
  for (const name of ['LlmAdapter', 'LlmError', 'attributionHeaders']) {
    const f = fixture();
    delete f.native[name];
    assert.throws(() => f.plugin(), /DSH_HOST_CONTRACT_MISSING/);
  }
  const f = fixture();
  delete f.native.APP_IDENTITY;
  assert.doesNotThrow(() => assertHostContract(f.native, f.ctx));
  f.native.default = class Llm {};
  assert.throws(() => assertHostContract(f.native, f.ctx), /llm.runtime-instance/);
  Object.setPrototypeOf(f.ctx.llm, f.native.default.prototype);
  assert.doesNotThrow(() => assertHostContract(f.native, f.ctx));
});

test('a stalled owner probe is bounded without opening accounts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ stalled: true });
  const applying = f.plugin().apply(f.ctx);
  t.mock.timers.tick(5000);
  await assert.rejects(applying, /DSH_CONNECTION_OWNER_BOUNDARY_TIMEOUT/);
  assert.ok(!f.trace.includes('runtime'));
  await f.dispose();
});

test('disposal during a pending owner probe cannot initialize a late account runtime', async () => {
  const f = fixture();
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

test('the actual operator-only carrier remains supported independently of release labels', async () => {
  class OperatorPeer {}
  for (const version of ['0.2.0-rc.2', '0.3.0', undefined]) {
    const f = fixture({ version, connectionNative: { OperatorPeer } });
    f.ctx.connection.operator = new OperatorPeer();
    f.ctx.connection.admit = () => ({ rejection: 401 });
    f.ctx.connection.requestRejection = () => 401;
    f.ctx.connection.createSharedFetchHandler = () => ({
      fetch: (request) => f.routes.get(API_PATH).fetch(request),
    });
    await f.plugin().apply(f.ctx);
    assert.ok(f.trace.includes('runtime') && f.trace.includes('adapter'));
    await f.dispose();
  }
});

test('a missing preset Interface blocks session coverage, not account settings', async () => {
  const f = fixture({
    integration: async () => {
      throw Error('PRIVATE_NATIVE_PATH');
    },
  });
  await f.plugin().apply(f.ctx);
  assert.ok(f.trace.includes('adapter'));
  const response = await f.response();
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.coverage.status, 'unavailable');
  assert.equal(state.coverage.code, 'DSH_SIWC_PRESET_CONTRACT_MISSING');
  assert.ok(!JSON.stringify(state).includes('PRIVATE_NATIVE_PATH'));
  await f.dispose();
});

test('unload during preset reconciliation cannot create a late runtime', async () => {
  let release,
    entered = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture({
    integration: async () => {
      entered = true;
      await gate;
      return { assertCoverage() {} };
    },
  });
  const applying = f.plugin().apply(f.ctx);
  for (let i = 0; i < 50 && !entered; i++) await Promise.resolve();
  assert.equal(entered, true);
  await f.dispose();
  release();
  await applying;
  assert.ok(!f.trace.includes('runtime') && !f.trace.includes('adapter'));
});
