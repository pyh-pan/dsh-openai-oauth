import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { AUTH_NETWORK_MESSAGES } from '../src/siwc/auth-network.js';
import { ATTACHMENT_MESSAGES } from '../src/siwc/attachments.js';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');

function loadPlugin(react = {}, globals = {}) {
  let plugin;
  runInNewContext(source, {
    window: {
      addEventListener() {},
      removeEventListener() {},
      __ModuleLoader__: {
        load({ id, factory }) {
          assert.equal(id, manifest.name);
          plugin = factory((name) => {
            assert.equal(name, 'react');
            return react;
          });
        },
      },
    },
    ...globals,
  });
  return plugin;
}

test('client keeps native settings and model-directory hooks without switching the model', () => {
  const plugin = loadPlugin();
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'locale']);
  assert.equal(manifest.dsh.client.immediately, true);
  for (const name of ['settings-models', 'model-selection', 'locale'])
    assert.ok(
      manifest.dsh.client.inject.includes(
        `@deepseek-ai/dsh-client-${name === 'locale' ? '' : 'ui-'}${name}`,
      ),
    );
  const slots = [];
  const localeBindings = [];
  const registrations = [];
  const directory = { fixture: 'existing-session-directory', subscribe() {}, getSnapshot() {} };
  const ctx = {
    effect(effect) {
      effect();
    },
    locale: {
      register(namespace, messages) {
        registrations.push({ namespace, messages });
      },
      bind(namespace) {
        localeBindings.push(namespace);
        return 'fixture-translator';
      },
    },
    slots: {
      inject(name, register) {
        assert.ok(['settings.models.footer', 'conversation.composer.dock'].includes(name));
        register();
      },
      register(options, component) {
        assert.equal(typeof component, 'function');
        slots.push(options);
      },
    },
    inject(names, apply) {
      assert.deepEqual(Array.from(names), ['modelDirectories']);
      apply({
        slots: ctx.slots,
        modelDirectories: {
          directoryFor(sessionId) {
            assert.equal(sessionId, 'fixture-session');
            return { store: directory };
          },
          // Any attempt to select or mutate a model fails: no such API is exposed.
        },
      });
    },
  };
  plugin.apply(ctx);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].namespace, 'local-chatgpt-source');
  assert.equal(registrations[0].messages.zh.title, 'ChatGPT 订阅');
  assert.equal(registrations[0].messages.en.subtitle, 'Independent source / official SIWC');
  for (const code of Object.keys(AUTH_NETWORK_MESSAGES)) {
    assert.ok(
      registrations[0].messages.zh[code]?.includes('auth.openai.com') ||
        registrations[0].messages.zh[code]?.includes('授权'),
    );
    assert.ok(
      registrations[0].messages.en[code]?.includes('auth.openai.com') ||
        registrations[0].messages.en[code]?.includes('authorization'),
    );
  }
  for (const code of Object.keys(ATTACHMENT_MESSAGES)) {
    assert.equal(typeof registrations[0].messages.zh[code], 'string');
    assert.equal(typeof registrations[0].messages.en[code], 'string');
  }
  assert.deepEqual(
    slots.map((slot) => slot.name),
    ['settings.models.footer', 'conversation.composer.dock'],
  );
  assert.equal(slots[0].id, 'chatgpt-subscription-login');
  assert.equal(slots[0].inject().t, 'fixture-translator');
  assert.equal(slots[1].inject('fixture-session').directory, directory);
  assert.deepEqual(localeBindings, ['local-chatgpt-source', 'local-chatgpt-source']);
});

test('missing native client hooks produce named contract diagnostics', () => {
  const ctx = () => ({
    effect: () => {},
    inject: () => {},
    slots: { inject: () => {}, register: () => {} },
    locale: { register: () => {}, bind: () => {} },
  });
  for (const [service, method] of [
    ['slots', 'inject'],
    ['slots', 'register'],
    ['locale', 'register'],
    ['locale', 'bind'],
  ]) {
    const target = ctx();
    delete target[service][method];
    assert.throws(
      () => loadPlugin().apply(target),
      new RegExp(`DSH_CLIENT_CONTRACT_MISSING:${service}.${method}`),
    );
  }
  const target = ctx();
  target.inject = (_, callback) => callback({ modelDirectories: {} });
  assert.doesNotThrow(() => loadPlugin().apply(target));
  delete target.inject;
  assert.doesNotThrow(() => loadPlugin().apply(target));
});

async function readCard(fetchImpl) {
  const states = [],
    effects = [];
  let card;
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(value) {
      const i = states.length;
      states.push(value);
      return [
        value,
        (next) => {
          states[i] = next;
        },
      ];
    },
    useRef: (current) => ({ current }),
    useCallback: (fn) => fn,
    useEffect: (fn) => {
      effects.push(fn);
    },
  };
  const plugin = loadPlugin(react, {
    AbortController,
    URL,
    setTimeout,
    clearTimeout,
    fetch: fetchImpl,
  });
  plugin.apply({
    effect: (fn) => fn(),
    locale: { register() {}, bind: () => (key) => key },
    slots: {
      inject: (_name, fn) => fn(),
      register: (_options, component) => {
        card = component;
      },
    },
  });
  card({ t: (key) => key });
  const cleanup = effects.map((fn) => fn());
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  for (const off of cleanup) off?.();
  return { state: states[0], error: states[1] };
}

test('settings distinguishes an unloaded Host, access denial, startup and malformed responses from networking', async () => {
  for (const [response, expected] of [
    [new Response('not found', { status: 404 }), 'DSH_SOURCE_NOT_LOADED'],
    [new Response('forbidden', { status: 403 }), 'DSH_SOURCE_ACCESS_DENIED'],
    [Response.json({ error: 'DSH_PLUGIN_STARTING' }, { status: 503 }), 'DSH_PLUGIN_STARTING'],
    [new Response('<html>upstream error</html>', { status: 503 }), 'DSH_SOURCE_RESPONSE_INVALID'],
    [Response.json(null), 'DSH_SOURCE_RESPONSE_INVALID'],
    [Response.json({ protocol: 'other' }), 'VERSION_MISMATCH'],
    [
      Response.json({ error: '/private/native/path' }, { status: 503 }),
      'DSH_SOURCE_RESPONSE_INVALID',
    ],
  ]) {
    const result = await readCard(async (url) => {
      assert.equal(url, 'api/local-chatgpt-source');
      return response;
    });
    assert.equal(result.error, expected);
  }
  assert.equal(
    (
      await readCard(async () => {
        throw TypeError('private transport detail');
      })
    ).error,
    'network',
  );
  const result = await readCard(async () =>
    Response.json({
      provider: 'chatgpt-subscription',
      protocol: 'siwc',
      accounts: [],
      futureField: true,
    }),
  );
  assert.equal(result.error, '');
  assert.equal(result.state.futureField, true);
});
