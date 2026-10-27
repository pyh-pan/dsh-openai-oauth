// Static regression guard, not a JS sandbox. Production must not import the
// developer/native-test runners. One narrowly declared OS read adapter may use
// execFile: its ONLY command is read-only `scutil --dns`, bounded, shell-free.
export function assertProductionImports(file, source) {
  if (/(?:from\s*|import\s*\(?\s*)['"][^'"]*scripts\//.test(source))
    throw Error(`Production code must not import test helpers: ${file}`);
  const processes = [...source.matchAll(/['"](?:node:)?child_process['"]/g)];
  if (!processes.length) return;
  if (
    file !== 'src/siwc/network-policy.js' ||
    processes.length !== 1 ||
    !/^import \{ execFile \} from 'node:child_process';$/m.test(source)
  )
    throw Error(`Production process import not allowed: ${file}`);
  if (
    (source.match(/\brun\s*\(/g) ?? []).length !== 1 ||
    !source.includes("run('/usr/sbin/scutil', ['--dns'], {") ||
    !/timeout:\s*800\b/.test(source) ||
    !/maxBuffer:\s*262144\b/.test(source) ||
    !/shell:\s*false\b/.test(source) ||
    /(?<!\.)\b(?:execFile|exec|spawn|fork|execute)\s*\(/.test(source)
  )
    throw Error('Native DNS read adapter command contract changed');
}
