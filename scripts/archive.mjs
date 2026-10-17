import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const npm = process.env.npm_execpath;
if (!npm) throw Error('Run via npm run pack');
const destination = join(root, 'artifacts');
mkdirSync(destination, { recursive: true });
const result = spawnSync(
  process.execPath,
  [npm, 'pack', '--ignore-scripts', '--pack-destination', destination],
  { cwd: root, stdio: 'inherit', shell: false },
);
process.exitCode = result.status ?? 1;
