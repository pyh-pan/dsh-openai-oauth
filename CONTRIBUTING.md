# Contributing

Use Node.js 24+ and npm. Open small, reviewable changes against this repository; never commit personal DSH state.

```sh
npm ci
npm test
npm run check
npm run test:package
```

With a local compatible DSH installation, run `npm run doctor`, `npm run test:native`, and `npm run test:race`. These native suites use temporary credential files and controlled upstreams only. Where the native boot evaluator is available, `test:native` also exercises its compatibility policy with disposable profile/package fixtures: the legacy bundle is skipped, the current bundle contributes its entry without exemptions, and an existing layer remains intact. It never edits the user's profile.

## Structure

- `src/index.js`: native Host composition using DSH's own Llm exports.
- `src/siwc/`: authentication, accounts, sessions, capabilities and Responses wire adapter.
- `src/client.js`, `src/locale/`: native settings/model UI integration.
- `test/`: generated identities and deterministic protocol/lifecycle tests.
- `scripts/`: portable discovery, native invocation, syntax/package checks.
- `docs/`: public installation, migration, protocol and verification contracts.

Source is directly distributable ESM; no build or committed vendor tree is needed. Keep `src/compatibility.js`, every DSH peer, helper diagnostics and documentation synchronized. Loading has a minimum floor and no guessed future-version upper bound. Run all four native suites explicitly for release review; neither production startup nor the install helper spawns them on a new version label. Historical baseline evidence is separate from admission. See [forward compatibility](docs/forward-compatibility.md).

Keep runtime changes shape-driven and test at the actual Host Interfaces. `test:presets` exercises the real main entry with the installed native classes, then changes only APP_IDENTITY metadata to historical/future/missing labels. These are version-invariance tests, not validation of those other binaries. Pure fixtures cover the verified historical operator/mount-reader Interfaces; rerun actual older installations when available and record gaps rather than relabeling fixture success as platform acceptance. Optional display failures must not remove account settings, while uncovered session requests stay blocked.

## Regression boundaries

Preserve provider ID `chatgpt-subscription`, Host plugin/credential owner `chatgpt-subscription-login`, callback security, registration binding, issued-client reuse, quota attribution, terminal-event checks and no billing fallback. A package rename must not rotate identity or migrate unrelated grants.

Any real-account test needs explicit user approval, a tiny fixed context and a bounded request budget. Never run real inference in CI or automatically during installation. Do not add hidden debugging endpoints.

For reference-project code reuse, check license/attribution and review protocol differences first. Current SIWC correctness takes precedence over legacy compatibility.
