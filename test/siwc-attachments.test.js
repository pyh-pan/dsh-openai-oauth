import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  ATTACHMENT_LIMITS,
  attachmentCapabilities,
  prepareAttachmentParts,
  requestImageTarget,
} from '../src/siwc/attachments.js';
import { responsesBody } from '../src/siwc/wire.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX2kAAAAASUVORK5CYII=',
  'base64',
);
const sha = (data) => `sha256:${createHash('sha256').update(data).digest('hex')}`;
const imageRef = {
  attachmentId: sha(png),
  mediaType: 'image/png',
  bytes: png.length,
  width: 1,
  height: 1,
  name: 'fixture.png',
};
const image = () => ({ type: 'image', attachment: { ...imageRef } });
const file = (name = 'fixture.txt', data = Buffer.from('synthetic file')) => ({
  type: 'file',
  attachment: { attachmentId: sha(data), name, bytes: data.length },
});
const content = (blocks) => [{ id: 'user-fixture', role: 'user', content: blocks }];
function fixture({ data = Buffer.from('synthetic file'), imageResult, readImage, readFile } = {}) {
  let images = 0,
    files = 0;
  const store = {
    async readImageRequest(ref, policy, signal) {
      images++;
      signal?.throwIfAborted();
      assert.deepEqual(policy, requestImageTarget(ref));
      if (readImage) return readImage(ref, signal);
      return (
        imageResult ?? {
          attachment: ref,
          data: png,
          bytes: png.length,
          mediaType: 'image/png',
          width: 1,
          height: 1,
        }
      );
    },
    readFileStream(ref, signal) {
      files++;
      if (readFile) return readFile(ref, signal);
      return (async function* () {
        yield data.subarray(0, 3);
        yield data.subarray(3);
      })();
    },
  };
  return {
    store,
    get images() {
      return images;
    },
    get files() {
      return files;
    },
  };
}
const prepare = (messages, f, extra = {}) =>
  prepareAttachmentParts(messages, {
    store: f?.store,
    capabilities: { image: true, file: true },
    ...extra,
  });

test('native request dimensions preserve aspect ratio without enlargement and respect both caps', () => {
  for (const [width, height] of [
    [1, 1],
    [8000, 6000],
    [6000, 8000],
    [8192, 2],
    [999, 1],
  ]) {
    const target = requestImageTarget({ ...imageRef, width, height });
    assert.ok(target.width <= width && target.height <= height);
    assert.ok(target.width * target.height <= ATTACHMENT_LIMITS.imageMaxPixels);
    assert.ok(Math.max(target.width, target.height) <= ATTACHMENT_LIMITS.imageMaxDimension);
    assert.ok(target.width > 0 && target.height > 0);
    assert.equal(target.maxBytes, ATTACHMENT_LIMITS.imageTargetBytes);
  }
});

test('verified native image bytes and original file bytes become inline Responses parts', async () => {
  const f = fixture(),
    img = image(),
    doc = file();
  const messages = content([{ type: 'text', text: 'describe' }, img, doc]);
  const before = JSON.stringify(messages);
  const parts = await prepare(messages, f);
  assert.deepEqual(parts.get(img), {
    type: 'input_image',
    image_url: `data:image/png;base64,${png.toString('base64')}`,
    detail: 'auto',
  });
  assert.equal(parts.get(doc).filename, 'fixture.txt');
  assert.equal(
    Buffer.from(parts.get(doc).file_data.split(',')[1], 'base64').toString(),
    'synthetic file',
  );
  assert.equal(JSON.stringify(messages), before);
  assert.equal(f.images, 1);
  assert.equal(f.files, 1);
});

for (const name of [
  'notes.txt',
  'report.pdf',
  'doc.docx',
  'slides.pptx',
  'sheet.xlsx',
  'code.ts',
  'data.csv',
  'data.json',
  'readme.md',
])
  test(`supported document filename uses inline file data: ${name}`, async () => {
    const f = fixture(),
      block = file(name);
    const parts = await prepare(content([block]), f);
    assert.equal(parts.get(block).type, 'input_file');
    assert.match(parts.get(block).file_data, /^data:[a-z/+.\-]+;base64,/);
    assert.equal(parts.get(block).file_id, undefined);
    assert.equal(parts.get(block).file_url, undefined);
  });

