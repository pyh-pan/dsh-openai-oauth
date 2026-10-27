import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultDnsRoute, createDnsPolicy } from '../src/siwc/network-policy.js';
const base = `DNS configuration
resolver #1
  nameserver[0] : 192.0.2.53
  flags : Supplemental, Request A records
  order : 100000
resolver #2
  nameserver[0] : 192.0.2.54
  if_index : 4 (en0)
  flags : Request A records, Request AAAA records
  order : 200000
DNS configuration (for scoped queries)
resolver #1
  nameserver[0] : 192.0.2.54
  flags : Scoped, Request A records
`;
test('only the existing highest-priority unbound default DNS policy is used', () => {
  assert.deepEqual(defaultDnsRoute(base, 'auth.openai.com'), {
    servers: ['192.0.2.53'],
    families: [4],
  });
  assert.equal(
    defaultDnsRoute(base.replace('order : 100000', 'order : 300000'), 'auth.openai.com'),
    undefined,
  );
});
test('domain-specific, scoped, custom-protocol and ambiguous DNS policies remain native', () => {
  for (const domain of ['openai.com', 'auth.openai.com', '.'])
    assert.equal(
      defaultDnsRoute(
        base.replace(
          '  nameserver[0] : 192.0.2.53',
          `  domain : ${domain}\n  nameserver[0] : 192.0.2.53`,
        ),
        'auth.openai.com',
      ),
      undefined,
    );
  for (const value of [
    base.replace('  order : 100000', '  order : 200000'),
    base.replace('  order : 100000', ''),
    base.replace('  order : 100000', '  port : 5353\n  order : 100000'),
    base.replace('  order : 100000', '  options : usevc\n  order : 100000'),
    'unknown configuration',
  ])
    assert.equal(defaultDnsRoute(value, 'auth.openai.com'), undefined);
});
test('an unrelated split DNS domain does not replace the official-host default policy', () => {
  const text = base.replace(
    'DNS configuration (for scoped queries)',
    `resolver #3\n  domain : internal.invalid\n  nameserver[0] : 192.0.2.55\n  flags : Supplemental, Request A records\nDNS configuration (for scoped queries)`,
  );
  assert.deepEqual(defaultDnsRoute(text, 'auth.openai.com'), {
    servers: ['192.0.2.53'],
    families: [4],
  });
});
test('read-only OS policy projection is shared and bounded; Windows/unknown policy never gets an inferred override', async () => {
  let calls = 0;
  const run = async (binary, args, options) => {
    calls++;
    assert.equal(binary, '/usr/sbin/scutil');
    assert.deepEqual(args, ['--dns']);
    assert.equal(options.timeout, 800);
    return { stdout: base };
  };
  const policy = createDnsPolicy({ platform: 'darwin', run });
  const [auth, api] = await Promise.all([policy('auth.openai.com'), policy('api.openai.com')]);
  assert.equal(calls, 1);
  assert.deepEqual(auth, api);
  assert.equal(await createDnsPolicy({ platform: 'win32', run })('auth.openai.com'), undefined);
  assert.equal(calls, 1);
  const broken = createDnsPolicy({
    platform: 'darwin',
    run: async () => {
      throw Error('private configuration unavailable');
    },
  });
  assert.equal(await broken('auth.openai.com'), undefined);
});
