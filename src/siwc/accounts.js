import { createHash, randomUUID } from 'node:crypto';
import { DIRECT_SCOPE, ISSUER, digest, reject, validClientId, validHostId } from './protocol.js';
import { credentialGeneration } from './renewal.js';

export const OWNER = 'chatgpt-subscription-login';
export const HOST_KEY = `${OWNER}/host`;
export const SELECTION_KEY = `${OWNER}/selection`;
const PREFIX = `${OWNER}/account-`;
const record = (payload) => ({ kind: 'grant', payload });
// Native credential keys require lowercase hyphenated identifiers; base64url
// hashes contain capitals/underscores and are NOT valid record-key segments.
const accountKey = (clientId) => `${PREFIX}${createHash('sha256').update(clientId).digest('hex')}`;
const validKey = (key) =>
  typeof key === 'string' &&
  key.startsWith(PREFIX) &&
  /^[a-f0-9]{64}$/.test(key.slice(PREFIX.length));
const readPayload = (value) =>
  value?.kind === 'grant' && [1, 2].includes(value.payload?.schema) ? value.payload : undefined;
const checkSignal = (signal) => {
  if (signal?.aborted) reject('CANCELLED');
};

// All writes stay in this plugin's namespace. No credential enumeration outside
// that namespace, no token reads from Pi/Codex, and no plain settings secrets.
export class AccountStore {
  constructor(credentials, { now = Date.now } = {}) {
    this.credentials = credentials;
    this.now = now;
  }
  async hostId() {
    const saved = await this.credentials.modifyRecord(HOST_KEY, (current) => {
      const existing = readPayload(current);
      if (existing && validHostId(existing.hostId)) return undefined;
      if (current) reject('HOST_RECORD_INVALID');
      return record({ schema: 1, hostId: `urn:uuid:${randomUUID()}` });
    });
    return readPayload(saved).hostId;
  }
  assertRegistration(key, payload) {
    if (
      !validKey(key) ||
      !payload ||
      !validClientId(payload.clientId) ||
      accountKey(payload.clientId) !== key
    )
      reject('ACCOUNT_NOT_FOUND', 404);
    return payload;
  }
  async registration(key, { fresh = false } = {}) {
    if (!validKey(key)) reject('ACCOUNT_NOT_FOUND', 404);
    return this.assertRegistration(
      key,
      readPayload(
        fresh
          ? await this.credentials.modifyRecord(key, () => undefined)
          : await this.credentials.readRecord(key),
      ),
    );
  }
  async beginRegistration(clientId, signal) {
    if (!validClientId(clientId)) reject('CLIENT_ID_INVALID');
    checkSignal(signal);
    const key = accountKey(clientId);
    await this.credentials.modifyRecord(key, (current) => {
      checkSignal(signal);
      const existing = readPayload(current);
      if (existing && existing.clientId === clientId) return undefined;
      if (current) reject('ACCOUNT_RECORD_INVALID');
      return record({ schema: 1, clientId, status: 'pending', createdAt: Date.now() });
    });
    return key;
  }
  async saveValidated(grant, signal) {
    checkSignal(signal);
    if (
      !validClientId(grant.clientId) ||
      grant.issuer !== ISSUER ||
      typeof grant.subject !== 'string' ||
      !grant.subject ||
      !Array.isArray(grant.scopes) ||
      !grant.accessToken ||
      !grant.idToken ||
      !Number.isFinite(grant.expiresAt) ||
      (grant.refreshToken !== undefined &&
        (typeof grant.refreshToken !== 'string' || !grant.refreshToken))
    )
      reject('INVALID_GRANT_RECORD');
    const key = accountKey(grant.clientId);
    await this.credentials.modifyRecord(key, (current) => {
      checkSignal(signal);
      const existing = readPayload(current);
      if (!existing || existing.clientId !== grant.clientId) reject('REGISTRATION_INCOMPLETE');
      if (existing.subject && existing.subject !== grant.subject) reject('ACCOUNT_MISMATCH');
      if (existing.renewal?.state === 'revoking' && existing.renewal.expiresAt > this.now())
        reject('AUTH_BUSY', 409);
      const {
        accessToken,
        refreshToken,
        idToken,
        expiresAt,
        savedAt,
        scopes,
        tokenType,
        renewal: _renewal,
        credentialGeneration: _generation,
        ...mapping
      } = existing;
      const {
        renewal: _grantRenewal,
        credentialGeneration: _grantGeneration,
        ...validated
      } = grant;
      return record({
        ...mapping,
        ...validated,
        schema: 2,
        credentialGeneration: credentialGeneration(existing) + 1,
        status: grant.scopes.includes(DIRECT_SCOPE) ? 'authorized' : 'disabled',
        updatedAt: Date.now(),
      });
    });
    // Saving a verified account NEVER changes the active account. Selection is a
    // separate explicit UI action, so cancel/HMR cannot switch a running session.
    return key;
  }
  async accounts() {
    const entries = await this.credentials.listRecords();
    const accounts = [];
    for (const { key } of entries) {
      if (!validKey(key)) continue;
      const account = await this.registration(key);
      accounts.push({
        key,
        label: `${account.email ?? account.displayName ?? 'ChatGPT'} · ${digest(account.clientId).slice(0, 8)}`,
        status: account.status,
        signedIn: ['authorized', 'disabled'].includes(account.status) && !!account.accessToken,
        inferenceEnabled:
          account.status === 'authorized' &&
          account.scopes?.includes(DIRECT_SCOPE) &&
          !account.renewal,
        permissionGranted: account.scopes?.includes(DIRECT_SCOPE) === true,
        renewalState:
          account.renewal?.state === 'pending' && account.renewal.expiresAt <= this.now()
            ? 'uncertain'
            : (account.renewal?.state ?? null),
        welcomeRequired: account.status === 'authorized' && !account.welcomeSeen,
        renewable: !!account.refreshToken,
      });
    }
    return accounts;
  }
  async catalogScope(selection) {
    const account = await this.registration(selection.key, { fresh: true });
    return {
      scope: digest(
        JSON.stringify([await this.hostId(), selection.key, account.issuer, account.subject]),
      ),
      allowed: account.status === 'authorized' && account.scopes?.includes(DIRECT_SCOPE) === true,
      credentialGeneration: credentialGeneration(account),
    };
  }
  async acknowledgeWelcome(key) {
    await this.registration(key);
    await this.credentials.modifyRecord(key, (current) => {
      const account = readPayload(current);
      if (account?.status !== 'authorized' || !account.scopes?.includes(DIRECT_SCOPE))
        reject('DIRECT_PERMISSION_MISSING', 403);
      if (account.welcomeSeen) return undefined;
      return record({ ...account, welcomeSeen: true });
    });
  }
  async selection() {
    // A readRecord cache can lag another process until its file watcher fires.
    // A no-op exclusive mutation reloads from disk before request dispatch.
    const selection = readPayload(
      await this.credentials.modifyRecord(SELECTION_KEY, () => undefined),
    );
    return selection && validKey(selection.accountKey)
      ? { key: selection.accountKey, generation: selection.generation }
      : undefined;
  }
  async select(key, signal) {
    checkSignal(signal);
    const account = await this.registration(key);
    if (
      account.status !== 'authorized' ||
      !account.accessToken ||
      !account.scopes?.includes(DIRECT_SCOPE)
    )
      reject('ACCOUNT_REAUTH_REQUIRED', 401);
    await this.credentials.modifyRecord(SELECTION_KEY, (current) => {
      checkSignal(signal);
      const existing = readPayload(current);
      return record({ schema: 1, accountKey: key, generation: (existing?.generation ?? 0) + 1 });
    });
    return this.selection();
  }
}