test('history replay repeats the same inline data and deduplicates verified reads within one request', async () => {
  const f = fixture(),
    first = image(),
    second = image(),
    doc = file();
  const messages = content([first, doc, second]);
  const options = { model: 'vision', messages, sessionId: 'fixture' };
  const one = responsesBody(options, {
    accountKey: 'fixture',
    attachmentParts: await prepare(messages, f),
  });
  assert.equal(f.images, 1);
  const two = responsesBody(options, {
    accountKey: 'fixture',
    attachmentParts: await prepare(messages, f),
  });
  assert.deepEqual(one, two);
  assert.equal(f.images, 2);
});

test('explicit native offload never reads or re-sends image pixels', async () => {
  const f = fixture(),
    img = { ...image(), offloaded: true };
  const parts = await prepare(content([img]), f, {
    offloadedText: () => 'native offload placeholder',
  });
  assert.deepEqual(parts.get(img), { type: 'input_text', text: 'native offload placeholder' });
  assert.equal(f.images, 0);
});

test('capability mapping honors positive/negative declarations and preserves absent information as unknown', () => {
  const f = fixture();
  assert.deepEqual(
    attachmentCapabilities({ input_modalities: ['text', 'image'] }, f.store).inputModalities,
    ['text', 'image'],
  );
  assert.deepEqual(
    attachmentCapabilities({ input_modalities: ['text'] }, f.store).inputModalities,
    ['text'],
  );
  assert.deepEqual(
    attachmentCapabilities({ supports_image_input: true }, f.store).inputModalities,
    ['text', 'image'],
  );
  assert.equal(attachmentCapabilities({}, f.store).inputModalities, undefined);
  assert.deepEqual(attachmentCapabilities({}, undefined).inputModalities, ['text']);
  assert.equal(attachmentCapabilities({ supports_file_input: false }, f.store).file, false);
  for (const entry of [
    { input_modalities: 'image' },
    { input_modalities: [1] },
    { supports_image_input: 'yes' },
    { supports_file_input: 1 },
    { input_modalities: ['text'], supports_image_input: true },
  ])
    assert.throws(() => attachmentCapabilities(entry, f.store), { code: 'MODEL_CATALOG_INVALID' });
});

for (const [blocks, capabilities] of [
  [[image()], { image: false }],
  [[file()], { file: false }],
  [[file('report.pdf')], { image: false, file: true }],
])
  test('explicit negative model capability stops attachment transmission', async () => {
    const f = fixture();
    await assert.rejects(prepare(content(blocks), f, { capabilities }), {
      code: 'ATTACHMENT_MODEL_UNSUPPORTED',
    });
    assert.equal(f.images + f.files, 0);
  });

for (const name of [
  '../secret.txt',
  'C:\\private.txt',
  'secret\n.txt',
  'archive.zip',
  'program.exe',
])
  test(`path-like or unsupported filenames cannot cause a host-file read: ${JSON.stringify(name)}`, async () => {
    const f = fixture();
    await assert.rejects(prepare(content([file(name)]), f), {
      code: /[\\/\n]/.test(name)
        ? 'ATTACHMENT_REFERENCE_INVALID'
        : 'ATTACHMENT_FILE_TYPE_UNSUPPORTED',
    });
    assert.equal(f.files, 0);
  });

test('malformed durable references are rejected before attachment access', async () => {
  for (const bad of [
    null,
    {},
    { ...imageRef, attachmentId: 'https://private.test/image' },
    { ...imageRef, bytes: -1 },
    { ...imageRef, width: 0 },
    { ...imageRef, mediaType: 'image/svg+xml' },
  ]) {
    const f = fixture();
    await assert.rejects(prepare(content([{ type: 'image', attachment: bad }]), f), {
      code: 'ATTACHMENT_REFERENCE_INVALID',
    });
    assert.equal(f.images, 0);
  }
});

