# Compatibility and evidence boundaries

## Version policy

Validated release tuples: **DSH Desktop 0.2.0-rc.2** and **0.2.1-rc.1**.
The desktop, Llm, local credentials and Connection packages must match one validated tuple. Unknown versions and mixed component versions are rejected; no ignore-version flag is provided.

Development/install helpers require Node.js 24+. Candidate platforms are local Windows/macOS Desktop only; no blanket claim covers other releases or CPU architectures.

## Validation status

| Environment                                                 | Status                                                                                  | Boundary                                                      |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Windows_NT 10.0.26300 / x64 / Desktop 0.2.0-rc.2            | SIWC baseline and native CLI migration exercised                                        | Saved identity, current selection and other sources preserved |
| Windows / x64 / Desktop 0.2.1-rc.1 / Electron 44.7.0        | Current native suites pass; user confirmed desktop source/login/selection after restart | No new inference calls during migration                       |
| macOS 26.5.2 / arm64 / Desktop 0.2.0-rc.2 / Electron 44.0.0 | User ran 105 unit/package tests and both native suites successfully                     | Controlled upstreams only; not real login/inference           |
| macOS / arm64 / Desktop 0.2.1-rc.1                          | User confirmed upgrade; updated native and real desktop validation pending              | Earlier results are not relabeled as new-version success      |
| GitHub Actions Windows/macOS/Linux                          | Workflow configured; remote result verification pending                                 | Node/package tests only, not desktop proof                    |

The installed applications updated during acceptance. The first Mac install was correctly blocked by the former strict version gate; it did not prove an OAuth failure. New-version support was added only after local artifact/runtime inspection and native regression. The 0.2.1 Connection API requires an owner principal for exact management routes; synthetic carrier calls now supply an explicit owner and test non-owner denial. Production authorization is not bypassed.

## Reproducible checks

`npm test`, `npm run check`, and `npm run test:package` validate standalone source and independently unpacked artifacts. `npm run doctor` reports actual version metadata even when unsupported, without reading profiles or grants.

`npm run test:native` and `npm run test:race` use installed DSH services, temporary generated records and controlled upstreams. They verify source registration/unloading, existing-source preservation, carrier authorization, chunk/replay assembly, callback cleanup, file reload and cross-process atomic rotation. They do not spend inference quota.

Real desktop acceptance is user-controlled: native installation, official sign-in/Agent attribution, original selector/efforts, a tiny approved text/tool exchange, normal restart recovery and appropriate refresh/storage evidence. Remote revocation is not performed on active real grants just for a test record.

Only aggregate public compatibility results belong here. Personal traces, screenshots, credentials and local acceptance artifacts are excluded.
