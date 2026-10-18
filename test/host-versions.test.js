import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {
  SUPPORTED_DSH_VERSIONS,
  DSH_COMPATIBILITY_RANGE,
  readHostInfo,
  inspectHost,
  invokeCli,
} from '../scripts/host.mjs';
import { HOST_VERSION_FIELDS, assessHost } from '../src/compatibility.js';
const host = {
  platform: 'win32',
  executable: 'D:\\Apps\\Harness.exe',
  asar: 'D:\\Apps\\resources\\app.asar',
};
const metadata = (version) => ({
  platform: 'win32',
  desktopVersion: version,
  ...Object.fromEntries(HOST_VERSION_FIELDS.map((field) => [field, version])),
  contractIssues: [],
  cliAvailable: true,
});
const spawn = (info) => () => ({ status: 0, stdout: JSON.stringify(info) });
test('validated tuples and same-minor candidates are eligible, not mixed or outside-family tuples', () => {
  for (const version of SUPPORTED_DSH_VERSIONS) {
    assert.equal(inspectHost(host, { spawn: spawn(metadata(version)) }).desktopVersion, version);
    assert.equal(assessHost(metadata(version)).status, 'validated');
  }
  for (const version of ['0.2.1-rc.3', '0.2.1', '0.2.2-alpha.1', '0.2.2-rc.1', '0.2.20']) {
    assert.equal(inspectHost(host, { spawn: spawn(metadata(version)) }).desktopVersion, version);
    assert.equal(assessHost(metadata(version)).status, 'candidate');
  }
  for (const version of ['9.0.0', '0.3.0-0', '0.3.0-rc.1', '0.2.0-rc.3'])
    assert.throws(
      () => inspectHost(host, { spawn: spawn(metadata(version)) }),
      /UNSUPPORTED_DSH_VERSION/,
    );
  for (const version of ['0.2.1-rc.2', '0.2.9'])
    for (const component of HOST_VERSION_FIELDS)
      assert.throws(
        () =>
          inspectHost(host, {
            spawn: spawn({ ...metadata(version), [component]: '0.2.0-rc.2' }),
          }),
        /DSH_COMPONENT_VERSION_MISMATCH/,
      );
});
test('manifest, lockfile and helper share the bounded range and validated evidence', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const range = DSH_COMPATIBILITY_RANGE;
  assert.deepEqual(SUPPORTED_DSH_VERSIONS, ['0.2.0-rc.2', '0.2.1-rc.1', '0.2.1-rc.2']);
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-llm'], range);
  assert.equal(pkg.engines.dsh, undefined, 'do not override peer compatibility policy');
  const lockUrl = new URL('../package-lock.json', import.meta.url);
  // npm archives intentionally omit package-lock.json.
  if (existsSync(lockUrl)) {
    const lock = JSON.parse(readFileSync(lockUrl, 'utf8'));
    assert.equal(lock.packages[''].peerDependencies['@deepseek-ai/dsh-llm'], range);
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[''].version, pkg.version);
  }
});
test('read-only diagnostics show actual unsupported versions without allowing CLI operations', () => {
  const info = metadata('9.0.0');
  assert.deepEqual(readHostInfo(host, { spawn: spawn(info) }), info);
  assert.throws(() => inspectHost(host, { spawn: spawn(info) }), /UNSUPPORTED_DSH_VERSION/);
});
test('a candidate must pass all isolated native suites before the requested CLI command', () => {
  const calls = [];
  invokeCli(host, ['plugin', '--profile', 'desktop', 'add', '-w', '.'], {
    spawn(file, argv, options) {
      calls.push({ file, argv, options });
      return calls.length === 1
        ? { status: 0, stdout: JSON.stringify(metadata('0.2.2')) }
        : { status: 0 };
    },
  });
  assert.equal(calls.length, 6);
  assert.match(calls[1].argv[1], /native-siwc\.mjs$/);
  assert.match(calls[2].argv[1], /native-session-race\.mjs$/);
  assert.match(calls[3].argv[1], /native-preset-integration\.mjs$/);
  assert.match(calls[4].argv[1], /native-provider-bootstrap\.mjs$/);
  assert.deepEqual(calls[5].argv.slice(2), ['plugin', '--profile', 'desktop', 'add', '-w', '.']);
  for (const call of calls) {
    assert.equal(call.file, host.executable);
    assert.equal(call.options.shell, false);
  }
});
test('failed candidate behavior checks never invoke the real profile command', () => {
  for (const failedCall of [2, 3, 4, 5]) {
    let calls = 0;
    assert.throws(
      () =>
        invokeCli(host, ['plugin', 'add', '.'], {
          spawn() {
            calls++;
            return calls === 1
              ? { status: 0, stdout: JSON.stringify(metadata('0.2.2')) }
              : { status: calls === failedCall ? 1 : 0 };
          },
        }),
      /DSH_CANDIDATE_NATIVE_CHECK_FAILED/,
    );
    assert.equal(calls, failedCall);
  }
});
test('native removal remains available on candidates but a package named remove cannot bypass preflight', () => {
  for (const args of [
    ['plugin', '--profile', 'desktop', 'remove', '@pyh-pan/dsh-openai-oauth'],
    ['plugin', '--profile=desktop', 'remove', '@pyh-pan/dsh-openai-oauth'],
  ]) {
    let calls = 0;
    invokeCli(host, args, {
      spawn() {
        calls++;
        return calls === 1
          ? { status: 0, stdout: JSON.stringify(metadata('0.2.2')) }
          : { status: 0 };
      },
    });
    assert.equal(calls, 2);
  }
  let calls = 0;
  assert.throws(
    () =>
      invokeCli(host, ['plugin', 'add', 'remove'], {
        spawn() {
          calls++;
          return calls === 1
            ? { status: 0, stdout: JSON.stringify(metadata('0.2.2')) }
            : { status: 1 };
        },
      }),
    /DSH_CANDIDATE_NATIVE_CHECK_FAILED/,
  );
  assert.equal(calls, 2);
});

test('missing service contracts stop validated and candidate versions before preflight or installation', () => {
  for (const version of ['0.2.1-rc.2', '0.2.2']) {
    let calls = 0;
    assert.throws(
      () =>
        invokeCli(host, ['plugin', 'add', '.'], {
          spawn() {
            calls++;
            return {
              status: 0,
              stdout: JSON.stringify({
                ...metadata(version),
                contractIssues: ['credentials.modifyRecord'],
              }),
            };
          },
        }),
      /DSH_HOST_CONTRACT_MISSING/,
    );
    assert.equal(calls, 1);
  }
});
