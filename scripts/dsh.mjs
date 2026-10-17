import { findDesktop, invokeCli } from './host.mjs';
try {
  const args = process.argv.slice(2);
  if (!args.length) throw Error('Pass native CLI arguments; see docs/install.md');
  process.exitCode = invokeCli(findDesktop(), args);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
