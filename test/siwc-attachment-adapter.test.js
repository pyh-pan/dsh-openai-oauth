import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAdapterClass } from '../src/siwc/adapter.js';
import { PROVIDER } from '../src/siwc/controller.js';
import { RESOURCE, SiwcError } from '../src/siwc/protocol.js';

class LlmError extends Error {
  constructor(message, code, detail = {}) {
    super(message);
    this.code = code;
    this.failure = { message, code, ...detail };
  }
}
const Adapter = createAdapterClass({
  LlmAdapter: class {},
  LlmError,
  attributionHeaders: () => ({ 'user-agent': 'synthetic-attachments' }),
});
const data = Buffer.from('synthetic attachment payload');
const ref = {
  attachmentId: `sha256:${createHash('sha256').update(data).digest('hex')}`,
  bytes: data.length,
  name: 'fixture.txt',
};
const image = {
  type: 'image',
  attachment: { ...ref, name: 'fixture.png', mediaType: 'image/png', width: 1, height: 1 },
};
const file = { type: 'file', attachment: ref };
const collect = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};
function fixture({
  model = { slug: 'vision', visibility: 'list', input_modalities: ['text', 'image'] },
  readImage,
  assertCoverage,
  restoreFiles,
  access,
  select,
} = {}) {
  let selection = { key: 'synthetic-account', generation: 1 },
    imageReads = 0;
  const requests = [];
  const store = {
    async readImageRequest(r, target, signal) {
      imageReads++;
      if (readImage) await readImage(signal);
      return {
        attachment: r,
        data,
        mediaType: 'image/png',
        bytes: data.length,
        width: 1,
        height: 1,
      };
    },
    async *readFileStream() {
      yield data;
    },
  };
  const adapter = new Adapter({
    accounts: {
      selection: async () => {
        await select?.();
        return selection;
      },
    },
    sessions: {
      access: async () => {
        await access?.();
        return { accessToken: 'synthetic-access' };
      },
    },
    assertCoverage,
    restoreFiles,
    attachments: store,
    fetchImpl: async (url, init) => {
      requests.push({ url, ...init });
      if (url === `${RESOURCE}/models`) return Response.json({ models: [model] });
      assert.equal(url, `${RESOURCE}/responses`);
      const response = {
        type: 'response.completed',
        response: {
          id: 'resp_attachment',
          status: 'completed',
          output: [
            {
              id: 'msg_attachment',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'synthetic-ok', annotations: [] }],
            },
          ],
        },
      };
      return new Response(`data: ${JSON.stringify(response)}\n\n`);
    },
  });
  return {
    adapter,
    requests,
    store,
    get imageReads() {
      return imageReads;
    },
    change() {
      selection = { ...selection, generation: selection.generation + 1 };
    },
  };
}
const request = (blocks = [image, file], extra = {}) => ({
  provider: PROVIDER,
  model: 'vision',
  sessionId: 'synthetic-session',
  messages: [{ id: 'user-synthetic', role: 'user', content: blocks }],
  ...extra,
});

test('real adapter prepares and emits image/file input through only models and Responses endpoints', async (t) => {
  const f = fixture();
  t.after(() => f.adapter.dispose());
  const prepared = await f.adapter.prepareCall(PROVIDER, 'vision');
  assert.deepEqual(prepared.model.inputModalities, ['text', 'image']);
  const chunks = await collect(prepared.stream(request()));
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  const body = JSON.parse(f.requests.find((r) => r.url.endsWith('/responses')).body);
  assert.deepEqual(
    body.input[0].content.map((p) => p.type),
    ['input_image', 'input_file'],
  );
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.ok(f.requests.every((r) => ['/models', '/responses'].some((s) => r.url.endsWith(s))));
});

test('catalogs without modality facts do not falsely block native image admission', async (t) => {
  const f = fixture({ model: { slug: 'vision', visibility: 'list' } });
  t.after(() => f.adapter.dispose());
  const prepared = await f.adapter.prepareCall(PROVIDER, 'vision');
  assert.equal(prepared.model.inputModalities, undefined);
  assert.equal((await collect(prepared.stream(request()))).at(-1).reason.kind, 'stop');
});

