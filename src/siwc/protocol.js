import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { AuthNetworkError, requestAuth } from './auth-network.js';

export const ISSUER = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
export const TOKEN_ENDPOINT = `${ISSUER}/api/accounts/oauth/token`;
export const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
export const AGENT_NAME = 'DSH ChatGPT Source';
export const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
export const SCOPES =
  'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const MAX_JSON = 512 * 1024;

// Only safe machine codes cross the UI/log boundary. Never include a remote
// description, URL, response body, JWT, code, or lower-level exception message.
export class SiwcError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'SiwcError';
    this.code = code;
    this.status = status;
  }
}
export function reject(code, status) {
  throw new SiwcError(code, status);
}
export function safeCode(error) {
  return error instanceof SiwcError ? error.code : 'INTERNAL';
}
export function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export const digest = (value) => createHash('sha256').update(value).digest('base64url');
export const validClientId = (id) =>
  typeof id === 'string' && /^[A-Za-z0-9_-]{8,256}$/.test(id) && id !== DYNAMIC_CLIENT_ID;
export const validHostId = (id) =>
  typeof id === 'string' &&
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);

export async function boundedJson(response, maxBytes = MAX_JSON) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    reject('RESPONSE_TOO_LARGE', 502);
  }
  if (!response.body) reject('INVALID_RESPONSE', 502);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        reject('RESPONSE_TOO_LARGE', 502);
      }
      chunks.push(Buffer.from(value));
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) reject('INVALID_RESPONSE', 502);
    return data;
  } catch (error) {
    if (error instanceof SiwcError) throw error;
    reject('INVALID_RESPONSE', 502);
  } finally {
    reader.releaseLock();
  }
}

export function checkScopes(value, fallback) {
  // Omission is permitted on refresh only, where RFC 6749 preserves the grant.
  if (value === undefined) return Array.isArray(fallback) ? [...fallback] : [];
  if (typeof value !== 'string' || value.length > 8192) reject('INVALID_TOKEN_RESPONSE', 502);
  // Missing direct permission disables inference, not the validated sign-in.
  // Account selection and every inference gate check DIRECT_SCOPE separately.
  return [...new Set(value.trim().split(/\s+/).filter(Boolean))];
}

export function tokenSet(data, { now = Date.now(), previous, requireId = true } = {}) {
  const string = (name) =>
    typeof data[name] === 'string' && data[name].length > 0 && data[name].length <= 65536;
  if (
    !string('access_token') ||
    !/^Bearer$/i.test(data.token_type ?? '') ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0 ||
    data.expires_in > 366 * 86400 ||
    (requireId && !string('id_token')) ||
    (data.refresh_token !== undefined && !string('refresh_token')) ||
    (data.id_token !== undefined && !string('id_token'))
  )
    reject('INVALID_TOKEN_RESPONSE', 502);
  return {
    accessToken: data.access_token,
    ...((data.refresh_token ?? previous?.refreshToken)
      ? { refreshToken: data.refresh_token ?? previous.refreshToken }
      : {}),
    idToken: data.id_token ?? previous?.idToken,
    tokenType: 'Bearer',
    scopes: checkScopes(data.scope, previous?.scopes),
    expiresAt: now + data.expires_in * 1000,
    savedAt: now,
  };
}

function decodePart(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) reject('ID_TOKEN_INVALID');
  try {
    const decoded = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded))
      reject('ID_TOKEN_INVALID');
    return decoded;
  } catch {
    reject('ID_TOKEN_INVALID');
  }
}
function trustedAuthUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== ISSUER || url.username || url.password || url.hash || url.search)
      reject('OIDC_METADATA_INVALID', 502);
    return url.href;
  } catch {
    reject('OIDC_METADATA_INVALID', 502);
  }
}

