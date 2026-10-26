// Installed Electron Node mode: public metadata and inert exports only.
// No profile, credentials, account runtime or network is opened.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { classifyDshVersion, nativeContractIssues } from '../src/compatibility.js';
const asar = process.env.DSH_ASAR;
if (!asar) throw Error('DSH_ASAR_REQUIRED');
const req = createRequire(pathToFileURL(join(asar, 'dsh/package.json')));
const version = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')).version;
  } catch {
    return undefined;
  }
};
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
  compactionVersion: pkgVersion('dsh-compaction-basic'),
  presetVersion: pkgVersion('dsh-agent-preset'),
  presetRegistryVersion: pkgVersion('dsh-agent-preset-registry'),
  settingsModelsVersion: pkgVersion('dsh-client-ui-settings-models'),
  modelSelectionVersion: pkgVersion('dsh-client-ui-model-selection'),
  cliAvailable: existsSync(join(pkg('dsh-desktop-host'), 'lib', 'cli.js')),
  contractIssues: [],
  sessionContractIssues: [],
};
const load = (name) => import(pathToFileURL(req.resolve('@deepseek-ai/' + name)).href);
if (classifyDshVersion(info.desktopVersion) !== 'unsupported') {
  try {
    const [native, credentials, connection] = await Promise.all([
      load('dsh-llm'),
      load('dsh-credentials-local'),
      load('dsh-client-connection'),
    ]);
    info.contractIssues.push(...nativeContractIssues(native));
    for (const method of ['readRecord', 'listRecords', 'modifyRecord'])
      if (typeof credentials.default?.prototype?.[method] !== 'function')
        info.contractIssues.push(`credentials.${method}`);
    if (typeof native.default?.prototype?.registerAdapter !== 'function')
      info.contractIssues.push('llm.registerAdapter');
    if (typeof connection.HostConnectionService?.prototype?.createSharedFetchHandler !== 'function')
      info.contractIssues.push('connection.createSharedFetchHandler');
  } catch {
    info.contractIssues.push('installed-service-import');
  }
  try {
    const [{ BasicCompactionEngine }, registry, preset] = await Promise.all([
      load('dsh-compaction-basic'),
      load('dsh-agent-preset-registry'),
      load('dsh-agent-preset'),
    ]);
    for (const method of ['summarize', 'compactIfNeeded', 'compactNow'])
      if (typeof BasicCompactionEngine?.prototype?.[method] !== 'function')
        info.sessionContractIssues.push(`compaction.${method}`);
    const face = registry.default?.prototype;
    for (const method of ['composedPreset', 'serviceFor'])
      if (typeof face?.[method] !== 'function')
        info.sessionContractIssues.push(`agentPresets.${method}`);
    if (
      typeof face?.inspectCompositions !== 'function' &&
      ['standingMountFor', 'livePresetMounts', 'leakedServices'].some(
        (name) => typeof registry[name] !== 'function',
      )
    )
      info.sessionContractIssues.push('agentPresets.retained-composition');
    if (typeof preset.default !== 'function')
      info.sessionContractIssues.push('agentPresets.definition');
  } catch {
    info.sessionContractIssues.push('installed-session-service-import');
  }
}
console.log(JSON.stringify(info));
