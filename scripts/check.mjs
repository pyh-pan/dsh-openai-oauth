import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DSH_COMPATIBILITY_RANGE } from './host.mjs';
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
if (pkg.peerDependencies?.['@deepseek-ai/dsh-llm'] !== DSH_COMPATIBILITY_RANGE)
  throw Error('Keep the Host peer constraint synchronized with the shared compatibility policy');
for (const file of ['README.md', 'README.zh.md', 'docs/forward-compatibility.md'])
  if (!readFileSync(join(root, file), 'utf8').includes(DSH_COMPATIBILITY_RANGE))
    throw Error(`Documented compatibility range differs from shared policy: ${file}`);
console.log(`Syntax checked: ${files.length} JavaScript modules`);
