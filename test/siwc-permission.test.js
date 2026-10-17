import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore } from '../src/siwc/accounts.js';
import { SiwcController } from '../src/siwc/controller.js';
import { DIRECT_SCOPE } from '../src/siwc/protocol.js';
import { CLIENT, MemoryCredentials, fixture, json, tokens } from './siwc-fixtures.js';

test('declining direct permission retains validated sign-in and explicitly reconsents using the same issued client', async (t) => {
  let authorization;
  const { protocol } = fixture({
    tokenResponse: () =>
      json(
        tokens(
          { nonce: authorization.searchParams.get('nonce') },
          { scope: 'openid email profile offline_access' },
        ),
      ),
  });
  const accounts = new AccountStore(new MemoryCredentials());
  const controller = new SiwcController({ accounts, protocol }, { port: 0 });
  t.after(() => controller.dispose());
  const started = await controller.start();
  authorization = new URL(started.attempt.authorizeUrl);
  const callback = new URL(authorization.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({
    state: authorization.searchParams.get('state'),
    code: 'synthetic-code',
    client_id: CLIENT,
    scope: DIRECT_SCOPE,
  });
  // Deliberately lie in callback scope: only granted token-response scope counts.
  assert.equal((await fetch(callback)).status, 200);
  const signedIn = await controller.snapshot();
  assert.equal(signedIn.attempt.phase, 'authorized');
  assert.equal(signedIn.attempt.directEnabled, false);
  assert.equal(signedIn.accounts[0].signedIn, true);
  assert.equal(signedIn.accounts[0].inferenceEnabled, false);
  assert.equal(signedIn.accounts[0].status, 'disabled');
  assert.equal(signedIn.selection, undefined);
  const key = signedIn.accounts[0].key;
  await assert.rejects(controller.select(key), { code: 'ACCOUNT_REAUTH_REQUIRED' });
  const normal = await controller.start(key);
  const regular = new URL(normal.attempt.authorizeUrl);
  assert.equal(regular.searchParams.get('client_id'), CLIENT);
  assert.equal(regular.searchParams.has('prompt'), false);
  controller.cancel(normal.attempt.id);
  const enabling = await controller.start(key, true);
  const consent = new URL(enabling.attempt.authorizeUrl);
  assert.equal(consent.searchParams.get('client_id'), CLIENT);
  assert.equal(consent.searchParams.get('prompt'), 'consent');
  assert.equal(consent.searchParams.has('force_reconsent'), false);
  assert.equal(consent.searchParams.has('agent_name_hint'), false);
  assert.ok(consent.searchParams.get('scope').split(' ').includes(DIRECT_SCOPE));
  assert.notEqual(consent.searchParams.get('nonce'), regular.searchParams.get('nonce'));
  assert.equal((await accounts.accounts()).length, 1);
});
