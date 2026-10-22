import { createHash } from 'node:crypto';
import { SiwcError, reject } from './protocol.js';

const MiB = 1024 * 1024;
// Deliberately below the public API's limits. These bound history replay as
// well as the current prompt; no background upload or remote file identifier.
export const ATTACHMENT_LIMITS = Object.freeze({
  maxImages: 20,
  maxFiles: 10,
  maxFileBytes: 20 * MiB,
  maxTotalFileBytes: 40 * MiB,
  maxEncodedBytes: 64 * MiB,
  imageMaxPixels: 4 * 1024 * 1024,
  imageMaxDimension: 4096,
  imageTargetBytes: 4 * MiB,
  readTimeoutMs: 30000,
});
export const ATTACHMENT_MESSAGES = Object.freeze({
  ATTACHMENT_SERVICE_UNAVAILABLE:
    'This DSH runtime cannot supply verified attachment bytes. No attachment was sent.',
  ATTACHMENT_REFERENCE_INVALID:
    'An attachment reference is invalid. Attach the original file again.',
  ATTACHMENT_READ_FAILED:
    'The saved attachment could not be read or verified. No inference request was sent.',
  ATTACHMENT_READ_TIMEOUT:
    'Preparing attachment bytes exceeded the local read deadline. No inference request was sent.',
  ATTACHMENT_CORRUPT:
    'The saved attachment no longer matches its immutable reference. No inference request was sent.',
  ATTACHMENT_TOO_LARGE:
    'Attachment history exceeds this source’s per-file, count or total byte limit. Remove attachments or start a new conversation.',
  ATTACHMENT_FILE_TYPE_UNSUPPORTED:
    'This file type is not enabled for direct document input. Use a supported document/text format or local file tools.',
  ATTACHMENT_MODEL_UNSUPPORTED:
    'The model catalog explicitly excludes this attachment input type. Choose a model that accepts it.',
  ATTACHMENT_PROJECTION_CHANGED:
    'The native DSH file projection changed. Attachment transmission was stopped rather than reading a text-supplied path.',
});
const fileGroups = {
  'application/pdf': ['pdf'],
  'text/plain': ['txt', 'text', 'log', 'conf', 'ini', 'list', 'in', 'def', 'dic'],
  'text/markdown': ['md', 'markdown'],
  'application/json': ['json'],
  'application/x-ndjson': ['jsonl', 'ndjson'],
  'application/json5': ['json5'],
  'text/csv': ['csv'],
  'text/tsv': ['tsv'],
  'text/html': ['html', 'htm'],
  'text/xml': ['xml'],
  'application/yaml': ['yaml', 'yml'],
  'application/toml': ['toml'],
  'text/javascript': ['js', 'mjs', 'jsx'],
  'application/typescript': ['ts', 'tsx'],
  'text/x-python': ['py'],
  'text/x-java': ['java'],
  'text/x-c': ['c', 'h'],
  'text/x-c++': ['cc', 'cpp', 'cxx', 'hh', 'hpp'],
  'text/x-csharp': ['cs'],
  'text/x-go': ['go'],
  'text/x-rust': ['rs'],
  'text/x-sh': ['sh', 'bash', 'zsh', 'ksh'],
  'text/x-sql': ['sql'],
  'text/css': ['css'],
  'text/x-ruby': ['rb'],
  'text/x-php': ['php'],
  'text/x-swift': ['swift'],
  'text/x-kotlin': ['kt', 'kts'],
  'text/x-rst': ['rst'],
  'text/x-tex': ['tex'],
  'application/msword': ['doc', 'dot'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/rtf': ['rtf'],
  'application/vnd.oasis.opendocument.text': ['odt'],
  'application/vnd.ms-powerpoint': ['ppt', 'pps', 'pot'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
  'application/vnd.ms-excel': ['xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
};
const fileTypes = new Map(
  Object.entries(fileGroups).flatMap(([mime, extensions]) => extensions.map((ext) => [ext, mime])),
);
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const validName = (name) =>
  typeof name === 'string' &&
  name.length > 0 &&
  name.length <= 255 &&
  !/[\\/\x00-\x1f\x7f]/u.test(name);
function reference(ref, image = false) {
  if (
    !ref ||
    !/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId ?? '') ||
    !Number.isSafeInteger(ref.bytes) ||
    ref.bytes < 1 ||
    (ref.name !== undefined && !validName(ref.name))
  )
    reject('ATTACHMENT_REFERENCE_INVALID');
  if (
    image &&
    (!imageTypes.has(ref.mediaType) ||
      !Number.isSafeInteger(ref.width) ||
      ref.width < 1 ||
      !Number.isSafeInteger(ref.height) ||
      ref.height < 1)
  )
    reject('ATTACHMENT_REFERENCE_INVALID');
  if (!image && !validName(ref.name)) reject('ATTACHMENT_REFERENCE_INVALID');
  if (image && !Number.isSafeInteger(ref.width * ref.height))
    reject('ATTACHMENT_REFERENCE_INVALID');
  return ref;
}
// rc.2 requires explicit target dimensions, not the older maxPixels policy.
// Round the short edge as the native encoder does, then enforce the pixel cap.
export function requestImageTarget(ref, limits = ATTACHMENT_LIMITS) {
  reference(ref, true);
  const long = Math.max(ref.width, ref.height),
    short = Math.min(ref.width, ref.height);
  let edge = Math.min(
    long,
    limits.imageMaxDimension,
    Math.max(1, Math.floor(Math.sqrt((limits.imageMaxPixels * long) / short))),
  );
  const dimensions = (n) =>
    ref.width >= ref.height
      ? { width: n, height: Math.max(1, Math.round((ref.height * n) / ref.width)) }
      : { width: Math.max(1, Math.round((ref.width * n) / ref.height)), height: n };
  let target = dimensions(edge);
  while (target.width * target.height > limits.imageMaxPixels && edge > 1)
    target = dimensions(--edge);
  return { ...target, maxBytes: limits.imageTargetBytes };
}
function fileType(ref) {
  const mime = fileTypes.get(ref.name.split('.').at(-1).toLowerCase());
  if (!mime) reject('ATTACHMENT_FILE_TYPE_UNSUPPORTED');
  return mime;
}
export function attachmentCapabilities(entry, store) {
  let image;
  if (entry.input_modalities !== undefined) {
    if (
      !Array.isArray(entry.input_modalities) ||
      !entry.input_modalities.every((v) => typeof v === 'string')
    )
      reject('MODEL_CATALOG_INVALID', 502);
    image = entry.input_modalities.includes('image');
  }
  if (entry.supports_image_input !== undefined) {
    if (
      typeof entry.supports_image_input !== 'boolean' ||
      (image !== undefined && image !== entry.supports_image_input)
    )
      reject('MODEL_CATALOG_INVALID', 502);
    image = entry.supports_image_input;
  }
  if (entry.supports_file_input !== undefined && typeof entry.supports_file_input !== 'boolean')
    reject('MODEL_CATALOG_INVALID', 502);
  if (typeof store?.readImageRequest !== 'function') image = false;
  // Missing catalog facts remain unknown, not fabricated capability support
  // or a false text-only declaration. DSH permits unknown input.
  let inputModalities;
  if (image !== undefined) inputModalities = image ? ['text', 'image'] : ['text'];
  return { image, file: entry.supports_file_input, inputModalities };
}
function wait(start, signal) {
  if (!signal) return Promise.resolve().then(start);
  return new Promise((resolve, rejectWait) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      fn(value);
    };
    const abort = () => finish(rejectWait, signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) return abort();
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return start();
      })
      .then(
        (value) => finish(resolve, value),
        (error) => finish(rejectWait, error),
      );
  });
}
async function readFile(ref, store, signal) {
  const iterator = store.readFileStream(ref, signal)[Symbol.asyncIterator]();
  const chunks = [];
  let bytes = 0,
    done = false;
  const hash = createHash('sha256');
  try {
    while (true) {
      const next = await wait(() => iterator.next(), signal);
      if (next.done) {
        done = true;
        break;
      }
      const chunk = next.value;
      if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0 || chunks.length >= 8192)
        reject('ATTACHMENT_CORRUPT');
      bytes += chunk.byteLength;
      if (bytes > ref.bytes) reject('ATTACHMENT_CORRUPT');
      hash.update(chunk);
      chunks.push(Buffer.from(chunk));
    }
    if (bytes !== ref.bytes || `sha256:${hash.digest('hex')}` !== ref.attachmentId)
      reject('ATTACHMENT_CORRUPT');
    return Buffer.concat(chunks, bytes);
  } finally {
    if (!done) {
      try {
        Promise.resolve(iterator.return?.()).catch(() => {});
      } catch {
        /* best effort after abort */
      }
    }
  }
}
function verifiedImage(version, ref, limits, target) {
  if (
    !version ||
    version.attachment?.attachmentId !== ref.attachmentId ||
    !(version.data instanceof Uint8Array) ||
    version.data.byteLength !== version.bytes ||
    !imageTypes.has(version.mediaType) ||
    !Number.isSafeInteger(version.width) ||
    version.width < 1 ||
    !Number.isSafeInteger(version.height) ||
    version.height < 1 ||
    version.width * version.height > limits.imageMaxPixels ||
    version.width > target.width ||
    version.height > target.height ||
    version.bytes < 1
  )
    reject('ATTACHMENT_CORRUPT');
  if (version.bytes > limits.maxFileBytes) reject('ATTACHMENT_TOO_LARGE');
  return Buffer.from(version.data);
}

