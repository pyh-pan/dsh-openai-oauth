import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import {
  AGENT_NAME,
  AUTHORIZE,
  DIRECT_SCOPE,
  DYNAMIC_CLIENT_ID,
  RESOURCE,
  SCOPES,
  SiwcError,
  digest,
  equalSecret,
  reject,
  safeCode,
  validClientId,
  validHostId,
} from './protocol.js';

const random = () => randomBytes(32).toString('base64url');
const html = (res, status, text) => {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    connection: 'close',
  });
  res.end(
    `<!doctype html><html lang="zh"><meta charset="utf-8"><title>DSH · ChatGPT</title><body><p>${text}</p></body></html>`,
  );
};

// A single host-only OAuth lifetime. Public status never contains tokens or
// verifier/nonce. The URL contains only public OAuth parameters, no ID hint.
export class OAuthAttempt {
  #protocol;
  #options;
  #server;
  #abort = new AbortController();
  #timer;
  #resolve;
  #state = random();
  #nonce = random();
  #verifier = random();
  #used = false;
  #redirectUri;
  #loginUrl;
  #clientId;
  #phase = 'starting';
  #error;
  #started = false;
  #directEnabled;
  constructor(protocol, options) {
    if (!validHostId(options.hostId)) reject('HOST_ID_INVALID');
    if (options.registration && !validClientId(options.registration.clientId))
      reject('CLIENT_ID_INVALID');
    this.#protocol = protocol;
    this.#options = options;
    this.#clientId = options.registration?.clientId;
    this.id = random();
    this.startedAt = Date.now();
    this.done = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }
  get status() {
    return {
      id: this.id,
      phase: this.#phase,
      startedAt: this.startedAt,
      ...(this.#phase === 'waiting' ? { authorizeUrl: this.#loginUrl } : {}),
      ...(this.#error ? { error: this.#error } : {}),
      ...(this.#directEnabled === undefined ? {} : { directEnabled: this.#directEnabled }),
    };
  }
  async start() {
    if (this.#started) reject('ATTEMPT_ALREADY_STARTED');
    this.#started = true;
    try {
      await this.#listen(this.#options.port ?? 1455);
      if (this.#abort.signal.aborted) {
        this.#closeServer();
        return this.status;
      }
      const address = this.#server.address();
      this.#redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
      const query = new URLSearchParams({
        client_id: this.#clientId ?? DYNAMIC_CLIENT_ID,
        ext_agent_host_id: this.#options.hostId,
        response_type: 'code',
        redirect_uri: this.#redirectUri,
        scope: SCOPES,
        resource: RESOURCE,
        state: this.#state,
        nonce: this.#nonce,
        code_challenge_method: 'S256',
        code_challenge: digest(this.#verifier),
        ...(!this.#clientId ? { agent_name_hint: AGENT_NAME } : {}),
        ...(this.#clientId && this.#options.enablePlanUsage === true ? { prompt: 'consent' } : {}),
      });
      this.#loginUrl = `${AUTHORIZE}?${query}`;
      this.#phase = 'waiting';
      this.#timer = setTimeout(
        () => this.#finish('expired', { error: 'AUTH_TIMEOUT' }),
        this.#options.timeoutMs ?? 10 * 60_000,
      );
      this.#timer.unref?.();
      return this.status;
    } catch (error) {
      this.#finish('failed', {
        error: error instanceof SiwcError ? error.code : 'CALLBACK_UNAVAILABLE',
      });
      return this.status;
    }
  }
  async #listen(port) {
    const server = createServer((req, res) => {
      void this.#callback(req, res).catch(() => {
        if (!res.headersSent) html(res, 500, '授权未完成，请返回 DSH 查看状态。');
        else res.destroy();
      });
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.maxHeadersCount = 32;
    this.#server = server;
    try {
      await new Promise((resolve, rejectListen) => {
        const clear = () => {
          server.off('error', onError);
          server.off('listening', onListen);
          server.off('close', onClose);
        };
        const onError = (error) => {
          clear();
          rejectListen(error);
        };
        const onListen = () => {
          clear();
          resolve();
        };
        const onClose = () => {
          clear();
          rejectListen(new SiwcError('CANCELLED'));
        };
        server.once('error', onError);
        server.once('listening', onListen);
        server.once('close', onClose);
        server.listen({ port, host: '127.0.0.1', signal: this.#abort.signal });
      });
      // Do not let a post-listen server error become an uncaught process error.
      server.on('error', () => this.#finish('failed', { error: 'CALLBACK_UNAVAILABLE' }));
    } catch (error) {
      server.close();
      if (port === 1455 && error.code === 'EADDRINUSE') return this.#listen(0);
      throw error;
    }
  }
  async #callback(req, res) {
    if (this.#abort.signal.aborted || !this.#redirectUri) {
      html(res, 410, '授权已结束。');
      return;
    }
    if (req.method !== 'GET') {
      html(res, 405, '此端点仅处理 OAuth 回调。');
      return;
    }
    const expected = new URL(this.#redirectUri);
    if (
      req.headers.host !== expected.host ||
      (req.headers.origin && req.headers.origin !== new URL(AUTHORIZE).origin)
    ) {
      html(res, 403, '回调来源不正确。');
      return;
    }
    if (
      typeof req.url !== 'string' ||
      !req.url.startsWith('/') ||
      req.url.startsWith('//') ||
      req.url.length > 16384
    ) {
      html(res, 400, '回调格式不正确。');
      return;
    }
    const url = new URL(req.url, this.#redirectUri);
    if (url.pathname !== expected.pathname) {
      html(res, 404, '未找到此页面。');
      return;
    }
    const params = url.searchParams;
    if (
      ['state', 'code', 'client_id', 'error', 'scope'].some(
        (key) => params.getAll(key).length > 1,
      ) ||
      !equalSecret(params.get('state'), this.#state)
    ) {
      html(res, 400, 'OAuth state 验证失败，请返回原授权窗口。');
      return;
    }
    if (this.#used) {
      html(res, 409, '此回调已处理，请返回 DSH。');
      return;
    }
    this.#used = true;
    this.#phase = 'verifying';
    this.#loginUrl = undefined;
    try {
      if (params.has('error'))
        reject(params.get('error') === 'access_denied' ? 'ACCESS_DENIED' : 'AUTHORIZATION_FAILED');
      const returnedId = params.get('client_id');
      if (!this.#clientId && !validClientId(returnedId)) reject('REGISTRATION_INCOMPLETE');
      if (this.#clientId && returnedId !== null && returnedId !== this.#clientId)
        reject('CLIENT_ID_MISMATCH');
      this.#clientId ??= returnedId;
      const code = params.get('code');
      if (!code || code.length > 8192) reject('AUTHORIZATION_CODE_MISSING');
      this.#abort.signal.throwIfAborted();
      // Persist only a pending public registration here: no account becomes
      // active until token signature, identity, scope and cancellation checks.
      await this.#options.onIssued?.(this.#clientId, this.#abort.signal);
      this.#abort.signal.throwIfAborted();
      const grant = await this.#protocol.authorizationGrant({
        clientId: this.#clientId,
        code,
        verifier: this.#verifier,
        redirectUri: this.#redirectUri,
        nonce: this.#nonce,
        subject: this.#options.registration?.subject,
        signal: this.#abort.signal,
      });
      this.#abort.signal.throwIfAborted();
      await this.#options.onAuthorized?.(grant, this.#abort.signal);
      this.#abort.signal.throwIfAborted();
      this.#directEnabled = grant.scopes.includes(DIRECT_SCOPE);
      html(
        res,
        200,
        this.#directEnabled
          ? '授权与身份验证成功。请返回 DSH 选择此账号以启用订阅模型源。'
          : '账号登录成功，但订阅推理权限尚未启用。请返回 DSH 查看设置。',
      );
      this.#finish('authorized', { clientId: this.#clientId, directEnabled: this.#directEnabled });
    } catch (error) {
      if (!res.headersSent) html(res, 400, '授权未完成，请返回 DSH 查看原因并重试。');
      if (!this.#abort.signal.aborted)
        this.#finish('failed', {
          error: safeCode(error),
          ...(this.#clientId ? { clientId: this.#clientId } : {}),
        });
    }
  }
  #closeServer() {
    this.#server?.close();
    // An idle browser socket must not retain the callback port across cancel/HMR.
    this.#server?.closeIdleConnections?.();
    this.#server?.closeAllConnections?.();
    this.#server = undefined;
  }
  #finish(phase, result = {}) {
    if (['authorized', 'failed', 'cancelled', 'expired'].includes(this.#phase)) return;
    this.#phase = phase;
    this.#error = result.error;
    clearTimeout(this.#timer);
    this.#abort.abort();
    this.#loginUrl = undefined;
    this.#state = this.#nonce = this.#verifier = undefined;
    // Let a completed callback response flush, then force idle connections shut.
    if (phase === 'authorized' || phase === 'failed') {
      this.#server?.close();
      this.#server?.closeIdleConnections?.();
      const server = this.#server;
      const cleanup = setTimeout(() => server?.closeAllConnections?.(), 100);
      cleanup.unref?.();
      this.#server = undefined;
    } else this.#closeServer();
    this.#resolve({ phase, ...result });
  }
  cancel() {
    this.#finish('cancelled');
  }
  dispose() {
    this.cancel();
  }
}
