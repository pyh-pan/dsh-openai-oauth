import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore } from '../src/siwc/accounts.js';
import { SiwcController, createSiwcHandler, API_PATH } from '../src/siwc/controller.js';
import { SiwcError } from '../src/siwc/protocol.js';
import { CLIENT, HOST, MemoryCredentials, fixture } from './siwc-fixtures.js';

const url = `http://localhost${API_PATH}`;
const post = (body) =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const setup = (options) => {
  const credentials = new MemoryCredentials();
  const accounts = new AccountStore(credentials);
  const { protocol } = fixture();
  const controller = new SiwcController({ accounts, protocol }, { port: 0, ...options });
  return { credentials, accounts, controller, handler: createSiwcHandler(controller) };
};

test('controller serves only redacted account and attempt metadata', async (t) => {
  const { controller, handler } = setup();
  t.after(() => controller.dispose());
  const initial = await (await handler(new Request(url))).json();
  assert.equal(initial.protocol, 'siwc');
  assert.equal(initial.provider, 'chatgpt-subscription');
  assert.equal(initial.attempt, null);
  assert.deepEqual(initial.accounts, []);
  const response = await handler(post({ action: 'start' }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const state = await response.json();
  assert.equal(state.attempt.phase, 'waiting');
  assert.match(
    state.attempt.authorizeUrl,
    /^https:\/\/auth\.openai\.com\/api\/accounts\/authorize\?/,
  );
  assert.ok(!JSON.stringify(state).includes('id_token_hint'));
  const busy = await handler(post({ action: 'start' }));
  assert.equal(busy.status, 409);
  assert.deepEqual(await busy.json(), { error: 'AUTH_BUSY' });
  assert.equal(
    (await handler(post({ action: 'cancel', attemptId: 'not-this-attempt' }))).status,
    404,
  );
  const cancelled = await (
    await handler(post({ action: 'cancel', attemptId: state.attempt.id }))
  ).json();
  assert.equal(cancelled.attempt.phase, 'cancelled');
  assert.equal(cancelled.attempt.authorizeUrl, undefined);
  assert.equal((await handler(post({ action: 'start' }))).status, 200);
});

test('concurrent starts are excluded before host identity initialization finishes', async () => {
  let release;
  const controller = new SiwcController(
    {
      accounts: {
        hostId: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
        accounts: async () => [],
        selection: async () => undefined,
      },
      protocol: fixture().protocol,
    },
    { port: 0 },
  );
  const first = controller.start();
  await assert.rejects(controller.start(), { code: 'AUTH_BUSY' });
  release(HOST);
  await first;
  controller.dispose();
});

test('dispose during start cannot create a new callback listener', async () => {
  let release;
  const controller = new SiwcController({
    accounts: {
      hostId: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
    protocol: fixture().protocol,
  });
  const starting = controller.start();
  controller.dispose();
  release(HOST);
  await assert.rejects(starting, { code: 'PLUGIN_DISPOSED' });
});

test('account picker validates selected registration and requires completed authorization', async (t) => {
  const { accounts, controller, handler } = setup();
  t.after(() => controller.dispose());
  const key = await accounts.beginRegistration(CLIENT);
  assert.equal((await handler(post({ action: 'select', key }))).status, 401);
  assert.equal(
    (await handler(post({ action: 'start', key: 'llm-pi-ai/openai-codex' }))).status,
    404,
  );
  const retry = await (await handler(post({ action: 'start', key }))).json();
  assert.equal(new URL(retry.attempt.authorizeUrl).searchParams.get('client_id'), CLIENT);
  assert.equal(new URL(retry.attempt.authorizeUrl).searchParams.has('agent_name_hint'), false);
  assert.equal(retry.selection, undefined);
});

test('management handler rejects malformed, oversized and non-JSON mutations', async (t) => {
  const { controller, handler } = setup();
  t.after(() => controller.dispose());
  assert.equal((await handler(new Request(url, { method: 'PUT' }))).status, 405);
  assert.equal((await handler(new Request(url, { method: 'POST', body: '{}' }))).status, 415);
  for (const raw of ['{token:SECRET}', 'null', '[]']) {
    const response = await handler(
      new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: raw,
      }),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'INVALID_REQUEST' });
  }
  const huge = await handler(post({ action: 'start', ignored: 'a'.repeat(20000) }));
  assert.equal(huge.status, 413);
  assert.equal((await handler(post({ action: 'unsupported' }))).status, 400);
});

test('unexpected account storage exceptions cannot leak secret error details', async () => {
  const controller = new SiwcController({
    accounts: {
      accounts: async () => {
        throw new Error('access_token=SECRET');
      },
    },
  });
  const response = await createSiwcHandler(controller)(new Request(url));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'INTERNAL' });
  controller.dispose();
});
