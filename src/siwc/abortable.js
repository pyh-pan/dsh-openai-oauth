// Bound waits even when a supplied transport/reader ignores AbortSignal. Observe
// late completion and detach cleanup; never hold a credential lock on cancel().
export function withSignal(start, signal, discard) {
  if (typeof start !== 'function')
    return Promise.reject(new TypeError('SIWC_ABORTABLE_INVALID_OPERATION'));
  if (!signal) return Promise.resolve().then(start);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () =>
      finish(reject, signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) return onAbort();
    let pending;
    try {
      pending = start();
    } catch (error) {
      finish(reject, error);
      return;
    }
    Promise.resolve(pending).then(
      (value) => {
        if (settled || signal.aborted) {
          onAbort();
          try {
            Promise.resolve(discard?.(value)).catch(() => {});
          } catch {
            /* Best effort. */
          }
        } else finish(resolve, value);
      },
      (error) => finish(reject, error),
    );
  });
}
export function cancelBody(response) {
  try {
    Promise.resolve(response?.body?.cancel()).catch(() => {});
  } catch {
    /* Reader owns body. */
  }
}
export function guardedBody(body, signal) {
  const reader = body.getReader();
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try {
      Promise.resolve(reader.cancel()).catch(() => {});
    } catch {
      /* Already failed. */
    }
    try {
      reader.releaseLock();
    } catch {
      /* Pending custom reader. */
    }
  };
  return {
    cleanup,
    body: new ReadableStream({
      async pull(controller) {
        try {
          const part = await withSignal(() => reader.read(), signal);
          if (closed) return;
          if (part.done) {
            controller.close();
            cleanup();
          } else controller.enqueue(part.value);
        } catch (error) {
          if (!closed) controller.error(error);
          cleanup();
        }
      },
      cancel: cleanup,
    }),
  };
}