export class OpenAIProtocol {
  #fetch;
  #now;
  #metadata;
  #keys;
  constructor({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 12000 } = {}) {
    this.#fetch = fetchImpl;
    this.#now = now;
    this.timeoutMs = timeoutMs;
  }
  async request(url, options = {}) {
    try {
      return await requestAuth(this.#fetch, url, options, this.timeoutMs);
    } catch (error) {
      reject(error instanceof AuthNetworkError ? error.code : 'AUTH_NETWORK_FAILED', 502);
    }
  }
  async metadata(signal) {
    if (this.#metadata && this.#metadata.expiresAt > this.#now()) return this.#metadata.value;
    const response = await this.request(DISCOVERY, { signal });
    if (!response.ok) {
      await response.body?.cancel();
      reject('OIDC_DISCOVERY_FAILED', 502);
    }
    const data = await boundedJson(response);
    if (
      data.issuer !== ISSUER ||
      !Array.isArray(data.id_token_signing_alg_values_supported) ||
      !data.id_token_signing_alg_values_supported.includes('RS256')
    )
      reject('OIDC_METADATA_INVALID', 502);
    const result = {
      issuer: ISSUER,
      jwksUri: trustedAuthUrl(data.jwks_uri),
      revocationEndpoint: trustedAuthUrl(data.revocation_endpoint),
    };
    this.#metadata = { value: result, expiresAt: this.#now() + 3600_000 };
    return result;
  }
  async #getKeys(signal, force = false) {
    if (!force && this.#keys && this.#keys.expiresAt > this.#now()) return this.#keys.value;
    const metadata = await this.metadata(signal);
    const response = await this.request(metadata.jwksUri, { signal });
    if (!response.ok) {
      await response.body?.cancel();
      reject('JWKS_UNAVAILABLE', 502);
    }
    const data = await boundedJson(response);
    if (!Array.isArray(data.keys) || data.keys.length < 1 || data.keys.length > 128)
      reject('JWKS_INVALID', 502);
    this.#keys = { value: data.keys, loadedAt: this.#now(), expiresAt: this.#now() + 900_000 };
    return data.keys;
  }
  async verifyIdToken(jwt, { clientId, nonce, subject, signal, allowMissingNonce = false } = {}) {
    if (!validClientId(clientId) || typeof jwt !== 'string' || jwt.length > 65536)
      reject('ID_TOKEN_INVALID');
    const parts = jwt.split('.');
    if (parts.length !== 3) reject('ID_TOKEN_INVALID');
    const header = decodePart(parts[0]);
    if (
      header.alg !== 'RS256' ||
      typeof header.kid !== 'string' ||
      !header.kid ||
      header.kid.length > 256 ||
      header.crit !== undefined ||
      header.b64 !== undefined ||
      !/^[A-Za-z0-9_-]+$/.test(parts[2])
    )
      reject('ID_TOKEN_INVALID');
    let keys = await this.#getKeys(signal);
    let matches = keys.filter((key) => key.kid === header.kid);
    // Refresh on rotation, but not once per arbitrary unknown-kid request.
    if (matches.length === 0 && this.#now() - this.#keys.loadedAt >= 5000) {
      keys = await this.#getKeys(signal, true);
      matches = keys.filter((key) => key.kid === header.kid);
    }
    if (matches.length !== 1) reject('ID_TOKEN_KEY_INVALID');
    const key = matches[0];
    if (
      key.kty !== 'RSA' ||
      (key.alg && key.alg !== 'RS256') ||
      (key.use && key.use !== 'sig') ||
      (key.key_ops && (!Array.isArray(key.key_ops) || !key.key_ops.includes('verify')))
    )
      reject('ID_TOKEN_KEY_INVALID');
    try {
      const publicKey = createPublicKey({ key, format: 'jwk' });
      if (
        (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
        !verify(
          'RSA-SHA256',
          Buffer.from(`${parts[0]}.${parts[1]}`),
          publicKey,
          Buffer.from(parts[2], 'base64url'),
        )
      )
        reject('ID_TOKEN_SIGNATURE_INVALID');
    } catch (error) {
      if (error instanceof SiwcError) throw error;
      reject('ID_TOKEN_KEY_INVALID');
    }
    // Claims become authoritative only after successful signature verification.
    const claims = decodePart(parts[1]);
    const now = this.#now() / 1000;
    const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
    if (
      claims.iss !== ISSUER ||
      !Array.isArray(audiences) ||
      !audiences.every((aud) => typeof aud === 'string') ||
      !audiences.includes(clientId) ||
      ((audiences.length > 1 || claims.azp !== undefined) && claims.azp !== clientId)
    )
      reject('ID_TOKEN_AUDIENCE_INVALID');
    if (
      !Number.isFinite(claims.exp) ||
      claims.exp <= now ||
      (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 30)) ||
      !Number.isFinite(claims.iat) ||
      claims.iat > now + 30
    )
      reject('ID_TOKEN_EXPIRED');
    if (
      nonce !== undefined &&
      !(allowMissingNonce && claims.nonce === undefined) &&
      !equalSecret(claims.nonce, nonce)
    )
      reject('ID_TOKEN_NONCE_INVALID');
    if (
      typeof claims.sub !== 'string' ||
      !claims.sub ||
      claims.sub.length > 1024 ||
      (subject !== undefined && claims.sub !== subject)
    )
      reject('ACCOUNT_MISMATCH');
    return {
      issuer: ISSUER,
      subject: claims.sub,
      ...(typeof claims.email === 'string' && claims.email.length <= 320
        ? { email: claims.email }
        : {}),
      ...(typeof claims.name === 'string' && claims.name.length <= 256
        ? { displayName: claims.name }
        : {}),
    };
  }
  async exchange(form, signal) {
    if (
      !validClientId(form.client_id) ||
      form.resource !== RESOURCE ||
      !['authorization_code', 'refresh_token'].includes(form.grant_type)
    )
      reject('INVALID_TOKEN_REQUEST');
    const response = await this.request(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal,
    });
    const data = await boundedJson(response);
    if (!response.ok) {
      const codes = {
        invalid_grant: 'INVALID_GRANT',
        invalid_client: 'INVALID_CLIENT',
        access_denied: 'ACCESS_DENIED',
        invalid_scope: 'DIRECT_PERMISSION_MISSING',
        invalid_refresh_token: 'REFRESH_TOKEN_INVALID',
        token_expired: 'REFRESH_TOKEN_INVALID',
        refresh_token_expired: 'REFRESH_TOKEN_INVALID',
        refresh_token_invalidated: 'REFRESH_TOKEN_INVALID',
        refresh_token_reused: 'REFRESH_TOKEN_INVALID',
      };
      reject(
        codes[data.error] ?? (response.status === 429 ? 'RATE_LIMIT' : 'TOKEN_EXCHANGE_FAILED'),
        response.status >= 500 ? 502 : 400,
      );
    }
    return data;
  }
  async authorizationGrant({ clientId, code, verifier, redirectUri, nonce, subject, signal }) {
    const data = await this.exchange(
      {
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: RESOURCE,
      },
      signal,
    );
    const tokens = tokenSet(data, { now: this.#now() });
    const identity = await this.verifyIdToken(tokens.idToken, { clientId, nonce, subject, signal });
    return {
      ...identity,
      clientId,
      ...tokens,
      ...(typeof nonce === 'string' ? { oidcNonce: nonce } : {}),
    };
  }
  async refresh(previous, signal) {
    const data = await this.exchange(
      {
        grant_type: 'refresh_token',
        client_id: previous.clientId,
        refresh_token: previous.refreshToken,
        resource: RESOURCE,
      },
      signal,
    );
    const next = tokenSet(data, { now: this.#now(), previous, requireId: false });
    // A fresh ID token has a fresh lifetime, but a refresh has no new OAuth nonce.
    // An omitted ID token retains the already-validated login hint, even if expired.
    const identity =
      data.id_token === undefined
        ? {}
        : await this.verifyIdToken(data.id_token, {
            clientId: previous.clientId,
            subject: previous.subject,
            nonce: previous.oidcNonce,
            allowMissingNonce: true,
            signal,
          });
    return { ...previous, ...identity, ...next };
  }
  async revoke(grant, signal) {
    if (!validClientId(grant.clientId) || !grant.refreshToken) reject('INVALID_REVOCATION');
    const metadata = await this.metadata(signal);
    const response = await this.request(metadata.revocationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: grant.refreshToken,
        token_type_hint: 'refresh_token',
        client_id: grant.clientId,
      }).toString(),
      signal,
    });
    await response.body?.cancel();
    if (response.status !== 200)
      reject(response.status >= 500 ? 'REVOCATION_RETRYABLE' : 'REVOCATION_FAILED', 502);
  }
}
