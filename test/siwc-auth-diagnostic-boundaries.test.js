import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAuthDiagnostic } from '../src/siwc/auth-diagnostics.js';
import { OpenAIProtocol } from '../src/siwc/protocol.js';
import { CLIENT, NOW } from './siwc-fixtures.js';

test('formatter cannot coerce an outcome object or trust customized array methods', () => {
  const base = { schema: 1, outcome: 'AUTH_REQUEST_UNCONFIRMED' };
  const dangerous = { toString: () => base.outcome, toJSON: () => 'PRIVATE_TOKEN' };
  assert.equal(formatAuthDiagnostic({ ...base, outcome: dangerous }), '');
  const codes = ['ECONNRESET'];
  codes.filter = () => [dangerous];
  codes[Symbol.iterator] = function* () {
    yield dangerous;
  };
  const result = formatAuthDiagnostic({ ...base, transportCodes: codes });
  assert.match(result, /ECONNRESET/);
  assert.doesNotMatch(result, /PRIVATE/);
});

test('concurrent protocol failures retain the first completed failure, even when a later-started call fails first', async () => {
  let calls = 0;
  const protocol = new OpenAIProtocol({
    diagnostics: true,
    now: () => NOW,
    fetchImpl: async () => {
      const call = ++calls;
      await new Promise((resolve) => setTimeout(resolve, call === 1 ? 20 : 1));
      throw new TypeError('PRIVATE', {
        cause: Object.assign(Error('PRIVATE'), {
          code: call === 1 ? 'ECONNRESET' : 'UND_ERR_SOCKET',
        }),
      });
    },
  });
  const previous = { clientId: CLIENT, refreshToken: 'PRIVATE_TOKEN', expiresAt: NOW - 1 };
  const results = await Promise.allSettled([
    protocol.refresh(previous),
    protocol.refresh(previous),
  ]);
  assert.ok(results.every((result) => result.status === 'rejected'));
  const a = results[0].reason.authDiagnostic,
    b = results[1].reason.authDiagnostic;
  assert.ok(a && b);
  assert.equal(a, b);
  assert.deepEqual(a.transportCodes, ['UND_ERR_SOCKET']);
  assert.equal(calls, 2);
});
