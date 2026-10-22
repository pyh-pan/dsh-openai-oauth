import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAdapterClass } from '../src/siwc/adapter.js';
import { PROVIDER } from '../src/siwc/controller.js';
import { RESOURCE } from '../src/siwc/protocol.js';

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
    accounts: { selection: async () => selection },
    sessions: { access: async () => ({ accessToken: 'synthetic-access' }) },
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
  const f = fixture({ model: { slug: 'vision', visibility: 'list', input_modalities: ['text'] } });
  t.after(() => f.adapter.dispose());
  const prepared = await f.adapter.prepareCall(PROVIDER, 'vision');
  f.adapter.invalidate();
  const chunks = await collect(prepared.stream(request([image])));
  assert.equal(chunks.at(-1).reason.failure.code, 'ATTACHMENT_MODEL_UNSUPPORTED');
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
