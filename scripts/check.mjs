import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const files = [];
function walk(dir) {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const name = join(dir, entry.name);
    if (entry.isDirectory()) walk(name);
    else if (/\.(js|mjs)$/.test(name)) files.push(name);
  }
}
for (const dir of ['src', 'test', 'scripts']) walk(dir);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', join(root, file)], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(result.stderr);
    process.exit(result.status ?? 1);
  }
}
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (pkg.peerDependencies?.['@deepseek-ai/dsh-llm'] !== '0.2.0-rc.2')
  throw Error('Revalidate the supported Host version before changing its peer constraint');
console.log(`Syntax checked: ${files.length} JavaScript modules`);
