// Installed credential-file transactions across disposable test processes.
// Only generated temp files and synthetic grants; no real network is permitted.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AccountStore } from '../src/siwc/accounts.js';
import { SessionManager } from '../src/siwc/sessions.js';
import { CLIENT } from '../test/siwc-fixtures.js';
import { ISSUER, DIRECT_SCOPE, SiwcError, safeCode } from '../src/siwc/protocol.js';
const prefix = 'dsh-siwc-renewal-';
async function environment(asar, directory) {
  if (
    !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
    !basename(directory).startsWith(prefix)
  )
    throw Error('NON_FIXTURE_PATH_REFUSED');
  const req = createRequire(pathToFileURL(join(asar, 'dsh/package.json'))),
    load = (name) => import(pathToFileURL(req.resolve('@deepseek-ai/' + name)).href);
  const [{ Context }, { default: Credentials }] = await Promise.all([
    load('cordis'),
    load('dsh-credentials-local'),
  ]);
  const ctx = new Context();
  await ctx.plugin(Credentials, {
    path: join(directory, 'temporary-credentials.yaml'),
    watch: false,
  });
  return { ctx, accounts: new AccountStore(ctx.credentials) };
}
async function child(asar, mode, directory) {
  globalThis.fetch = async () => {
    throw Error('REAL_NETWORK_DISABLED_IN_FIXTURE');
  };
  const { ctx, accounts } = await environment(asar, directory);
  let calls = 0,
    code,
    manager;
  try {
    const key = await accounts.beginRegistration(CLIENT),
      saved = await accounts.registration(key, { fresh: true });
    assert.equal(saved.subject, 'native-renewal-fixture');
    assert.equal(saved.accessToken, 'synthetic-old-access');
    if (mode === 'waiter') {
      const modify = ctx.credentials.modifyRecord.bind(ctx.credentials);
      let notified = false;
      ctx.credentials.modifyRecord = (key, action) =>
        modify(key, (current) => {
          if (!notified && current?.payload?.renewal?.state === 'pending') {
            notified = true;
            process.send?.({ stage: 'observed-pending' });
          }
          return action(current);
        });
    }
    manager = new SessionManager({
      accounts,
      now: () => Date.now() + (mode === 'expired' ? 60000 : 0),
      protocol: {
        async refresh() {
          calls++;
          if (mode === 'crash') process.exit(0); // Claim was already committed; never a GUI/Host process.
          if (mode === 'ambiguous') {
            const released = new Promise((yes) =>
              process.once('message', (message) => {
                assert.equal(message, 'release');
                yes();
              }),
            );
            process.send?.({ stage: 'claimed' });
            await released;
          }
          throw new SiwcError('AUTH_REQUEST_UNCONFIRMED', 502);
        },
      },
    });
    try {
      await manager.access(key);
    } catch (error) {
      code = safeCode(error);
    }
    const after = await accounts.registration(key, { fresh: true });
    process.send?.({
      stage: 'result',
      calls,
      code,
      state: after.renewal?.state,
      schema: after.schema,
      retained: after.refreshToken === 'synthetic-old-refresh',
    });
  } finally {
    await manager?.dispose();
    await ctx.fiber.dispose();
  }
}
function worker(asar, mode, directory, onStage) {
  const child = spawn(
    process.execPath,
    ['--expose-internals', fileURLToPath(import.meta.url), '--worker', mode, directory],
    {
      env: { ...process.env, DSH_ASAR: asar, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      shell: false,
    },
  );
  let result;
  const done = new Promise((yes, no) => {
    const timeout = setTimeout(() => {
      child.kill();
      no(Error('NATIVE_RENEWAL_FIXTURE_TIMEOUT'));
    }, 15000);
    child.on('message', (message) => {
      if (message.stage === 'result') result = message;
      onStage?.(message, child);
    });
    child.once('error', no);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      code === 0 ? yes(result) : no(Error('NATIVE_RENEWAL_FIXTURE_FAILED'));
    });
    child.stderr.resume();
  });
  return { child, done };
}
export async function verifyNativeRenewalSafety(asar) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const { ctx, accounts } = await environment(asar, directory);
  try {
    const seed = async () => {
      const key = await accounts.beginRegistration(CLIENT);
      await accounts.saveValidated({
        issuer: ISSUER,
        subject: 'native-renewal-fixture',
        clientId: CLIENT,
        accessToken: 'synthetic-old-access',
        refreshToken: 'synthetic-old-refresh',
        idToken: 'synthetic-id',
        scopes: [DIRECT_SCOPE],
        expiresAt: Date.now() - 1,
      });
      await accounts.select(key);
      return key;
    };
    await seed();
    let waiter, seen;
    const observed = new Promise((yes) => {
      seen = yes;
    });
    const first = worker(asar, 'ambiguous', directory, (message) => {
      if (message.stage === 'claimed') {
        waiter = worker(asar, 'waiter', directory, (next) => {
          if (next.stage === 'observed-pending') {
            seen();
            first.child.send('release');
          }
        });
      }
    });
    await Promise.race([
      observed,
      first.done.then(() => {
        throw Error('NO_PENDING_FENCE_OBSERVED');
      }),
    ]);
    const [a, b] = await Promise.all([first.done, waiter.done]);
    assert.equal(a.calls + b.calls, 1);
    assert.ok(
      [a, b].every((value) => value.state === 'uncertain' && value.retained && value.schema === 2),
    );
    const recreated = await worker(asar, 'blocked', directory).done;
    assert.equal(recreated.calls, 0);
    assert.equal(recreated.code, 'ACCOUNT_RENEWAL_UNCONFIRMED');
    await seed();
    await worker(asar, 'crash', directory).done;
    const expired = await worker(asar, 'expired', directory).done;
    assert.equal(expired.calls, 0);
    assert.equal(expired.code, 'ACCOUNT_RENEWAL_UNCONFIRMED');
    assert.equal(expired.retained, true);
    return {
      nativeUnconfirmedGenerationSingleSubmission: true,
      nativePendingObservedAcrossProcesses: true,
      nativeRecreationKeepsFence: true,
      nativeExitAfterClaimKeepsFence: true,
    };
  } finally {
    await ctx.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}
if (process.argv[2] === '--worker') {
  const mode = process.argv[3];
  if (!['ambiguous', 'waiter', 'blocked', 'crash', 'expired'].includes(mode))
    throw Error('UNKNOWN_FIXTURE_MODE');
  try {
    await child(process.env.DSH_ASAR, mode, process.argv[4]);
  } catch {
    process.exitCode = 1;
  }
}
