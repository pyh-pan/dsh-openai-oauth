import test from 'node:test';
import assert from 'node:assert/strict';
import { responsesBody } from '../src/siwc/wire.js';

const image = { type: 'image', attachment: { attachmentId: `sha256:${'a'.repeat(64)}` } };
const file = { type: 'file', attachment: { attachmentId: `sha256:${'b'.repeat(64)}` } };
const parts = new WeakMap([
  [image, { type: 'input_image', image_url: 'data:image/png;base64,U1lOVEhFVElD', detail: 'auto' }],
  [
    file,
    {
      type: 'input_file',
      filename: 'fixture.txt',
      file_data: 'data:text/plain;base64,U1lOVEhFVElD',
    },
  ],
]);
const request = (content, role = 'user') => ({
  provider: 'chatgpt-subscription',
  model: 'fixture-vision',
  messages: [{ role, content, ...(role === 'tool' ? { toolCallId: 'fixture-call' } : {}) }],
});
const wire = (options, attachmentParts = parts) =>
  responsesBody(options, { accountKey: 'synthetic', attachmentParts });

test('Responses preserves ordered user text, image and inline file parts', () => {
  const body = wire(
    request([{ type: 'text', text: 'Before' }, image, { type: 'text', text: 'Between' }, file]),
  );
  assert.deepEqual(body.input, [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'Before' },
        parts.get(image),
        { type: 'input_text', text: 'Between' },
        parts.get(file),
      ],
    },
  ]);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.previous_response_id, undefined);
});

test('attachment-only user input and repeated durable history do not lose binary parts', () => {
  const options = request([image, file]);
  options.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'seen' }] });
  options.messages.push({ role: 'user', content: [{ type: 'text', text: 'again' }] });
  const first = wire(options);
  const again = wire(options);
  assert.deepEqual(again.input, first.input);
  assert.deepEqual(first.input[0].content, [parts.get(image), parts.get(file)]);
});

test('text-only serialization stays byte-for-byte compatible', () => {
  const body = wire(
    request([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ]),
  );
  assert.deepEqual(body.input, [
    { role: 'user', content: [{ type: 'input_text', text: 'one\ntwo' }] },
  ]);
});

test('unprepared attachments are rejected rather than represented as unseen image/file text', () => {
  for (const block of [image, file]) {
    assert.throws(() => wire(request([block]), new WeakMap()), { code: 'UNSUPPORTED_CONTENT' });
  }
});

test('images/files cannot be smuggled into developer, assistant or tool content', () => {
  for (const role of ['system', 'developer', 'assistant', 'tool'])
    for (const block of [image, file])
      assert.throws(() => wire(request([block], role)), { code: 'UNSUPPORTED_CONTENT' });
});
