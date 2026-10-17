# Compatibility and evidence boundaries

## Version policy

Native-validated release tuples: **DSH Desktop 0.2.0-rc.2**, **0.2.1-rc.1** and **0.2.1-rc.2**. Real desktop acceptance remains separately scoped below.
The shared [forward-compatibility policy](forward-compatibility.md) distinguishes **validated**, **candidate** and **unsupported** releases. The Desktop, Llm, credentials, Connection, boot and required model UI packages must have the same exact version. Same-minor candidates require isolated native checks before installation or real-account startup; outside-family versions, mixed components and failed contracts are rejected. No ignore-version flag is provided.

Development/install helpers require Node.js 24+. Candidate platforms are local Windows/macOS Desktop only; no blanket claim covers other releases or CPU architectures.

## Validation status

| Environment                                                        | Status                                                                                        | Boundary                                                         |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Windows_NT 10.0.26300 / x64 / Desktop 0.2.0-rc.2                   | SIWC baseline and native CLI migration exercised                                              | Saved identity, current selection and other sources preserved    |
| Windows / x64 / Desktop 0.2.1-rc.1 / Electron 44.7.0               | Previously passed native suites; user confirmed desktop source/login/selection                | No new inference calls during migration                          |
| Windows_NT 10.0.26300 / x64 / Desktop 0.2.1-rc.2 / Electron 44.7.0 | Boot/native suites pass; initial UI recovery user-confirmed; hardened-startup recheck pending | Temporary profile/credentials only; no real inference or refresh |
| macOS 26.5.2 / arm64 / Desktop 0.2.0-rc.2 / Electron 44.0.0        | User ran 105 unit/package tests and both native suites successfully                           | Controlled upstreams only; not real login/inference              |
| macOS / arm64 / Desktop 0.2.1-rc.1                                 | User confirmed upgrade; updated native and real desktop validation pending                    | Earlier results are not relabeled as new-version success         |
| macOS / arm64 / Desktop 0.2.1-rc.2                                 | Not yet exercised                                                                             | Windows/Node results do not establish macOS GUI compatibility    |
| GitHub Actions Windows/macOS/Linux                                 | Workflow configured; remote result verification pending                                       | Node/package tests only, not desktop proof                       |

The installed applications updated during acceptance. The first Mac install was correctly blocked by the former strict version gate; it did not prove an OAuth failure. New-version support was added only after local artifact/runtime inspection and native regression. The 0.2.1 Connection API requires an owner principal for exact management routes; synthetic carrier calls now supply an explicit owner and test non-owner denial. Production authorization is not bypassed.

## Desktop 0.2.1-rc.2: source and authorization settings disappear

Observed cause: the profile still names the public bundle, but plugin 0.3.1 declares the DSH peer range `0.2.0-rc.2 || 0.2.1-rc.1`. The installed rc.2 `dsh-app-boot` evaluates DSH peer requirements (even optional peers) and skips an incompatible bundle before composing its patch layer. Thus neither Host provider registration nor client settings activation is contributed. The install helper independently rejects the same unvalidated tuple. This is a package activation failure, not evidence of a failed OAuth exchange or erased credentials.

The first repair added the exact rc.2 tuple and the user confirmed recovery after a normal restart. At the user's request, plugin 0.3.2 additionally uses a bounded same-minor candidate range and shared policy rather than rejecting every subsequent patch/RC by exact version. New runtime guards check critical methods and owner routing before real-account initialization; candidate install and direct-update startup run both isolated native suites. No `engines.dsh` override, `allow-version` exemption, credential migration, DSH patch, or framework replacement is used. The OAuth/wire adapter and credential identity remain unchanged. See [forward compatibility](forward-compatibility.md) for classification, failure modes and limits.

Evidence and limits:

- Inspected Windows artifact SHA-256: `47874618bf5b3011fcaac10cd4c85f69da333e70d4f99b921207c78d0999512a`. Desktop/Llm/credentials/Connection all report `0.2.1-rc.2`; Electron reports `44.7.0` and its Node runtime `24.21.0`.
- Targeted shipped-source inspection covers compatibility evaluation/profile-layer rejection and the retained `settings.models.footer`/model-directory integration surfaces. It is not a complete DSH audit or proof of live GUI execution. REA records: `ev_c27173b491d78c0eff909ebdb91279ede891e1175f8a85e236107592137c7fc6` (selected service/client sources); `ev_33ee7b6d5da80db2d79a8abd58a331285c079762b3dee4880471d50f73badaa4` (boot source; semantic expansion hit its worker resource limit). Focused source reads and actual installed-function tests, not incomplete graph absence, establish the diagnosis.
- An actual installed `evaluatePluginCompatibility` call reproduces the old manifest's unmet peer requirement with `exempted: false`. A disposable profile regression exercises `loadProfileDirectory` and `composeEntries`: old manifest skipped, current manifest loaded exactly once without exemptions, existing fixture layer preserved. In-range synthetic future labels are eligible; next-minor prereleases/final remain denied. The classifier is cross-checked against the installed boot evaluator.
- Both installed-runtime native suites pass with controlled upstreams: additive source/model registration, reasoning resolution, mock Responses/chunk replay, authenticated management/non-owner denial, temporary-store restart, and two-process single-refresh rotation. Client tests preserve the native settings slot and session directory bindings without selecting a model.
- Earlier version declarations and unit coverage remain; the old Desktop binaries were not rerun during this rc.2 repair. The user confirmed rc.2 entry recovery after a normal restart of the initial repair. A final desktop recheck of the later startup/client guards is pending; synthetic tests are not substituted for that observation. Real inference, refresh and revocation of user grants were not attempted.

## Reproducible checks

`npm test`, `npm run check`, and `npm run test:package` validate standalone source and independently unpacked artifacts. `npm run doctor` reports actual version metadata even when unsupported, without reading profiles or grants.

`npm run test:native` and `npm run test:race` use installed DSH services, temporary generated records and controlled upstreams. They verify source registration/unloading, existing-source preservation, carrier authorization, chunk/replay assembly, callback cleanup, file reload and cross-process atomic rotation. They do not spend inference quota.

Real desktop acceptance is user-controlled: native installation, official sign-in/Agent attribution, original selector/efforts, a tiny approved text/tool exchange, normal restart recovery and appropriate refresh/storage evidence. Remote revocation is not performed on active real grants just for a test record.

Only aggregate public compatibility results belong here. Personal traces, screenshots, credentials and local acceptance artifacts are excluded.
