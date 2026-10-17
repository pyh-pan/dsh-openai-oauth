import test from 'node:test';
import assert from 'node:assert/strict';
import { SUPPORTED_DSH_VERSIONS, readHostInfo, inspectHost } from '../scripts/host.mjs';
const host = {
  platform: 'win32',
  executable: 'D:\\Apps\\Harness.exe',
  asar: 'D:\\Apps\\resources\\app.asar',
};
const metadata = (version) => ({
  platform: 'win32',
  desktopVersion: version,
  llmVersion: version,
  credentialsVersion: version,
  connectionVersion: version,
  cliAvailable: true,
});
const spawn = (info) => () => ({ status: 0, stdout: JSON.stringify(info) });
test('each validated release tuple is supported, mixed or unknown tuples are not', () => {
  for (const version of SUPPORTED_DSH_VERSIONS)
    assert.equal(inspectHost(host, { spawn: spawn(metadata(version)) }).desktopVersion, version);
  for (const info of [
    metadata('9.0.0'),
    { ...metadata('0.2.1-rc.1'), credentialsVersion: '0.2.0-rc.2' },
  ])
    assert.throws(() => inspectHost(host, { spawn: spawn(info) }), /UNSUPPORTED_DSH_VERSION/);
});
test('read-only diagnostics show actual unsupported versions without allowing CLI operations', () => {
  const info = metadata('9.0.0');
  assert.deepEqual(readHostInfo(host, { spawn: spawn(info) }), info);
  assert.throws(() => inspectHost(host, { spawn: spawn(info) }), /UNSUPPORTED_DSH_VERSION/);
});
