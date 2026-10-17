import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const npm = process.env.npm_execpath;
if (!npm) throw Error('Run via npm run test:package');
function run(command, args, cwd = root, options = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', ...options });
  if (result.status !== 0)
    throw Error(result.stderr || result.stdout || 'Package verification failed');
  return result.stdout;
}
const temp = mkdtempSync(join(tmpdir(), 'dsh-oauth-package-'));
try {
  const [pack] = JSON.parse(
    run(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', temp]),
  );
  const forbidden = pack.files.filter((f) =>
    /(^|\/)(research|node_modules|\.git|\.pi|\.dsh|coverage|artifacts)(\/|$)|credentials.*\.ya?ml$|(^|\/)\.env($|\.)|desktop-probe|(^|\/)core\.js$/.test(
      f.path,
    ),
  );
  if (forbidden.length) throw Error('Unexpected private/development content in package');
  if (
    !pack.files.some((f) => f.path === 'src/index.js') ||
    !pack.files.some((f) => f.path === 'LICENSE') ||
    !pack.files.some((f) => f.path === 'test/siwc-auth.test.js')
  )
    throw Error('Missing required package files');
  const unpack = join(temp, 'unpack');
  mkdirSync(unpack);
  run('tar', ['-xzf', '-'], unpack, { input: readFileSync(join(temp, pack.filename)) });
  const cwd = join(unpack, 'package');
  const output = run(process.execPath, [npm, 'test', '--ignore-scripts=false'], cwd);
  process.stdout.write(output);
  process.stdout.write(run(process.execPath, [npm, 'run', 'check'], cwd));
  console.log(
    JSON.stringify({
      package: pack.filename,
      files: pack.files.length,
      independentPackageTestsPassed: true,
      noPrivateDevelopmentFiles: true,
    }),
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
