import { RESOURCE, SiwcError, boundedJson, reject } from './protocol.js';
import {
  createTimingTrace,
  normalizeRequestPolicy,
  resolvedRetryPolicy,
} from './request-policy.js';
import { PROVIDER } from './controller.js';
import {
  ResponseStream,
  providerFailure,
  responsesBody,
  sessionAffinity,
  sseEvents,
} from './wire.js';
import { reasoningCapabilities } from './capabilities.js';

const same = (a, b) => a?.key === b?.key && a?.generation === b?.generation;
// Catalog entries include rich capability metadata and exceed the much smaller
// OAuth/discovery bound in real accounts. Keep a separate, explicit 8 MiB cap.
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const safeSlug = (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(id);

const TIMEOUT_MESSAGES = Object.freeze({
  RESPONSE_HEADERS_TIMEOUT: 'SIWC_RESPONSE_HEADERS_TIMEOUT',
  STREAM_TOTAL_TIMEOUT: 'SIWC_STREAM_TOTAL_TIMEOUT_FROM_HEADERS',
  CATALOG_TIMEOUT: 'SIWC_CATALOG_TIMEOUT',
  ERROR_BODY_TIMEOUT: 'SIWC_ERROR_BODY_TIMEOUT',
});
function cancelBody(response) {
  try {
    Promise.resolve(response?.body?.cancel()).catch(() => {});
  } catch {
    /* Reader already owns/cancelled the body, or transport already failed. */
  }
}
// Race explicitly: an injected/late transport need not reject on abort. Observe
// both branches and cancel a late Response, so no rejected promise/body escapes.
function withSignal(start, signal, discard) {
  return new Promise((resolve, rejectRequest) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(rejectRequest, signal.reason ?? new SiwcError('ABORTED'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) return onAbort();
    let pending;
    try {
      pending = start();
    } catch (error) {
      finish(rejectRequest, error);
      return;
    }
    Promise.resolve(pending).then(
      (value) => {
        if (settled || signal.aborted) {
          onAbort();
          try {
            Promise.resolve(discard?.(value)).catch(() => {});
          } catch {
            /* Late-response cleanup is best effort. */
          }
        } else finish(resolve, value);
      },
      (error) => finish(rejectRequest, error),
    );
  });
}
// Guard the transport's reader without awaiting an untrusted cancel promise.
// Cancel closes pending reads synchronously; detach its promise and release the
// lock even if a custom transport never acknowledges cancellation. Both JSON
// and SSE parsers keep their existing validation and cancel this wrapper.
function guardedBody(body, signal) {
  const reader = body.getReader();
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try {
      Promise.resolve(reader.cancel()).catch(() => {});
    } catch {
      /* Transport may already have errored. */
    } finally {
      reader.releaseLock();
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
// boundedJson remains the single JSON size/shape validator, with a reader that
// also honors deadlines when the fetch implementation ignores AbortSignal.
async function requestJson(response, signal, maxBytes) {
  if (!response.body) return boundedJson(response, maxBytes);
  const guarded = guardedBody(response.body, signal);
  try {
    return await boundedJson({ headers: response.headers, body: guarded.body }, maxBytes);
  } finally {
    guarded.cleanup();
  }
}

// The factory keeps wire tests independent of DSH packages. Production supplies
// the real host exports: LlmAdapter, LlmError and attributionHeaders. It never
// installs a replacement Llm service or imports another copy of pi-ai.
export function createAdapterClass({ LlmAdapter, LlmError, attributionHeaders }) {
  return class ChatGPTSubscriptionAdapter extends LlmAdapter {
    #accounts;
    #sessions;
    #fetch;
    #cache;
    #closed = new AbortController();
    #notice = null;
    #policy;
    #logger;
    #timingNow;
    constructor({
      accounts,
      sessions,
      fetchImpl = globalThis.fetch,
      now = Date.now,
      idleTimeoutMs,
      requestPolicy,
      logger,
      timingNow,
    }) {
      super();
      this.#accounts = accounts;
      this.#sessions = sessions;
      this.#fetch = fetchImpl;
      this.now = now;
      // Retain the original offline fixture's idleTimeoutMs injection. Public
      // configuration has one owner/name: requestPolicy.streamIdleTimeoutMs.
      this.#policy = normalizeRequestPolicy(
        idleTimeoutMs === undefined
          ? requestPolicy
          : { ...normalizeRequestPolicy(requestPolicy), streamIdleTimeoutMs: idleTimeoutMs },
      );
      this.#logger = logger;
      this.#timingNow = timingNow;
    }
    providerInfo(provider) {
      return { id: provider, name: 'ChatGPT Subscription' };
    }
    providerRetryPolicy(provider) {
      if (provider !== PROVIDER) throw new LlmError('NO_ADAPTER', 'NO_ADAPTER');
      // No retry loop exists in this adapter. The native step retry plugin owns
      // these finite retries; direct llm.stream consumers stay single-attempt.
      return resolvedRetryPolicy(this.#policy);
    }
    invalidate() {
      this.#cache = undefined;
    }
    get notice() {
      return this.#notice ? structuredClone(this.#notice) : null;
    }
    clearNotice() {
      this.#notice = null;
    }
    #report(failure) {
      this.#notice = {
        code: failure.code,
        ...(Number.isInteger(failure.status) ? { status: failure.status } : {}),
        ...(typeof failure.providerCode === 'string' ? { providerCode: failure.providerCode } : {}),
        ...(typeof failure.requestId === 'string' ? { requestId: failure.requestId } : {}),
      };
    }
    dispose() {
      this.#closed.abort(new SiwcError('PLUGIN_DISPOSED'));
      this.invalidate();
    }
    #error(error, signal) {
      // Cancellation wins a fetch/terminal race, even if the other branch already
      // produced an LlmError. Never forward an arbitrary signal reason/message.
      if (error instanceof LlmError && !signal?.aborted) return error;
      const reason = signal?.aborted ? signal.reason : error;
      const rawCode =
        reason instanceof SiwcError
          ? reason.code
          : signal?.aborted
            ? reason?.name === 'TimeoutError'
              ? 'TIMEOUT'
              : 'ABORTED'
            : 'TRANSPORT';
      const message = TIMEOUT_MESSAGES[rawCode];
      const code = message ? 'TIMEOUT' : rawCode;
      return new LlmError(message ?? code, code);
    }
    #signal(signal) {
      return AbortSignal.any([this.#closed.signal, ...(signal ? [signal] : [])]);
    }
    async #selected(expected, signal = this.#closed.signal) {
      const selected = await withSignal(() => this.#accounts.selection(), signal);
      if (!selected) reject('ACCOUNT_REAUTH_REQUIRED', 401);
      if (expected && !same(selected, expected)) reject('ACCOUNT_CHANGED', 409);
      return selected;
    }
    async #request(path, { selection, signal, body, stream = false, affinity, trace }) {
      // Auth/selection are cancellable, but are not part of the historical
      // headers clock. Do not manufacture a host model-step total deadline.
      const lifetime = this.#signal(signal);
      await this.#selected(selection, lifetime);
      const access = await withSignal(
        () => this.#sessions.access(selection.key, { signal: lifetime, selection }),
        lifetime,
      );
      await this.#selected(selection, lifetime);
      const timeout = new AbortController();
      const combined = AbortSignal.any([
        lifetime,
        timeout.signal,
        ...(access.signal ? [access.signal] : []),
      ]);
      let timer, response;
      const arm = (duration, code, stage) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          trace?.(stage);
          timeout.abort(new SiwcError(code));
        }, duration);
      };
      const cleanup = () => clearTimeout(timer);
      try {
        combined.throwIfAborted();
        arm(
          stream ? this.#policy.responseHeadersTimeoutMs : this.#policy.catalogTimeoutMs,
          stream ? 'RESPONSE_HEADERS_TIMEOUT' : 'CATALOG_TIMEOUT',
          stream ? 'response-headers-timeout' : undefined,
        );
        // Preserve the existing clock origin: JSON serialization is inside the
        // headers budget; responsesBody/auth/selection work before it is not.
        const serialized = body ? JSON.stringify(body) : undefined;
        trace?.('request-built', { requestBytes: serialized ? Buffer.byteLength(serialized) : 0 });
        combined.throwIfAborted();
        trace?.('fetch-start');
        response = await withSignal(
          () =>
            this.#fetch(`${RESOURCE}/${path}`, {
              method: body ? 'POST' : 'GET',
              headers: {
                ...attributionHeaders(),
                authorization: `Bearer ${access.accessToken}`,
                accept: stream ? 'text/event-stream' : 'application/json',
                ...(body ? { 'content-type': 'application/json' } : {}),
                // Stable inference affinity is not attached to catalog calls.
                ...(path === 'responses' && affinity
                  ? { session_id: affinity, 'x-client-request-id': affinity }
                  : {}),
              },
              ...(body ? { body: serialized } : {}),
              redirect: 'error',
              signal: combined,
            }),
          combined,
          cancelBody,
        );
        combined.throwIfAborted();
        if (stream) cleanup(); // Headers never leave the old timer armed.
        // A Responses body clock starts on headers arrival. Catalog requests
        // keep their original headers+body deadline (do not silently reset it).
        if (stream) {
          if (!response.ok)
            arm(this.#policy.catalogTimeoutMs, 'ERROR_BODY_TIMEOUT', 'error-body-timeout');
          else
            arm(this.#policy.streamTotalTimeoutMs, 'STREAM_TOTAL_TIMEOUT', 'stream-total-timeout');
        }
        trace?.('response-headers');
        if (!response.ok) {
          // An error page is not a 30-minute SSE stream. Bound and cancel its
          // body separately, including transports which ignore abort signals.
          let data;
          try {
            data = await requestJson(response, combined);
          } catch {
            combined.throwIfAborted();
            /* Status still retained for non-JSON failure pages. */
          }
          const failure = providerFailure(
            data?.error,
            response.status,
            response.headers.get('x-request-id'),
          );
          throw new LlmError(failure.message, failure.code, failure);
        }
        return { response, signal: combined, cleanup };
      } catch (error) {
        cleanup();
        cancelBody(response);
        const failure = this.#error(error, combined);
        if (combined.reason?.code === 'ERROR_BODY_TIMEOUT')
          throw new LlmError(failure.message, failure.code, { status: response.status });
        throw failure;
      }
    }
    async #catalog(selection, signal) {
      signal = this.#signal(signal);
      signal.throwIfAborted();
      if (
        this.#cache &&
        same(selection, this.#cache.selection) &&
        this.#cache.expiresAt > this.now()
      )
        return structuredClone(this.#cache.models);
      const request = await this.#request('models', { selection, signal });
      try {
        const data = await requestJson(request.response, request.signal, MAX_CATALOG_BYTES);
        if (!Array.isArray(data.models) || data.models.length > 4096)
          reject('MODEL_CATALOG_INVALID', 502);
        const ids = new Set(),
          models = [],
          capabilities = new Map();
        for (const entry of data.models) {
          if (entry.visibility !== 'list') continue;
          if (!safeSlug(entry.slug) || ids.has(entry.slug)) reject('MODEL_CATALOG_INVALID', 502);
          ids.add(entry.slug);
          const reasoning = reasoningCapabilities(entry);
          capabilities.set(entry.slug, {
            reasoningSummary: entry.supports_reasoning_summary_parameter === true,
          });
          models.push({
            provider: PROVIDER,
            id: entry.slug,
            name:
              typeof entry.display_name === 'string' && entry.display_name.length <= 256
                ? entry.display_name
                : entry.slug,
            // This route deliberately advertises text-only until attachment
            // projection is implemented and tested. DSH supplies safe placeholders.
            inputModalities: ['text'],
            ...(reasoning ? { reasoning } : {}),
            ...(Number.isSafeInteger(entry.context_window) && entry.context_window > 0
              ? { context: { contextWindow: entry.context_window } }
              : {}),
          });
        }
        await this.#selected(selection, request.signal);
        this.#cache = {
          selection,
          models: structuredClone(models),
          capabilities,
          expiresAt: this.now() + 60000,
        };
        return models;
      } catch (error) {
        throw this.#error(error, request.signal);
      } finally {
        request.cleanup();
        cancelBody(request.response);
      }
    }
    async listModels(provider) {
      if (provider !== PROVIDER) throw new LlmError('NO_ADAPTER', 'NO_ADAPTER');
      try {
        const selection = await withSignal(() => this.#accounts.selection(), this.#closed.signal);
        if (!selection) return [];
        return await this.#catalog(selection);
      } catch (error) {
        const failure = this.#error(error);
        this.#report(failure.failure ?? failure);
        throw failure;
      }
    }
    async #model(provider, model, selection, signal) {
      if (provider !== PROVIDER) reject('NO_ADAPTER');
      const models = await this.#catalog(selection, signal);
      const found = models.find((entry) => entry.id === model);
      if (!found) reject('UNKNOWN_MODEL', 404);
      return found;
    }
    async resolveModel(provider, model, signal) {
      signal = this.#signal(signal);
      try {
        return await this.#model(provider, model, await this.#selected(undefined, signal), signal);
      } catch (error) {
        throw this.#error(error, signal);
      }
    }
    async prepareCall(provider, model, signal) {
      signal = this.#signal(signal);
      try {
        const selection = await this.#selected(undefined, signal);
        const info = await this.#model(provider, model, selection, signal);
        return { model: info, stream: (options) => this.#stream(options, selection) };
      } catch (error) {
        throw this.#error(error, signal);
      }
    }
    async *stream(options) {
      try {
        const prepared = await this.prepareCall(options.provider, options.model, options.signal);
        yield* prepared.stream(options);
      } catch (error) {
        const failure = this.#error(error, options.signal);
        this.#report(failure.failure ?? failure);
        yield {
          type: 'finish',
          reason: {
            kind: failure.code === 'ABORTED' ? 'aborted' : 'error',
            failure: failure.failure ?? { code: failure.code, message: failure.code },
          },
        };
      }
    }
    async *#stream(options, selection) {
      let request, guarded, usage;
      let terminal = false;
      const trace = createTimingTrace(this.#policy, this.#logger, this.#timingNow);
      try {
        this.#signal(options.signal).throwIfAborted();
        if (options.provider !== PROVIDER) reject('NO_ADAPTER');
        const capability = same(selection, this.#cache?.selection)
          ? this.#cache.capabilities.get(options.model)
          : undefined;
        const body = responsesBody(options, {
          accountKey: selection.key,
          reasoningSummary: capability?.reasoningSummary === true,
        });
        const affinity = sessionAffinity(options.sessionId, selection.key);
        request = await this.#request('responses', {
          selection,
          signal: options.signal,
          body,
          stream: true,
          affinity,
          trace,
        });
        // `stream:true` determines the wire protocol, not a proxy's MIME label.
        // Keep SSE framing/terminal validation; the wrapper only owns transport
        // abort and non-blocking reader cleanup, never reconstructs content.
        if (!request.response.body) reject('INVALID_STREAM', 502);
        guarded = guardedBody(request.response.body, request.signal);
        const state = new ResponseStream({ accountKey: selection.key, model: options.model });
        let finish;
        for await (const event of sseEvents(guarded.body, {
          signal: request.signal,
          idleTimeoutMs: this.#policy.streamIdleTimeoutMs,
        })) {
          trace?.('first-sse');
          for (const chunk of state.event(event, request.response.headers.get('x-request-id'))) {
            request.signal.throwIfAborted();
            if (chunk.type === 'usage') usage = chunk.usage;
            if (chunk.type === 'finish') {
              finish = chunk;
              break;
            }
            if (
              ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.text) ||
              (chunk.type === 'tool-call-delta' && chunk.argumentsDelta)
            )
              trace?.('first-content');
            yield chunk;
          }
          if (finish) break; // Close the reader before yielding a terminal chunk.
        }
        if (!finish) reject('STREAM_CLOSED', 502);
        request.signal.throwIfAborted();
        request.cleanup(); // A consumer may pause indefinitely on the finish.
        terminal = true;
        if (finish.reason.kind === 'error') this.#report(finish.reason.failure);
        else this.clearNotice();
        trace?.('terminal', {
          usage,
          code:
            finish.reason.failure?.code ??
            { stop: 'STOP', 'tool-calls': 'TOOL_CALLS', 'max-tokens': 'MAX_TOKENS' }[
              finish.reason.kind
            ] ??
            'OTHER',
        });
        yield finish;
      } catch (error) {
        const failure = this.#error(error, request?.signal ?? options.signal);
        this.#report(failure.failure ?? failure);
        request?.cleanup();
        guarded?.cleanup();
        terminal = true;
        if (failure.code === 'STREAM_IDLE_TIMEOUT') trace?.('stream-idle-timeout');
        trace?.('terminal', { code: failure.code, usage });
        yield {
          type: 'finish',
          reason: {
            kind: failure.code === 'ABORTED' ? 'aborted' : 'error',
            failure: failure.failure ?? { code: failure.code, message: failure.message },
          },
        };
      } finally {
        request?.cleanup();
        guarded?.cleanup();
        cancelBody(request?.response);
        if (!terminal) trace?.('terminal', { code: 'CONSUMER_RETURN', usage });
      }
    }
  };
}
