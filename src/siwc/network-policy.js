import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
const execute = promisify(execFile);

// Only use configured-server DNS where its default policy can be established.
// Domain-specific/interface-bound/unknown policy remains with native Host.
// An unbound default (including supplemental defaults) keeps its native priority.
// No Windows NRPT equivalence is assumed; Windows keeps native Host networking.
export function defaultDnsRoute(text, hostname) {
  if (typeof text !== 'string' || text.length > 262144) return;
  const first = text.split(/^DNS configuration \(/m)[0];
  const resolvers = first
    .split(/^resolver #\d+\s*$/m)
    .slice(1)
    .map((block) => {
      const domain = /^\s*domain\s*:\s*(\S+)\s*$/m
        .exec(block)?.[1]
        ?.toLowerCase()
        .replace(/\.$/, '');
      const servers = [...block.matchAll(/^\s*nameserver\[\d+\]\s*:\s*(\S+)\s*$/gm)].map(
        (match) => match[1],
      );
      const orderText = /^\s*order\s*:\s*(\d+)\s*$/m.exec(block)?.[1];
      const flags = /^\s*flags\s*:\s*(.+)$/m.exec(block)?.[1] ?? '';
      const families = [
        ...(flags.includes('Request A records') ? [4] : []),
        ...(flags.includes('Request AAAA records') ? [6] : []),
      ];
      return {
        domain,
        servers,
        order: orderText === undefined ? undefined : Number(orderText),
        unsupported: /if_index|^\s*(?:options|port)\s*:/m.test(block),
        families,
      };
    });
  if (
    !resolvers.length ||
    resolvers.some(
      ({ domain }) =>
        domain !== undefined &&
        (domain === '' || hostname === domain || hostname.endsWith('.' + domain)),
    )
  )
    return;
  const defaults = resolvers.filter(
    ({ domain, servers }) => domain === undefined && servers.length,
  );
  if (
    !defaults.length ||
    (defaults.length > 1 && defaults.some((item) => !Number.isSafeInteger(item.order)))
  )
    return;
  const order =
    defaults.length === 1 ? defaults[0].order : Math.min(...defaults.map((item) => item.order));
  const chosen = defaults.filter((item) => item.order === order);
  if (chosen.some((item) => item.unsupported || !item.families.length)) return;
  const unique = new Map(
    chosen.map((item) => [JSON.stringify([item.servers, item.families]), item]),
  );
  if (unique.size !== 1) return;
  const { servers, families } = [...unique.values()][0];
  if (servers.length > 8 || servers.some((server) => !isIP(server) || server.includes('%'))) return;
  return { servers, families };
}
export function createDnsPolicy({
  platform = process.platform,
  run = execute,
  now = Date.now,
} = {}) {
  let pending,
    expiresAt = 0;
  return async (hostname) => {
    if (platform !== 'darwin') return;
    if (!pending || expiresAt <= now()) {
      expiresAt = now() + 5000;
      pending = run('/usr/sbin/scutil', ['--dns'], {
        timeout: 800,
        shell: false,
        maxBuffer: 262144,
        encoding: 'utf8',
      }).then(
        ({ stdout }) =>
          new Map(
            ['auth.openai.com', 'api.openai.com'].map((host) => [
              host,
              defaultDnsRoute(stdout, host),
            ]),
          ),
        () => undefined,
      );
    }
    return (await pending)?.get(hostname);
  };
}