test('a prepared negative capability survives catalog invalidation and stops image reads', async (t) => {
  let checked = 0;
  const f = fixture({
    model: { slug: 'vision', visibility: 'list', input_modalities: ['text'] },
    assertCoverage: () => checked++,
  });
  t.after(() => f.adapter.dispose());
  const prepared = await f.adapter.prepareCall(PROVIDER, 'vision');
  f.adapter.invalidate();
  const chunks = await collect(prepared.stream(request([image])));
  assert.equal(chunks.at(-1).reason.failure.code, 'ATTACHMENT_MODEL_UNSUPPORTED');
  assert.ok(checked > 0, 'coverage admission must not erase the prepared negative capability');
  assert.equal(f.imageReads, 0);
  assert.equal(f.requests.filter((r) => r.url.endsWith('/responses')).length, 0);
});

test('account-generation changes while bytes are prepared cannot transmit them', async (t) => {
  let entered, release;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture({
    readImage: async () => {
      entered();
      await hold;
    },
  });
  t.after(() => f.adapter.dispose());
  const prepared = await f.adapter.prepareCall(PROVIDER, 'vision');
  const pending = collect(prepared.stream(request([image])));
  await ready;
  f.change();
  release();
  assert.equal((await pending).at(-1).reason.failure.code, 'ACCOUNT_CHANGED');
  assert.equal(f.requests.filter((r) => r.url.endsWith('/responses')).length, 0);
});

test('caller cancellation during stalled image I/O stops promptly without an inference request', async (t) => {
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const f = fixture({
    readImage: () => {
      entered();
      return new Promise(() => {});
    },
  });
  t.after(() => f.adapter.dispose());
  const prepared = await f.adapter.prepareCall(PROVIDER, 'vision');
  const abort = new AbortController();
  const pending = collect(prepared.stream(request([image], { signal: abort.signal })));
  await ready;
  abort.abort(new Error('PRIVATE_ABORT_DETAILS'));
  const chunks = await pending;
  assert.equal(chunks.at(-1).reason.failure.code, 'ABORTED');
  assert.equal(f.requests.filter((r) => r.url.endsWith('/responses')).length, 0);
});

for (const kind of ['stream', 'prepared']) {
  test(`${kind} coverage failure precedes attachment restoration and history access`, async (t) => {
    let restored = false;
    const f = fixture({
      assertCoverage(id) {
        assert.equal(id, 'synthetic-session');
        throw new SiwcError('SIWC_COMPACTION_NOT_COVERED');
      },
      restoreFiles() {
        restored = true;
        throw Error('HISTORY_MUST_NOT_BE_PROJECTED');
      },
    });
    t.after(() => f.adapter.dispose());
    const prepared = await f.adapter.prepareCall(PROVIDER, 'vision');
    const options = {
      provider: PROVIDER,
      model: 'vision',
      sessionId: 'synthetic-session',
      get messages() {
        throw Error('HISTORY_MUST_NOT_BE_READ');
      },
    };
    const chunks = await collect(
      kind === 'prepared' ? prepared.stream(options) : f.adapter.stream(options),
    );
    assert.equal(chunks.at(-1).reason.failure.code, 'SIWC_COMPACTION_NOT_COVERED');
    assert.equal(restored, false);
    assert.equal(f.imageReads, 0);
    assert.equal(f.requests.filter((r) => r.url.endsWith('/responses')).length, 0);
  });

  test(`${kind} covered session preserves inline attachments and checks each async boundary`, async (t) => {
    const checks = [];
    let restored = 0;
    const f = fixture({
      assertCoverage: (id, purpose) => checks.push({ id, purpose }),
      restoreFiles(options) {
        restored++;
        return options.messages;
      },
    });
    t.after(() => f.adapter.dispose());
    const prepared = await f.adapter.prepareCall(PROVIDER, 'vision');
    const chunks = await collect(
      kind === 'prepared' ? prepared.stream(request()) : f.adapter.stream(request()),
    );
    assert.equal(chunks.at(-1).reason.kind, 'stop');
    assert.equal(restored, 1);
    assert.equal(checks.length, 3);
    assert.ok(checks.every((c) => c.id === 'synthetic-session' && c.purpose === undefined));
    const body = JSON.parse(f.requests.find((r) => r.url.endsWith('/responses')).body);
    assert.deepEqual(
      body.input[0].content.map((p) => p.type),
      ['input_image', 'input_file'],
    );
  });
}

