# Compatibility and evidence boundaries

## Version policy

Loading requires `>=0.2.0-rc.2`, with no future-version upper bound. The [forward-compatibility policy](forward-compatibility.md) separates admission from evidence: release metadata is not a whitelist, unknown metadata is not a failed Interface, and component version equality is not proof of runtime identity. Essential account contracts and per-session safety still decide the affected capability. There is no ignore-version flag or production test subprocess.

Historical native baselines are **DSH Desktop 0.2.0-rc.2**, **0.2.1-rc.1** and **0.2.1-rc.2**. New local evidence is recorded separately, not promoted by matching the loading range. Helpers require Node.js 24+; the claimed deployment remains local Windows/macOS Desktop.

## Validation status

| Environment                                                        | Status                                                                                                  | Boundary                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Windows_NT 10.0.26300 / x64 / Desktop 0.2.0-rc.2                   | SIWC baseline and native CLI migration exercised                                                        | Saved identity, current selection and other sources preserved    |
| Windows / x64 / Desktop 0.2.1-rc.1 / Electron 44.7.0               | Previously passed native suites; user confirmed desktop source/login/selection                          | No new inference calls during migration                          |
| Windows_NT 10.0.26300 / x64 / Desktop 0.2.1-rc.2 / Electron 44.7.0 | Boot/native suites pass; initial UI recovery user-confirmed; hardened-startup recheck pending           | Temporary profile/credentials only; no real inference or refresh |
| macOS 26.5.2 / arm64 / Desktop 0.2.0-rc.2 / Electron 44.0.0        | User ran 105 unit/package tests and both native suites successfully                                     | Controlled upstreams only; not real login/inference              |
| macOS / arm64 / Desktop 0.2.1-rc.1                                 | User confirmed upgrade; updated native and real desktop validation pending                              | Earlier results are not relabeled as new-version success         |
| macOS / arm64 / Desktop 0.2.1-rc.2                                 | Not yet exercised                                                                                       | Windows/Node results do not establish macOS GUI compatibility    |
| macOS 26.5.2 / arm64 / Desktop 0.2.1-rc.3 / Electron 44.7.0        | All four isolated native suites and real main-entry version invariance pass; Desktop acceptance pending | Synthetic temporary data; no real inference/refresh/revocation   |
| GitHub Actions Windows/macOS/Linux                                 | Workflow configured; remote result verification pending                                                 | Node/package tests only, not desktop proof                       |

The installed applications updated during acceptance. The first Mac install was correctly blocked by the former strict version gate; it did not prove an OAuth failure. New-version support was added only after local artifact/runtime inspection and native regression. The 0.2.1 Connection API requires an owner principal for exact management routes; synthetic carrier calls now supply an explicit owner and test non-owner denial. Production authorization is not bypassed.

## Desktop 0.2.1-rc.3: settings card cannot reach Host

Plugin 0.3.6 passed package admission but its startup test rejected `src/compaction.js` solely because `dsh-compaction-basic` was not exactly rc.2. The account/provider runtime never started and the management route returned 404; the client classified the JSON parsing failure as `network`. Separately, the main entry integrated session safety only on rc.2, and the candidate test runner invoked a production-entry fixture that invoked the same runner again. Changing one whitelist alone would therefore be incomplete.

The official rc.2 npm artifacts (registry integrity verified) and the installed rc.3 `lib/index.js` are byte-identical for Llm, Connection, local credentials, basic compaction, preset declaration/registry and session projections. Isolated release-label admission and real native behavior tests support the diagnosis; this is not an audit of all rc.3 changes.

Version 0.3.7 removes these release-specific activation paths and the production test runner. It uses the minimum-only peer policy, actual Llm class identity, owner probes and separately scoped session protection. Additive ordinary preset plugins are retained. Missing session capabilities produce fixed owner-only diagnostics while denying session dispatch, not a missing account settings route. The optional model badge can disappear without disabling the settings card.

Verification reads the actual installed runtime. `test:presets` boots the real main entry and then repeats with only APP_IDENTITY changed to historical/future/missing labels, retaining every real native class. These labels are not old/future binaries. Published historical Connection/registry sources were inspected for the operator-class and public retained-mount Adapters; pure fixtures exercise those Interfaces, but older Desktop binaries were not rerun in this repair. Current native checks and Desktop acceptance remain separately scoped in the table above.

