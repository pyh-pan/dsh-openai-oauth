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
  ...(version === undefined
    ? {}
    : {
        desktopVersion: version,
        ...Object.fromEntries(HOST_VERSION_FIELDS.map((field) => [field, version])),
      }),
  contractIssues: [],
  cliAvailable: true,
});
const spawn = (info) => () => ({ status: 0, stdout: JSON.stringify(info) });

test('known baselines and future versions share admission; version differences are diagnostic only', () => {
  for (const version of [
    ...SUPPORTED_DSH_VERSIONS,
    '0.2.0-rc.3',
    '0.2.1-rc.3',
    '0.3.0-rc.1',
    '1.0.0',
    'nightly',
    undefined,
  ]) {
    const info = metadata(version);
    assert.deepEqual(inspectHost(host, { spawn: spawn(info) }), info);
    for (const field of HOST_VERSION_FIELDS)
      assert.doesNotThrow(() =>
        inspectHost(host, { spawn: spawn({ ...info, [field]: '0.2.0-rc.2' }) }),
      );
  }
  for (const version of ['0.1.9', '0.2.0-rc.1'])
    assert.throws(
      () => inspectHost(host, { spawn: spawn(metadata(version)) }),
      /UNSUPPORTED_DSH_VERSION/,
    );
});

test('manifest, lockfile and helper share a minimum-only DSH policy, without engine exemptions', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(DSH_COMPATIBILITY_RANGE, '>=0.2.0-rc.2');
  assert.equal(pkg.engines.dsh, undefined);
  for (const [name, range] of Object.entries(pkg.peerDependencies))
    if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(range, DSH_COMPATIBILITY_RANGE, name);
  const lockUrl = new URL('../package-lock.json', import.meta.url);
  if (existsSync(lockUrl)) {
    const lock = JSON.parse(readFileSync(lockUrl, 'utf8'));
    assert.deepEqual(lock.packages[''].peerDependencies, pkg.peerDependencies);
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[''].version, pkg.version);
  }
});

test('diagnostics can describe a below-floor runtime without permitting installation', () => {
  const info = metadata('0.2.0-rc.1');
  assert.deepEqual(readHostInfo(host, { spawn: spawn(info) }), info);
  assert.throws(() => inspectHost(host, { spawn: spawn(info) }), /UNSUPPORTED_DSH_VERSION/);
});

test('install/update/removal do not launch test suites, regardless of release label or argument names', () => {
  for (const version of ['0.2.1-rc.2', '0.2.1-rc.3', '0.3.0-rc.1', '1.0.0', undefined])
    for (const args of [
      ['plugin', '--profile', 'desktop', 'add', '-w', '.'],
      ['plugin', 'update'],
      ['plugin', 'remove', 'source'],
      ['plugin', 'add', 'remove'],
    ]) {
      const calls = [];
      assert.equal(
        invokeCli(host, args, {
          spawn(file, argv, options) {
            calls.push({ file, argv, options });
            return calls.length === 1
              ? { status: 0, stdout: JSON.stringify(metadata(version)) }
              : { status: 0 };
          },
        }),
        0,
      );
      assert.equal(calls.length, 2);
      assert.match(calls[0].argv[1], /host-info\.mjs$/);
      assert.deepEqual(calls[1].argv.slice(2), args);
      for (const call of calls) {
        assert.equal(call.file, host.executable);
        assert.equal(call.options.shell, false);
      }
    }
});

test('missing core contracts stop installation, while optional session diagnostics do not hide account capabilities', () => {
  for (const version of ['0.2.1-rc.2', '0.3.0']) {
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
    assert.equal(
      assessHost({
        ...metadata(version),
        sessionContractIssues: ['agentPresets.retained-composition'],
      }).reason,
      null,
    );
  }
});
