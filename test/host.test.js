import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findDesktop,
  inspectHost,
  invokeCli,
  hostEnvironment,
  SUPPORTED_DSH,
} from '../scripts/host.mjs';
import { HOST_VERSION_FIELDS } from '../src/compatibility.js';

const executable = 'D:\\Apps\\DeepSeek Harness\\DeepSeek Harness.exe';
const asar = 'D:\\Apps\\DeepSeek Harness\\resources\\app.asar';
const exists = (path) => [executable, asar].includes(path);
const host = findDesktop({ platform: 'win32', env: { DSH_APP: executable }, exists });
const info = {
  platform: 'win32',
  arch: 'x64',
  desktopVersion: SUPPORTED_DSH,
  ...Object.fromEntries(HOST_VERSION_FIELDS.map((field) => [field, SUPPORTED_DSH])),
  contractIssues: [],
  cliAvailable: true,
};

test('explicit Windows installation preserves spaces without shell interpolation', () => {
  assert.equal(host.executable, executable);
  assert.equal(host.asar, asar);
  const calls = [];
  const args = ['plugin', '--profile', 'desktop', 'add', 'a path with spaces'];
  assert.equal(
    invokeCli(host, args, {
      spawn: (file, argv, options) => {
        calls.push({ file, argv, options });
        return calls.length === 1 ? { status: 0, stdout: JSON.stringify(info) } : { status: 0 };
      },
    }),
    0,
  );
  assert.equal(calls[1].options.shell, false);
  assert.deepEqual(calls[1].argv.slice(2), args);
  assert.equal(calls[1].options.env.ELECTRON_RUN_AS_NODE, '1');
});
test('Windows per-user standard location is derived, not hardcoded', () => {
  const exe = 'D:\\Local Apps\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe';
  const archive = 'D:\\Local Apps\\Programs\\DeepSeek Harness\\resources\\app.asar';
  const found = findDesktop({
    platform: 'win32',
    env: { LOCALAPPDATA: 'D:\\Local Apps' },
    exists: (p) => [exe, archive].includes(p),
  });
  assert.equal(found.executable, exe);
  assert.equal(found.customLocation, false);
});
test('macOS system .app resolves its own executable metadata and Resources', () => {
  const app = '/Applications/DeepSeek Harness.app';
  const exe = app + '/Contents/MacOS/Custom Harness';
  const archive = app + '/Contents/Resources/app.asar';
  const found = findDesktop({
    platform: 'darwin',
    env: {},
    home: '/var/empty',
    exists: (p) => [exe, archive].includes(p),
    bundleExecutable: () => 'Custom Harness',
  });
  assert.equal(found.executable, exe);
  assert.equal(found.asar, archive);
});
test('macOS user .app and explicit executable paths both work', () => {
  const app = '/home/example/Applications/DeepSeek Harness.app';
  const exe = app + '/Contents/MacOS/DeepSeek Harness';
  const archive = app + '/Contents/Resources/app.asar';
  const options = {
    platform: 'darwin',
    home: '/home/example',
    exists: (p) => [exe, archive].includes(p),
  };
  assert.equal(findDesktop({ ...options, env: {} }).executable, exe);
  assert.equal(findDesktop({ ...options, env: { DSH_APP: exe } }).asar, archive);
});
test('unsupported systems, unsafe bundle names and relative overrides fail closed', () => {
  assert.throws(() => findDesktop({ platform: 'linux', env: {} }), /UNSUPPORTED_DESKTOP_PLATFORM/);
  assert.throws(
    () => findDesktop({ platform: 'darwin', env: { DSH_APP: 'relative.app' } }),
    /MUST_BE_ABSOLUTE/,
  );
  assert.throws(
    () =>
      findDesktop({
        platform: 'darwin',
        env: {},
        bundleExecutable: () => '../escape',
        exists: () => true,
      }),
    /UNSAFE_BUNDLE_EXECUTABLE/,
  );
  assert.throws(
    () => findDesktop({ platform: 'win32', env: { DSH_APP: executable }, exists: () => false }),
    /DESKTOP_NOT_FOUND/,
  );
});
test('incompatible Host metadata is rejected before any installation command', () => {
  let calls = 0;
  assert.throws(
    () =>
      invokeCli(host, ['plugin', 'add', 'example'], {
        spawn: () => {
          calls++;
          return { status: 0, stdout: JSON.stringify({ ...info, llmVersion: '0.1.0' }) };
        },
      }),
    /DSH_COMPONENT_VERSION_MISMATCH/,
  );
  assert.equal(calls, 1);
  assert.throws(
    () => inspectHost(host, { spawn: () => ({ status: 0, stdout: 'not JSON' }) }),
    /INSPECTION_INVALID/,
  );
});
test('helpers strip inherited debugging options, without enumerating secrets', () => {
  const result = hostEnvironment(host, {
    NODE_OPTIONS: '--inspect',
    ELECTRON_ENABLE_LOGGING: '1',
    PATH: 'example',
    DSH_RACE_WORKER: '1',
    DSH_RACE_DIR: 'unrelated-fixture-directory',
  });
  assert.equal(result.NODE_OPTIONS, undefined);
  assert.equal(result.ELECTRON_ENABLE_LOGGING, undefined);
  assert.equal(result.DSH_RACE_WORKER, undefined);
  assert.equal(result.DSH_RACE_DIR, undefined);
  assert.equal(result.PATH, 'example');
});
