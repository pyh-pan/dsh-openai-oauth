// Runs only inside the installed Electron's Node mode. Reads application
// metadata and inert service exports, never profiles, grants or credential files.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  classifyDshVersion,
  nativeContractIssues,
  HOST_VERSION_FIELDS,
} from '../src/compatibility.js';
const asar = process.env.DSH_ASAR;
if (!asar) throw Error('DSH_ASAR_REQUIRED');
const version = (path) => JSON.parse(readFileSync(path, 'utf8')).version;
const pkg = (name) => join(asar, 'dsh', 'node_modules', '@deepseek-ai', name);
const pkgVersion = (name) => version(join(pkg(name), 'package.json'));
const info = {
  platform: process.platform,
  arch: process.arch,
  node: process.versions.node,
  electron: process.versions.electron,
  desktopVersion: version(join(asar, 'package.json')),
  llmVersion: pkgVersion('dsh-llm'),
  credentialsVersion: pkgVersion('dsh-credentials-local'),
  connectionVersion: pkgVersion('dsh-client-connection'),
  bootVersion: pkgVersion('dsh-app-boot'),
  settingsModelsVersion: pkgVersion('dsh-client-ui-settings-models'),
  modelSelectionVersion: pkgVersion('dsh-client-ui-model-selection'),
  cliAvailable: existsSync(join(pkg('dsh-desktop-host'), 'lib', 'cli.js')),
  contractIssues: [],
};
const status = classifyDshVersion(info.desktopVersion);
// Do not import services from an ineligible or mixed installation.
if (
  status !== 'unsupported' &&
  HOST_VERSION_FIELDS.every((field) => info[field] === info.desktopVersion)
) {
  try {
    const load = (name) => import(pathToFileURL(join(pkg(name), 'lib', 'index.js')).href);
    const [native, credentials, connection, boot] = await Promise.all([
      load('dsh-llm'),
      load('dsh-credentials-local'),
      load('dsh-client-connection'),
      load('dsh-app-boot'),
    ]);
    info.contractIssues.push(...nativeContractIssues(native));
    for (const method of ['readRecord', 'listRecords', 'modifyRecord'])
      if (typeof credentials.default?.prototype?.[method] !== 'function')
        info.contractIssues.push(`credentials.${method}`);
    if (typeof native.default?.prototype?.registerAdapter !== 'function')
      info.contractIssues.push('llm.registerAdapter');
    if (status === 'candidate' || info.desktopVersion === '0.2.1-rc.2') {
      if (
        typeof connection.HostConnectionService?.prototype?.createSharedFetchHandler !== 'function'
      )
        info.contractIssues.push('connection.createSharedFetchHandler');
      for (const method of [
        'evaluatePluginCompatibility',
        'loadProfileDirectory',
        'composeEntries',
      ])
        if (typeof boot[method] !== 'function') info.contractIssues.push(`boot.${method}`);
    }
    if (native.APP_IDENTITY?.version !== info.desktopVersion)
      info.contractIssues.push('llm.APP_IDENTITY.version');
  } catch {
    // Imported-module exceptions can contain paths/config. Report only a safe code.
    info.contractIssues.push('installed-service-import');
  }
}
console.log(JSON.stringify(info));