Reference: [dsh-context 0.74.0 compatibility rules](https://github.com/bowenliang123/dsh-context/blob/v0.74.0/docs/compatibility.md), confirmed against the installed published artifact. Its minimum/shape-driven design is adopted, not its display-data fail-open policy for credentials or inference.

## Historical repair — Desktop 0.2.1-rc.2: both entries disappear

Observed cause: the profile still names the public bundle, but plugin 0.3.1 declares the DSH peer range `0.2.0-rc.2 || 0.2.1-rc.1`. The installed rc.2 `dsh-app-boot` evaluates DSH peer requirements (even optional peers) and skips an incompatible bundle before composing its patch layer. Thus neither Host provider registration nor client settings activation is contributed. The install helper independently rejects the same unvalidated tuple. This is a package activation failure, not evidence of a failed OAuth exchange or erased credentials.

The first repair added the exact rc.2 tuple and the user confirmed recovery after a normal restart. At the user's request, plugin 0.3.2 then used a bounded same-minor candidate range and shared policy rather than rejecting every subsequent patch/RC by exact version. That historical revision added runtime method/owner guards and candidate install/startup test suites. Its bounded policy and automatic test runner are replaced by the 0.3.7 policy above. No `engines.dsh` override, `allow-version` exemption, credential migration, DSH patch, or framework replacement is used. The OAuth/wire adapter and credential identity remain unchanged. See [forward compatibility](forward-compatibility.md) for classification, failure modes and limits.

Evidence and limits:

- Inspected Windows artifact SHA-256: `47874618bf5b3011fcaac10cd4c85f69da333e70d4f99b921207c78d0999512a`. Desktop/Llm/credentials/Connection all report `0.2.1-rc.2`; Electron reports `44.7.0` and its Node runtime `24.21.0`.
- Targeted shipped-source inspection covers compatibility evaluation/profile-layer rejection and the retained `settings.models.footer`/model-directory integration surfaces. It is not a complete DSH audit or proof of live GUI execution. REA records: `ev_c27173b491d78c0eff909ebdb91279ede891e1175f8a85e236107592137c7fc6` (selected service/client sources); `ev_33ee7b6d5da80db2d79a8abd58a331285c079762b3dee4880471d50f73badaa4` (boot source; semantic expansion hit its worker resource limit). Focused source reads and actual installed-function tests, not incomplete graph absence, establish the diagnosis.
- An actual installed `evaluatePluginCompatibility` call reproduces the old manifest's unmet peer requirement with `exempted: false`. A disposable profile regression exercises `loadProfileDirectory` and `composeEntries`: old manifest skipped, then-current manifest loaded exactly once without exemptions, existing fixture layer preserved. Under that old policy, in-range synthetic future labels were eligible and next-minor prereleases/final were denied. The classifier is cross-checked against the installed boot evaluator.
- Both installed-runtime native suites pass with controlled upstreams: additive source/model registration, reasoning resolution, mock Responses/chunk replay, authenticated management/non-owner denial, temporary-store restart, and two-process single-refresh rotation. Client tests preserve the native settings slot and session directory bindings without selecting a model.
- Earlier version declarations and unit coverage remain; the old Desktop binaries were not rerun during this rc.2 repair. The user confirmed rc.2 entry recovery after a normal restart of the initial repair. A final desktop recheck of the later startup/client guards is pending; synthetic tests are not substituted for that observation. Real inference, refresh and revocation of user grants were not attempted.

## Reproducible checks

`npm test`, `npm run check`, and `npm run test:package` validate standalone source and independently unpacked artifacts. `npm run doctor` reports actual version metadata even when unsupported, without reading profiles or grants.

`npm run test:native`, `npm run test:race`, `npm run test:compaction` and `npm run test:presets` are explicit development/release checks using installed DSH services, temporary generated records and controlled upstreams. They verify source registration/unloading, existing-source preservation, carrier authorization, chunk/replay assembly, callback cleanup, file reload and cross-process atomic rotation. They do not spend inference quota.

Real desktop acceptance is user-controlled: native installation, official sign-in/Agent attribution, original selector/efforts, a tiny approved text/tool exchange, normal restart recovery and appropriate refresh/storage evidence. Remote revocation is not performed on active real grants just for a test record.

Only aggregate public compatibility results belong here. Personal traces, screenshots, credentials and local acceptance artifacts are excluded.
