import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');

function loadPlugin() {
  let plugin;
  runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load({ id, factory }) {
          assert.equal(id, manifest.name);
          plugin = factory((name) => {
            assert.equal(name, 'react');
            return {};
          });
        },
      },
    },
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
  const directory = { fixture: 'existing-session-directory' };
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
  assert.throws(
    () => loadPlugin().apply(target),
    /DSH_CLIENT_CONTRACT_MISSING:modelDirectories.directoryFor/,
  );
});
