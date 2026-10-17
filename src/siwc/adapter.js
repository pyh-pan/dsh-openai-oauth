import { RESOURCE, SiwcError, boundedJson, reject, safeCode } from './protocol.js';
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
    constructor({
      accounts,
      sessions,
      fetchImpl = globalThis.fetch,
      now = Date.now,
      idleTimeoutMs = 120000,
    }) {
      super();
      this.#accounts = accounts;
      this.#sessions = sessions;
      this.#fetch = fetchImpl;
      this.now = now;
      this.idleTimeoutMs = idleTimeoutMs;
    }
    providerInfo(provider) {
      return { id: provider, name: 'ChatGPT Subscription' };
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
      if (error instanceof LlmError) return error;
      const reason = signal?.aborted ? signal.reason : undefined;
      const code =
        reason instanceof SiwcError
          ? reason.code
          : signal?.aborted
            ? reason?.name === 'TimeoutError'
              ? 'TIMEOUT'
              : 'ABORTED'
            : error instanceof SiwcError
              ? error.code
              : 'TRANSPORT';
      return new LlmError(code, code);
    }
    async #selected(expected) {
      const selected = await this.#accounts.selection();
      if (!selected) reject('ACCOUNT_REAUTH_REQUIRED', 401);
      if (expected && !same(selected, expected)) reject('ACCOUNT_CHANGED', 409);
      return selected;
    }
    async #request(path, { selection, signal, body, stream = false, affinity }) {
      if (this.#closed.signal.aborted) reject('PLUGIN_DISPOSED');
      await this.#selected(selection);
      const access = await this.#sessions.access(selection.key, { signal, selection });
      await this.#selected(selection);
      const timeout = new AbortController();
      const signals = [
        this.#closed.signal,
        timeout.signal,
        ...(signal ? [signal] : []),
        ...(access.signal ? [access.signal] : []),
      ];
      const combined = AbortSignal.any(signals);
      let timer = setTimeout(() => timeout.abort(new SiwcError('TIMEOUT')), stream ? 60000 : 15000);
      try {
        combined.throwIfAborted();
        const response = await this.#fetch(`${RESOURCE}/${path}`, {
          method: body ? 'POST' : 'GET',
          headers: {
            ...attributionHeaders(),
            authorization: `Bearer ${access.accessToken}`,
            accept: stream ? 'text/event-stream' : 'application/json',
            ...(body ? { 'content-type': 'application/json' } : {}),
            // Keep inference affinity stable without attaching session metadata to catalog calls.
            ...(path === 'responses' && affinity
              ? { session_id: affinity, 'x-client-request-id': affinity }
              : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: 'error',
          signal: combined,
        });
        if (stream) {
          clearTimeout(timer);
          timer = setTimeout(() => timeout.abort(new SiwcError('TIMEOUT')), 30 * 60_000);
        }
        if (!response.ok) {
          let data;
          try {
            data = await boundedJson(response);
          } catch {
            /* Status still retained for non-JSON failure pages. */
          }
          const failure = providerFailure(
            data?.error,
            response.status,
            response.headers.get('x-request-id'),
          );
          throw new LlmError(failure.message, failure.code, failure);
        }
        return { response, signal: combined, cleanup: () => clearTimeout(timer) };
      } catch (error) {
        clearTimeout(timer);
        throw this.#error(error, combined);
      }
    }
    async #catalog(selection, signal) {
      if (
        this.#cache &&
        same(selection, this.#cache.selection) &&
        this.#cache.expiresAt > this.now()
      )
        return structuredClone(this.#cache.models);
      const request = await this.#request('models', { selection, signal });
      try {
        const data = await boundedJson(request.response, MAX_CATALOG_BYTES);
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
        await this.#selected(selection);
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
      }
    }
    async listModels(provider) {
      if (provider !== PROVIDER) throw new LlmError('NO_ADAPTER', 'NO_ADAPTER');
      try {
        const selection = await this.#accounts.selection();
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
      try {
        return await this.#model(provider, model, await this.#selected(), signal);
      } catch (error) {
        throw this.#error(error, signal);
      }
    }
    async prepareCall(provider, model, signal) {
      try {
        const selection = await this.#selected();
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
      let request;
      try {
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
        });
        // `stream:true` determines the wire protocol, not a proxy's MIME label.
        // Decode strictly as SSE regardless of generic transport content-type;
        // malformed framing/JSON or missing response.completed still fails shut.
        if (!request.response.body) reject('INVALID_STREAM', 502);
        const state = new ResponseStream({ accountKey: selection.key, model: options.model });
        for await (const event of sseEvents(request.response.body, {
          signal: request.signal,
          idleTimeoutMs: this.idleTimeoutMs,
        })) {
          for (const chunk of state.event(event, request.response.headers.get('x-request-id'))) {
            if (chunk.type === 'finish') {
              if (chunk.reason.kind === 'error') this.#report(chunk.reason.failure);
              else this.clearNotice();
              yield chunk;
              return;
            }
            yield chunk;
          }
        }
        reject('STREAM_CLOSED', 502);
      } catch (error) {
        const failure = this.#error(error, request?.signal ?? options.signal);
        this.#report(failure.failure ?? failure);
        yield {
          type: 'finish',
          reason: {
            kind: failure.code === 'ABORTED' ? 'aborted' : 'error',
            failure: failure.failure ?? { code: failure.code, message: failure.code },
          },
        };
      } finally {
        request?.cleanup();
        try {
          await request?.response.body?.cancel();
        } catch {
          /* Reader already closed. */
        }
      }
    }
  };
}
