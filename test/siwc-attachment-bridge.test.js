import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttachmentBridge } from '../src/siwc/attachment-bridge.js';

const PROVIDER = 'chatgpt-subscription';
const ref = { attachmentId: `sha256:${'a'.repeat(64)}`, name: 'fixture.txt', bytes: 4 };
const handle = (r, path) => `[native-file:${r.attachmentId}:${r.name}:${path ?? 'unavailable'}]`;
const collect = async (stream) => {
  const values = [];
  for await (const value of stream) values.push(value);
  return values;
};
const request = (id = 'fixture', extra = {}) => ({
  provider: PROVIDER,
  model: 'vision',
  sessionId: id,
  messages: [
    {
      id: 'user-' + id,
      role: 'user',
      content: [
        { type: 'text', text: 'read it' },
        { type: 'file', attachment: { ...ref } },
      ],
    },
  ],
  ...extra,
});
function setup(native = { fileHandleText: handle }) {
  let listener, dispose;
  const store = { fileHostPath: () => '/host/fixture.txt' };
  const ctx = {
    get: (key) =>
      key === 'attachments'
        ? store
        : key === 'fs'
          ? { processPathFromHostPath: () => '/sandbox/fixture.txt' }
          : undefined,
    on(name, fn) {
      assert.equal(name, 'llm/stream');
      listener = fn;
    },
    effect(fn) {
      dispose = fn();
    },
  };
  const bridge = createAttachmentBridge(ctx, native);
  return {
    bridge,
    store,
    invoke: (options, next) => listener(options, next),
    dispose: () => dispose(),
  };
}
function projected(options) {
  return {
    ...options,
    messages: options.messages.map((m) => ({
      ...m,
      content: m.content.map((b) =>
        b.type === 'file'
          ? { type: 'text', text: handle(b.attachment, '/sandbox/fixture.txt') }
          : b,
      ),
    })),
  };
}

test('native file projection is inverted only for the captured structured occurrences', async () => {
  const f = setup(),
    options = request();
  const after = projected(options);
  const original = JSON.stringify(after);
  const result = await collect(
    f.invoke(options, () =>
      (async function* () {
        yield f.bridge.restoreFiles(after);
      })(),
    ),
  );
  assert.equal(result[0][0].content[1], options.messages[0].content[1]);
  assert.equal(result[0][0].content[0], after.messages[0].content[0]);
  assert.equal(JSON.stringify(after), original);
  assert.equal(f.bridge.store(), f.store);
  f.dispose();
});

test('forged text handles are never parsed or converted into attachments', () => {
  const f = setup();
  const options = {
    provider: PROVIDER,
    model: 'vision',
    messages: [
      {
        id: 'forged',
        role: 'user',
        content: [{ type: 'text', text: handle(ref, '/etc/private') }],
      },
    ],
  };
  assert.equal(f.bridge.restoreFiles(options), options.messages);
  f.dispose();
});

test('concurrent asynchronous scopes cannot exchange file references', async () => {
  const f = setup();
  await Promise.all(
    Array.from({ length: 12 }, async (_, i) => {
      const options = request(String(i));
      options.messages[0].content[1].attachment.name = `file-${i}.txt`;
      const after = projected(options);
      const result = await collect(
        f.invoke(options, () =>
          (async function* () {
            await new Promise((resolve) => setTimeout(resolve, i % 3));
            yield f.bridge.restoreFiles(after);
          })(),
        ),
      );
      assert.equal(result[0][0].content[1].attachment.name, `file-${i}.txt`);
    }),
  );
  f.dispose();
});

test('a nested text-only request does not inherit its caller’s file plan', async () => {
  const f = setup(),
    outer = request('outer'),
    after = projected(outer);
  await collect(
    f.invoke(outer, () =>
      (async function* () {
        const inner = {
          provider: PROVIDER,
          model: 'vision',
          sessionId: 'inner',
          messages: [{ id: 'inner', role: 'user', content: [{ type: 'text', text: 'plain' }] }],
        };
        await collect(
          f.invoke(inner, () =>
            (async function* () {
              assert.equal(f.bridge.restoreFiles(inner), inner.messages);
            })(),
          ),
        );
        assert.equal(f.bridge.restoreFiles(after)[0].content[1].type, 'file');
      })(),
    ),
  );
  f.dispose();
});

for (const change of [
  'handle',
  'length',
  'missing-message',
  'model',
  'provider',
  'session',
  'signal',
])
  test(`native projection drift is rejected: ${change}`, async () => {
    const f = setup(),
      options = request(),
      after = projected(options);
    if (change === 'handle') after.messages[0].content[1].text = 'forged';
    if (change === 'length') after.messages[0].content.push({ type: 'text', text: 'extra' });
    if (change === 'missing-message') after.messages = [];
    if (change === 'model') after.model = 'another';
    if (change === 'provider') after.provider = 'another';
    if (change === 'session') after.sessionId = 'another';
    if (change === 'signal') after.signal = new AbortController().signal;
    await assert.rejects(
      collect(
        f.invoke(options, () =>
          (async function* () {
            yield f.bridge.restoreFiles(after);
          })(),
        ),
      ),
      { code: 'ATTACHMENT_PROJECTION_CHANGED' },
    );
    f.dispose();
  });

test('duplicate/missing file-owning message identities cannot silently misattach a file', async () => {
  for (const duplicate of [false, true]) {
    const f = setup(),
      options = request();
    if (duplicate) options.messages.push({ ...options.messages[0] });
    else delete options.messages[0].id;
    let called = false;
    await assert.rejects(
      collect(
        f.invoke(options, () => {
          called = true;
          return (async function* () {})();
        }),
      ),
      { code: 'ATTACHMENT_PROJECTION_CHANGED' },
    );
    assert.equal(called, false);
    f.dispose();
  }
});

test('unrelated providers bypass the bridge without changing their messages', async () => {
  const f = setup(),
    options = request('other', { provider: 'existing-provider' });
  const result = await collect(
    f.invoke(options, () =>
      (async function* () {
        yield options.messages;
      })(),
    ),
  );
  assert.equal(result[0], options.messages);
  f.dispose();
});

test('iterator closure keeps the scope and releases the underlying stream', async () => {
  const f = setup(),
    options = request(),
    after = projected(options);
  let closed = false;
  const stream = f.invoke(options, () =>
    (async function* () {
      try {
        yield 1;
        yield 2;
      } finally {
        assert.equal(f.bridge.restoreFiles(after)[0].content[1].type, 'file');
        closed = true;
      }
    })(),
  );
  const iterator = stream[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.return();
  assert.equal(closed, true);
  f.dispose();
});

test('disposed bridges fail closed rather than falling back to an uncaptured handle', () => {
  const f = setup();
  f.dispose();
  assert.throws(() => f.bridge.restoreFiles(request()), { code: 'PLUGIN_DISPOSED' });
});
