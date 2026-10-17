# Safe installation runbook

This is the independent SIWC project at https://github.com/pyh-pan/dsh-openai-oauth, not the older similarly named Codex plugin.

1. Confirm a local Windows/macOS Desktop installation; do not silently default to web/headless. Validated releases are **0.2.1-rc.2, 0.2.1-rc.1 and 0.2.0-rc.2**. Same-minor candidates follow docs/forward-compatibility.md: mandatory structural and isolated native checks, not an automatic validation claim.
2. Read README and docs/install.md. Use Node 24+, `npm ci`, `npm test`, `npm run check`, `npm run test:package`, then `npm run doctor`.
3. Inspect existing bundles without printing full config or credentials. If an older private bundle already owns this source, follow docs/migration.md; never activate both owners concurrently.
4. Install through the native plugin manager/CLI: `npm run dsh -- plugin --profile desktop add -w .`. Do not manually rewrite profile package/lock/patch files or modify ASAR/framework dependencies.
5. Ask before restarting if tasks are running. Use normal Quit, not forced process termination.
6. Ask the user to complete official authorization and select their account. Never receive/export tokens, read credential contents, or sign in as them.
7. Verify the original model picker contains the independently attributed subscription source and does not replace other providers. Do not automatically change their current model.
8. Real inference/refresh/revocation are not part of an unattended install. Obtain bounded approval; don't use full user conversation history for a test.
9. Report OS/architecture/DSH version, bundle reference, safe checks, restart state and any unverified boundary. Never claim macOS GUI compatibility from a Node CI pass.

Stop on unknown content, out-of-policy versions, missing/failed compatibility contracts, credential requests, unsafe restart or license/permission conflicts. Never force-push, weaken TLS/SSRF settings or approve unrelated lifecycle scripts to continue.
