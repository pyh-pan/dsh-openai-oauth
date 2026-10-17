# Contributing

Use Node.js 24+ and npm. Open small, reviewable changes against this repository; never commit personal DSH state.

```sh
npm ci
npm test
npm run check
npm run test:package
```

With a local compatible DSH installation, run `npm run doctor`, `npm run test:native`, and `npm run test:race`. These native suites use temporary credential files and controlled upstreams only.

## Structure

- `src/index.js`: native Host composition using DSH's own Llm exports.
- `src/siwc/`: authentication, accounts, sessions, capabilities and Responses wire adapter.
- `src/client.js`, `src/locale/`: native settings/model UI integration.
- `test/`: generated identities and deterministic protocol/lifecycle tests.
- `scripts/`: portable discovery, native invocation, syntax/package checks.
- `docs/`: public installation, migration, protocol and verification contracts.

Source is directly distributable ESM; no build or committed vendor tree is needed. Do not broaden the Host peer range without real integration evidence.

## Regression boundaries

Preserve provider ID `chatgpt-subscription`, Host plugin/credential owner `chatgpt-subscription-login`, callback security, registration binding, issued-client reuse, quota attribution, terminal-event checks and no billing fallback. A package rename must not rotate identity or migrate unrelated grants.

Any real-account test needs explicit user approval, a tiny fixed context and a bounded request budget. Never run real inference in CI or automatically during installation. Do not add hidden debugging endpoints.

For reference-project code reuse, check license/attribution and review protocol differences first. Current SIWC correctness takes precedence over legacy compatibility.