test('per-file and aggregate count/byte limits are checked before storage reads', async () => {
  const cases = [
    { blocks: [file()], limits: { maxFileBytes: 2 } },
    { blocks: [file(), file()], limits: { maxFiles: 1 } },
    { blocks: [file(), file()], limits: { maxTotalFileBytes: 20 } },
    { blocks: [image(), image()], limits: { maxImages: 1 } },
  ];
  for (const c of cases) {
    const f = fixture();
    await assert.rejects(
      prepare(content(c.blocks), f, { limits: { ...ATTACHMENT_LIMITS, ...c.limits } }),
      { code: 'ATTACHMENT_TOO_LARGE' },
    );
    assert.equal(f.images + f.files, 0);
  }
});

test('encoded request limit counts every occurrence, not just unique attachment ids', async () => {
  const f = fixture(),
    one = image(),
    two = image();
  const single = await prepare(content([one]), f);
  const bytes = Buffer.byteLength(single.get(one).image_url);
  await assert.rejects(
    prepare(content([one, two]), f, { limits: { ...ATTACHMENT_LIMITS, maxEncodedBytes: bytes } }),
    { code: 'ATTACHMENT_TOO_LARGE' },
  );
});

test('verbatim file stream digest, byte length, and excess output are verified before upload', async () => {
  for (const data of [
    Buffer.from('wrong data'),
    Buffer.from('longer than declared fixture contents'),
  ]) {
    await assert.rejects(prepare(content([file()]), fixture({ data })), {
      code: 'ATTACHMENT_CORRUPT',
    });
  }
});

test('bad image request versions and backend exceptions cannot leak private storage paths', async () => {
  const bad = fixture({
    imageResult: {
      attachment: imageRef,
      data: png,
      bytes: 1,
      mediaType: 'image/png',
      width: 1,
      height: 1,
    },
  });
  await assert.rejects(prepare(content([image()]), bad), { code: 'ATTACHMENT_CORRUPT' });
  const f = fixture({
    readImage: () => {
      throw new Error('PRIVATE_HOST_PATH_TOKEN');
    },
  });
  await assert.rejects(prepare(content([image()]), f), (e) => {
    assert.equal(e.code, 'ATTACHMENT_READ_FAILED');
    assert.equal(e.message, e.code);
    assert.equal(e.cause, undefined);
    return true;
  });
});

test('missing attachment service fails closed', async () => {
  await assert.rejects(prepare(content([image()]), undefined), {
    code: 'ATTACHMENT_SERVICE_UNAVAILABLE',
  });
  await assert.rejects(prepare(content([file()]), undefined), {
    code: 'ATTACHMENT_SERVICE_UNAVAILABLE',
  });
});

test('pre-aborted requests do not read bytes', async () => {
  const f = fixture(),
    abort = new AbortController();
  abort.abort(new Error('fixture abort'));
  await assert.rejects(prepare(content([image()]), f, { signal: abort.signal }), /fixture abort/);
  assert.equal(f.images, 0);
});

test('local attachment preparation has a total deadline even if a backend ignores abort', async () => {
  const f = fixture({ readImage: () => new Promise(() => {}) });
  const hold = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(
      prepare(content([image()]), f, { limits: { ...ATTACHMENT_LIMITS, readTimeoutMs: 20 } }),
      { code: 'ATTACHMENT_READ_TIMEOUT' },
    );
  } finally {
    clearTimeout(hold);
  }
});

test('abort releases a stalled file iterator even when its next ignores the signal', async () => {
  const abort = new AbortController();
  let close = 0,
    entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const f = fixture({
    readFile: () => ({
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        entered();
        return new Promise(() => {});
      },
      return() {
        close++;
        return Promise.resolve({ done: true });
      },
    }),
  });
  const pending = assert.rejects(
    prepare(content([file()]), f, { signal: abort.signal }),
    /fixture abort/,
  );
  await ready;
  abort.abort(new Error('fixture abort'));
  await pending;
  assert.equal(close, 1);
});
