import { AsyncLocalStorage } from 'node:async_hooks';
import { PROVIDER } from './controller.js';
import { reject } from './protocol.js';

// DSH intentionally projects file blocks to local-tool handles before adapter
// dispatch. Capture ONLY admitted structured references at its public middleware
// seam, then restore those exact occurrences, never discover paths from text.
export function createAttachmentBridge(ctx, native) {
  if (typeof ctx.get !== 'function' || typeof native.fileHandleText !== 'function')
    throw new Error('DSH_ATTACHMENT_CONTRACT_MISSING:fileHandleText/context.get');
  const scope = new AsyncLocalStorage();
  let closed = false;
  const store = () => ctx.get('attachments');
  function expectedHandle(ref) {
    try {
      const hostPath = store()?.fileHostPath?.(ref);
      const path =
        hostPath === undefined ? undefined : ctx.get('fs')?.processPathFromHostPath(hostPath);
      return native.fileHandleText(ref, path);
    } catch {
      reject('ATTACHMENT_REFERENCE_INVALID');
    }
  }
  function capture(options) {
    const files = new Map();
    for (const message of options.messages) {
      if (message.role !== 'user') continue;
      const occurrences = [];
      for (const [index, block] of message.content.entries()) {
        if (block.type === 'file')
          occurrences.push({ index, block, expected: expectedHandle(block.attachment) });
      }
      if (!occurrences.length) continue;
      if (typeof message.id !== 'string' || !message.id || files.has(message.id))
        reject('ATTACHMENT_PROJECTION_CHANGED');
      files.set(message.id, { length: message.content.length, occurrences });
    }
    return {
      provider: options.provider,
      model: options.model,
      sessionId: options.sessionId,
      signal: options.signal,
      files,
    };
  }
  ctx.on('llm/stream', (options, next) => {
    if (options.provider !== PROVIDER) return next();
    return (async function* () {
      if (closed) reject('PLUGIN_DISPOSED');
      const frame = capture(options);
      const iterator = scope.run(frame, () => next()[Symbol.asyncIterator]());
      let completed = false;
      try {
        while (true) {
          const item = await scope.run(frame, () => iterator.next());
          if (item.done) {
            completed = true;
            return;
          }
          yield item.value;
        }
      } finally {
        if (!completed && iterator.return) await scope.run(frame, () => iterator.return());
      }
    })();
  });
  ctx.effect(
    () => () => {
      closed = true;
      scope.disable();
    },
    'chatgpt-subscription: attachment request scope',
  );

  return {
    store,
    restoreFiles(options) {
      if (closed) reject('PLUGIN_DISPOSED');
      const frame = scope.getStore();
      if (!frame || frame.files.size === 0) return options.messages;
      if (
        frame.provider !== options.provider ||
        frame.model !== options.model ||
        frame.sessionId !== options.sessionId ||
        frame.signal !== options.signal
      )
        reject('ATTACHMENT_PROJECTION_CHANGED');
      const seen = new Set();
      const messages = options.messages.map((message) => {
        const plan = frame.files.get(message.id);
        if (!plan) return message;
        if (
          message.role !== 'user' ||
          seen.has(message.id) ||
          message.content.length !== plan.length
        )
          reject('ATTACHMENT_PROJECTION_CHANGED');
        seen.add(message.id);
        const content = message.content.slice();
        for (const { index, block, expected } of plan.occurrences) {
          const projected = content[index];
          // Older compatible runtimes may already preserve the structured block.
          if (projected === block) continue;
          if (projected?.type !== 'text' || projected.text !== expected)
            reject('ATTACHMENT_PROJECTION_CHANGED');
          content[index] = block;
        }
        return { ...message, content };
      });
      if (seen.size !== frame.files.size) reject('ATTACHMENT_PROJECTION_CHANGED');
      return messages;
    },
  };
}