test('coverage lost during attachment reads stops before Responses dispatch', async (t) => {
  let entered,
    release,
    covered = true;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture({
    assertCoverage() {
      if (!covered) throw new SiwcError('SIWC_COMPACTION_REQUIRED');
    },
    async readImage() {
      entered();
      await hold;
    },
  });
  t.after(() => f.adapter.dispose());
  const prepared = await f.adapter.prepareCall(PROVIDER, 'vision');
  const pending = collect(prepared.stream(request([image])));
  await ready;
  covered = false;
  release();
  assert.equal((await pending).at(-1).reason.failure.code, 'SIWC_COMPACTION_REQUIRED');
  assert.equal(f.requests.filter((r) => r.url.endsWith('/responses')).length, 0);
});

test('coverage lost during selection is rejected before attachment restoration', async (t) => {
  let covered = true,
    revokeDuringSelection = false,
    restored = false;
  const f = fixture({
    assertCoverage() {
      if (!covered) throw new SiwcError('SIWC_COMPACTION_NOT_COVERED');
    },
    select() {
      if (revokeDuringSelection) covered = false;
    },
    restoreFiles(options) {
      restored = true;
      return options.messages;
    },
  });
  t.after(() => f.adapter.dispose());
  const prepared = await f.adapter.prepareCall(PROVIDER, 'vision');
  revokeDuringSelection = true;
  const chunks = await collect(prepared.stream(request()));
  assert.equal(chunks.at(-1).reason.failure.code, 'SIWC_COMPACTION_NOT_COVERED');
  assert.equal(restored, false);
  assert.equal(f.imageReads, 0);
  assert.equal(f.requests.filter((r) => r.url.endsWith('/responses')).length, 0);
});

test('coverage lost during authorization stops at the final fetch boundary', async (t) => {
  let covered = true,
    revokeDuringAccess = false;
  const f = fixture({
    assertCoverage() {
      if (!covered) throw new SiwcError('SIWC_PRESET_REVISION_MISMATCH');
    },
    access() {
      if (revokeDuringAccess) covered = false;
    },
  });
  t.after(() => f.adapter.dispose());
  const prepared = await f.adapter.prepareCall(PROVIDER, 'vision');
  revokeDuringAccess = true;
  const chunks = await collect(prepared.stream(request()));
  assert.equal(chunks.at(-1).reason.failure.code, 'SIWC_PRESET_REVISION_MISMATCH');
  assert.equal(f.imageReads, 1, 'bytes were prepared while coverage was still valid');
  assert.equal(f.requests.filter((r) => r.url.endsWith('/responses')).length, 0);
});

test('all coverage checks preserve explicit compaction recovery purpose', async (t) => {
  const checks = [];
  const f = fixture({
    assertCoverage(id, purpose) {
      checks.push({ id, purpose });
      if (purpose !== 'compaction') throw new SiwcError('SIWC_COMPACTION_REQUIRED');
    },
  });
  t.after(() => f.adapter.dispose());
  const prepared = await f.adapter.prepareCall(PROVIDER, 'vision');
  const chunks = await collect(prepared.stream(request([file], { purpose: 'compaction' })));
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  assert.equal(checks.length, 3);
  assert.ok(checks.every((c) => c.id === 'synthetic-session' && c.purpose === 'compaction'));
});