// Resolve only structured, admitted native references. No URL fetching, path
// parsing, filesystem reads, /files upload or mutation of durable history.
export async function prepareAttachmentParts(
  messages,
  {
    store,
    capabilities = {},
    signal: callerSignal,
    limits = ATTACHMENT_LIMITS,
    offloadedText = () =>
      '[This image was explicitly offloaded from the current request. Do not claim to see its pixels.]',
  },
) {
  callerSignal?.throwIfAborted();
  const parts = new WeakMap(),
    occurrences = [];
  let images = 0,
    files = 0,
    fileBytes = 0;
  for (const message of messages)
    for (const block of message.content ?? []) {
      if (!['image', 'file'].includes(block.type)) continue;
      if (message.role !== 'user') reject('UNSUPPORTED_CONTENT');
      const image = block.type === 'image';
      const ref = reference(block.attachment, image);
      if (image && block.offloaded === true) {
        parts.set(block, { type: 'input_text', text: offloadedText(ref) });
        continue;
      }
      if (image) {
        if (capabilities.image === false) reject('ATTACHMENT_MODEL_UNSUPPORTED');
        if (++images > limits.maxImages) reject('ATTACHMENT_TOO_LARGE');
        if (typeof store?.readImageRequest !== 'function') reject('ATTACHMENT_SERVICE_UNAVAILABLE');
      } else {
        if (capabilities.file === false) reject('ATTACHMENT_MODEL_UNSUPPORTED');
        const mime = fileType(ref);
        if (mime === 'application/pdf' && capabilities.image === false)
          reject('ATTACHMENT_MODEL_UNSUPPORTED');
        fileBytes += ref.bytes;
        if (
          ++files > limits.maxFiles ||
          ref.bytes > limits.maxFileBytes ||
          fileBytes > limits.maxTotalFileBytes
        )
          reject('ATTACHMENT_TOO_LARGE');
        if (typeof store?.readFileStream !== 'function') reject('ATTACHMENT_SERVICE_UNAVAILABLE');
      }
      occurrences.push(block);
    }
  if (!occurrences.length) return parts;
  const deadline = AbortSignal.timeout(limits.readTimeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  const encoded = new Map();
  let encodedBytes = 0;
  for (const block of occurrences) {
    callerSignal?.throwIfAborted();
    if (deadline.aborted) reject('ATTACHMENT_READ_TIMEOUT');
    const ref = block.attachment,
      image = block.type === 'image';
    const key = JSON.stringify([block.type, ref]);
    let prepared = encoded.get(key);
    try {
      if (!prepared) {
        if (image) {
          const target = requestImageTarget(ref, limits);
          const version = await wait(() => store.readImageRequest(ref, target, signal), signal);
          const data = verifiedImage(version, ref, limits, target);
          prepared = {
            type: 'input_image',
            image_url: `data:${version.mediaType};base64,${data.toString('base64')}`,
            detail: 'auto',
          };
        } else {
          const data = await readFile(ref, store, signal);
          prepared = {
            type: 'input_file',
            filename: ref.name,
            file_data: `data:${fileType(ref)};base64,${data.toString('base64')}`,
          };
        }
        encoded.set(key, prepared);
      }
    } catch (error) {
      if (callerSignal?.aborted) throw callerSignal.reason;
      if (deadline.aborted) reject('ATTACHMENT_READ_TIMEOUT');
      if (error instanceof SiwcError) throw error;
      reject('ATTACHMENT_READ_FAILED');
    }
    encodedBytes += Buffer.byteLength(prepared.image_url ?? prepared.file_data);
    if (encodedBytes > limits.maxEncodedBytes) reject('ATTACHMENT_TOO_LARGE');
    parts.set(block, Object.freeze(prepared));
  }
  return parts;
}
