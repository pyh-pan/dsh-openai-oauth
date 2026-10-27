import { RESOURCE, SiwcError, boundedJson, reject } from './protocol.js';
import { AUTH_NETWORK_MESSAGES } from './auth-network.js';
import { formatAuthDiagnostic } from './auth-diagnostics.js';
import { withSignal, guardedBody, cancelBody } from './abortable.js';
import { ModelCache } from './model-cache.js';
import {
  ATTACHMENT_MESSAGES,
  attachmentCapabilities,
  prepareAttachmentParts,
} from './attachments.js';
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

const STATE_MESSAGES = Object.freeze({
  ACCOUNT_RENEWAL_UNCONFIRMED:
    'A previous authorization renewal was not confirmed. Automatic reuse of the old refresh token is blocked; authorize this registration again in subscription settings.',
  ACCOUNT_REFRESH_IN_PROGRESS:
    'Authorization renewal is in progress; the rotating credential was not resubmitted.',
  ACCOUNT_REFRESH_REQUIRED:
    'Authorization must be renewed to obtain a verified catalog. Use the explicit Update model catalog action in subscription settings.',
  MODEL_CATALOG_UNAVAILABLE:
    'No verified model catalog is available. Update it in subscription settings.',
});
const TIMEOUT_MESSAGES = Object.freeze({
  RESPONSE_HEADERS_TIMEOUT: 'SIWC_RESPONSE_HEADERS_TIMEOUT',
  STREAM_TOTAL_TIMEOUT: 'SIWC_STREAM_TOTAL_TIMEOUT_FROM_HEADERS',
  CATALOG_TIMEOUT: 'SIWC_CATALOG_TIMEOUT',
  ERROR_BODY_TIMEOUT: 'SIWC_ERROR_BODY_TIMEOUT',
});
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
export function createAdapterClass({
  LlmAdapter,
  LlmError,
  attributionHeaders,
  offloadedImageText,
}) {
  return class ChatGPTSubscriptionAdapter extends LlmAdapter {
    #accounts;
    #sessions;
    #fetch;
    #cache;
    #catalogCache;
    #directory;
    #epoch = 0;
    #closed = new AbortController();
    #notice = null;
    #policy;
    #logger;
    #timingNow;
    #assertCoverage;
    #attachments;
    #restoreFiles;
    constructor({
      accounts,
      sessions,
      fetchImpl = globalThis.fetch,
      now = Date.now,
      idleTimeoutMs,
      requestPolicy,
      logger,
      timingNow,
      assertCoverage,
      attachments,
      restoreFiles,
      catalogCache,
    }) {
      super();
      this.#accounts = accounts;
      this.#sessions = sessions;
      this.#fetch = fetchImpl;
      this.#attachments = attachments;
      this.#restoreFiles = restoreFiles;
      this.now = now;
      this.#catalogCache = catalogCache ?? new ModelCache({ now });
      // Retain the original offline fixture's idleTimeoutMs injection. Public
      // configuration has one owner/name: requestPolicy.streamIdleTimeoutMs.
      this.#policy = normalizeRequestPolicy(
        idleTimeoutMs === undefined
          ? requestPolicy
          : { ...normalizeRequestPolicy(requestPolicy), streamIdleTimeoutMs: idleTimeoutMs },
      );
      this.#logger = logger;
      this.#timingNow = timingNow;
      this.#assertCoverage = assertCoverage;
    }
    #attachmentStore() {
      return typeof this.#attachments === 'function' ? this.#attachments() : this.#attachments;
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
      this.#epoch++;
      this.#cache = undefined;
      this.#directory = undefined;
    }
    get directoryStatus() {
      return this.#directory ? structuredClone(this.#directory) : null;
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
      const message =
        TIMEOUT_MESSAGES[rawCode] ??
        AUTH_NETWORK_MESSAGES[rawCode] ??
        STATE_MESSAGES[rawCode] ??
        ATTACHMENT_MESSAGES[rawCode];
      const code = TIMEOUT_MESSAGES[rawCode] ? 'TIMEOUT' : rawCode;
      const diagnostic =
        AUTH_NETWORK_MESSAGES[rawCode] && reason instanceof SiwcError
          ? formatAuthDiagnostic(reason.authDiagnostic)
          : '';
      return new LlmError(diagnostic ? `${diagnostic}\n${message}` : (message ?? code), code);
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
    async #request(
      path,
      {
        selection,
        signal,
        body,
        stream = false,
        affinity,
        trace,
        sessionId,
        purpose,
        metadataOnly = false,
        credentialGeneration,
      },
    ) {
      // Auth/selection are cancellable, but are not part of the historical
      // headers clock. Do not manufacture a host model-step total deadline.
      const lifetime = this.#signal(signal);
      await this.#selected(selection, lifetime);
      const access = await withSignal(
        () =>
          this.#sessions.access(selection.key, {
            signal: lifetime,
            selection,
            allowNearExpiry: path === 'models' && metadataOnly,
            allowRefresh: !metadataOnly,
          }),
        lifetime,
      );
      await this.#selected(selection, lifetime);
      if (
        credentialGeneration !== undefined &&
        (access.credentialGeneration ?? 0) !== credentialGeneration
      )
        reject('MODEL_CATALOG_CHANGED', 409);
      const catalogEpoch = this.#epoch;
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
        response = await withSignal(
          () => {
            // Refresh/selection can also yield after body construction. Check
            // the retained composition again at the actual inference boundary.
            if (path === 'responses') this.#assertCoverage?.(sessionId, purpose);
            trace?.('fetch-start');
            return this.#fetch(`${RESOURCE}/${path}`, {
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
            });
          },
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
        return {
          response,
          signal: combined,
          cleanup,
          catalogEpoch,
          credentialGeneration: access.credentialGeneration ?? 0,
        };
      } catch (error) {
        cleanup();
        cancelBody(response);
        const failure = this.#error(error, combined);
        if (combined.reason?.code === 'ERROR_BODY_TIMEOUT')
          throw new LlmError(failure.message, failure.code, { status: response.status });
        throw failure;
      }
    }
    async #catalog(
      selection,
      signal,
      { metadataOnly = false, force = false, capture = false } = {},
    ) {
      signal = this.#signal(signal);
      signal.throwIfAborted();
      const scope = await this.#accounts.catalogScope?.(selection);
      if (scope && !scope.allowed) reject('DIRECT_PERMISSION_MISSING', 403);
      if (
        !force &&
        this.#cache &&
        same(selection, this.#cache.selection) &&
        this.#cache.expiresAt > this.now() &&
        (scope?.credentialGeneration === undefined ||
          this.#cache.credentialGeneration === scope.credentialGeneration)
      )
        return capture
          ? {
              models: structuredClone(this.#cache.models),
              capabilities: this.#cache.capabilities,
              credentialGeneration: this.#cache.credentialGeneration,
            }
          : structuredClone(this.#cache.models);
      if (metadataOnly && scope) {
        const retained = await this.#catalogCache.get(scope.scope);
        await this.#selected(selection, signal);
        const current = await this.#accounts.catalogScope(selection);
        if (!current.allowed || current.scope !== scope.scope) reject('ACCOUNT_CHANGED', 409);
        if (retained) {
          this.#directory = { cached: true, cachedAt: retained.cachedAt };
          return retained.models;
        }
      }
      const request = await this.#request('models', { selection, signal, metadataOnly });
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
          const attachment = attachmentCapabilities(entry, this.#attachmentStore());
          capabilities.set(entry.slug, {
            reasoningSummary: entry.supports_reasoning_summary_parameter === true,
            reasoningEfforts: reasoning?.efforts.map((level) => level.id),
            ...attachment,
          });
          models.push({
            provider: PROVIDER,
            id: entry.slug,
            name:
              typeof entry.display_name === 'string' && entry.display_name.length <= 256
                ? entry.display_name
                : entry.slug,
            ...(attachment.inputModalities ? { inputModalities: attachment.inputModalities } : {}),
            ...(reasoning ? { reasoning } : {}),
            ...(Number.isSafeInteger(entry.context_window) && entry.context_window > 0
              ? { context: { contextWindow: entry.context_window } }
              : {}),
          });
        }
        await this.#selected(selection, request.signal);
        const currentScope = await this.#accounts.catalogScope?.(selection);
        if (
          (!currentScope && this.#epoch !== request.catalogEpoch) ||
          (currentScope &&
            (!currentScope.allowed ||
              currentScope.scope !== scope?.scope ||
              currentScope.credentialGeneration !== request.credentialGeneration))
        )
          reject('MODEL_CATALOG_CHANGED', 409);
        this.#cache = {
          selection,
          models: structuredClone(models),
          capabilities,
          credentialGeneration: request.credentialGeneration,
          expiresAt: this.now() + 60000,
        };
        if (currentScope) this.#catalogCache.set(currentScope.scope, models).catch(() => {});
        this.#directory = { cached: false, cachedAt: this.now() };
        return capture
          ? { models, capabilities, credentialGeneration: request.credentialGeneration }
          : models;
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
        return await this.#catalog(selection, undefined, { metadataOnly: true });
      } catch (error) {
        const failure = this.#error(error);
        this.#report(failure.failure ?? failure);
        throw failure;
      }
    }
    async refreshModels(signal, { renewAuthorization = false } = {}) {
      const selection = await this.#selected(undefined, signal);
      if (renewAuthorization)
        await withSignal(
          () => this.#sessions.access(selection.key, { signal, selection, forceRefresh: true }),
          signal,
        );
      const models = await this.#catalog(selection, signal, { force: true });
      return { count: models.length, authorizationRenewed: renewAuthorization };
    }
    async #model(provider, model, selection, signal, mode) {
      if (provider !== PROVIDER) reject('NO_ADAPTER');
      const models = await this.#catalog(selection, signal, mode);
      const found = models.find((entry) => entry.id === model);
      if (!found) reject('UNKNOWN_MODEL', 404);
      return found;
    }
    async resolveModel(provider, model, signal) {
      signal = this.#signal(signal);
      try {
        return await this.#model(provider, model, await this.#selected(undefined, signal), signal, {
          metadataOnly: true,
        });
      } catch (error) {
        throw this.#error(error, signal);
      }
    }
    async prepareCall(provider, model, signal) {
      signal = this.#signal(signal);
      try {
        if (provider !== PROVIDER) reject('NO_ADAPTER');
        const selection = await this.#selected(undefined, signal);
        // UI resolution never renews; actual preparation does, before capturing
        // its credential-bound capabilities (including a warm directory).
        await withSignal(() => this.#sessions.access(selection.key, { signal, selection }), signal);
        const catalog = await this.#catalog(selection, signal, { capture: true });
        const info = catalog.models.find((entry) => entry.id === model);
        if (!info) reject('UNKNOWN_MODEL', 404);
        const capability = catalog.capabilities.get(model);
        if (!capability) reject('MODEL_CATALOG_CHANGED', 409);
        const captured = { ...capability, credentialGeneration: catalog.credentialGeneration };
        return { model: info, stream: (options) => this.#stream(options, selection, captured) };
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
    async *#stream(options, selection, capability) {
      let request, guarded, usage;
      let terminal = false;
      const trace = createTimingTrace(this.#policy, this.#logger, this.#timingNow);
      try {
        const signal = this.#signal(options.signal);
        signal.throwIfAborted();
        if (options.provider !== PROVIDER) reject('NO_ADAPTER');
        await this.#selected(selection, signal);
        // The native prepareCall path bypasses stream(), so admission belongs
        // here too, after the selection wait and before any history projection.
        this.#assertCoverage?.(options.sessionId, options.purpose);
        const messages = this.#restoreFiles?.(options, capability) ?? options.messages;
        if (
          options.reasoningEffort !== undefined &&
          !capability.reasoningEfforts?.includes(options.reasoningEffort)
        )
          reject('MODEL_CATALOG_CHANGED', 409);
        const attachmentParts = await prepareAttachmentParts(messages, {
          store: this.#attachmentStore(),
          capabilities: capability,
          signal,
          offloadedText: offloadedImageText,
        });
        // Attachment I/O yields: do not reuse admission across that wait.
        this.#assertCoverage?.(options.sessionId, options.purpose);
        const body = responsesBody(
          { ...options, messages },
          {
            accountKey: selection.key,
            reasoningSummary: capability.reasoningSummary === true,
            attachmentParts,
          },
        );
        const affinity = sessionAffinity(options.sessionId, selection.key);
        request = await this.#request('responses', {
          selection,
          signal: options.signal,
          body,
          stream: true,
          affinity,
          trace,
          sessionId: options.sessionId,
          purpose: options.purpose,
          credentialGeneration: capability.credentialGeneration,
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
