import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertProductionImports } from '../scripts/source-import-contract.mjs';
const file = 'src/siwc/network-policy.js';
test('production permits only the pinned shell-free OS DNS read adapter, never native test runners or arbitrary process helpers', async () => {
  const source = await readFile(new URL('../src/siwc/network-policy.js', import.meta.url), 'utf8');
  assert.doesNotThrow(() => assertProductionImports(file, source));
  for (const [path, value] of [
    ['src/another.js', source],
    [file, source.replace("['--dns']", "['--set','unrelated']")],
    [file, source.replace('shell: false', 'shell: true')],
    [file, source.replace('timeout: 800', 'timeout: 8000')],
    [file, source + '\nrun(command,args);'],
    [file, source + "\nimport '../scripts/native.mjs';"],
    [file, source.replace('{ execFile }', '{ execFile, spawn }')],
  ])
    assert.throws(() => assertProductionImports(path, value));
});
