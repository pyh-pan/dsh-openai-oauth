// Runs only inside the installed Electron's Node mode. Reads application
// version metadata, never profiles, credentials, account claims or environment dumps.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const asar = process.env.DSH_ASAR;
if (!asar) throw Error('DSH_ASAR_REQUIRED');
const version = (path) => JSON.parse(readFileSync(path, 'utf8')).version;
const pkg = (name) => join(asar, 'dsh', 'node_modules', '@deepseek-ai', name, 'package.json');
console.log(
  JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    electron: process.versions.electron,
    desktopVersion: version(join(asar, 'package.json')),
    llmVersion: version(pkg('dsh-llm')),
    credentialsVersion: version(pkg('dsh-credentials-local')),
    connectionVersion: version(pkg('dsh-client-connection')),
    cliAvailable: existsSync(
      join(asar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
    ),
  }),
);
