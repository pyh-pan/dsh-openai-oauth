import { generateKeyPairSync, sign } from 'node:crypto';
import {
  ISSUER,
  RESOURCE,
  SCOPES,
  TOKEN_ENDPOINT,
  DISCOVERY,
  OpenAIProtocol,
} from '../src/siwc/protocol.js';

export const CLIENT = 'oaiapp_test_registration_12345';
export const HOST = 'urn:uuid:3a127870-6c33-4ac9-aabc-fce69c95af40';
export const NOW = 1_800_000_000_000;
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'test-signing-key',
  alg: 'RS256',
  use: 'sig',
};
export function jwt(claims = {}, header = {}) {
  const h = Buffer.from(
    JSON.stringify({ alg: 'RS256', kid: jwk.kid, typ: 'JWT', ...header }),
  ).toString('base64url');
  const p = Buffer.from(
    JSON.stringify({
      iss: ISSUER,
      aud: CLIENT,
      sub: 'test-subject',
      nonce: 'test-nonce',
      iat: NOW / 1000,
      exp: NOW / 1000 + 3600,
      email: 'example@example.test',
      ...claims,
    }),
  ).toString('base64url');
  return `${h}.${p}.${sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`;
}
export function tokens(claims, overrides) {
  return {
    token_type: 'Bearer',
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    id_token: jwt(claims),
    expires_in: 3600,
    scope: SCOPES,
    ...overrides,
  };
}
export const json = (body, status = 200) => Response.json(body, { status });
export function fixture({
  tokenResponse,
  revocationResponse,
  metadata,
  keys,
  now = () => NOW,
  extraFetch,
  timeoutMs,
} = {}) {
  const requests = [];
  const protocol = new OpenAIProtocol({
    now,
    timeoutMs,
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, ...options });
      if (url === DISCOVERY)
        return json(
          metadata ?? {
            issuer: ISSUER,
            jwks_uri: `${ISSUER}/.well-known/jwks.json`,
            revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke`,
            id_token_signing_alg_values_supported: ['RS256'],
          },
        );
      if (url === `${ISSUER}/.well-known/jwks.json`) return json({ keys: keys ?? [jwk] });
      if (url === TOKEN_ENDPOINT)
        return tokenResponse ? tokenResponse(options, requests) : json(tokens());
      if (url === `${ISSUER}/api/accounts/oauth/revoke`)
        return revocationResponse
          ? revocationResponse(options, requests)
          : new Response(null, { status: 200 });
      if (extraFetch) return extraFetch(url, options);
      throw new Error('Unexpected fixture URL');
    },
  });
  return { protocol, requests, resource: RESOURCE };
}

// Matches credentials-local modifyRecord semantics, including async exclusion
// and its return-current-on-undefined behavior. Native lock tests are separate.
export class MemoryCredentials {
  constructor(shared = { records: new Map(), queue: Promise.resolve() }) {
    this.shared = shared;
  }
  readRecord(key) {
    return Promise.resolve(structuredClone(this.shared.records.get(key)));
  }
  listRecords() {
    return Promise.resolve(
      [...this.shared.records].map(([key, value]) => ({ key, kind: value.kind })),
    );
  }
  modifyRecord(key, mutate) {
    const action = this.shared.queue.then(async () => {
      const current = structuredClone(this.shared.records.get(key));
      const next = await mutate(current);
      if (next === undefined) return current;
      this.shared.records.set(key, structuredClone(next));
      return structuredClone(next);
    });
    this.shared.queue = action.then(
      () => undefined,
      () => undefined,
    );
    return action;
  }
}
