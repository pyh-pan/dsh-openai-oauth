import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const roots = ['src', 'scripts', 'test', 'docs', '.github'];
const paths = [];
function walk(dir) {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw Error('Symlinks are not accepted in public source');
    if (entry.isDirectory()) walk(path);
    else paths.push(path);
  }
}
for (const dir of roots) if (existsSync(join(root, dir))) walk(dir);
for (const entry of readdirSync(root, { withFileTypes: true }))
  if (
    (entry.isFile() && /\.(md|json|yml)$/.test(entry.name)) ||
    (entry.isFile() && ['LICENSE', '.gitignore'].includes(entry.name))
  )
    paths.push(entry.name);
const checks = [
  ['private key', new RegExp(['-----BEGIN', '(?:RSA |EC |OPENSSH )?PRIVATE KEY-----'].join(' '))],
  ['literal JWT', /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],
  ['API key', /\bsk-[A-Za-z0-9_-]{24,}/],
  ['personal Windows home', /[A-Z]:[\\/]Users[\\/][A-Za-z0-9_.-]+[\\/]/i],
  ['personal macOS home', /\/Users\/[A-Za-z0-9_.-]+\//],
  [
    'unreviewed developer workspace',
    new RegExp(['default', 'workspace'].join('-') + '|' + ['research', 'runtime'].join('/')),
  ],
];
for (const path of paths) {
  const text = readFileSync(join(root, path), 'utf8');
  for (const [label, pattern] of checks)
    if (pattern.test(text))
      throw Error(
        `Public-source audit: ${label} in ${path}; matched data intentionally not printed`,
      );
}
console.log(
  JSON.stringify({
    publicSourceFilesChecked: paths.length,
    obviousSecretAndPrivatePathScanPassed: true,
    manualReviewStillRequired: true,
  }),
);
