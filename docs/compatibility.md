# Compatibility and evidence boundaries

## Supported target

- DSH Desktop: **0.2.0-rc.2**. Do not assume older/newer framework APIs are compatible.
- Development/install helpers: Node.js 24+.
- Candidate platforms: Windows and macOS, local Desktop Host only.
- No claim of all CPU architectures or all OS releases.

## Validation status

| Layer                                                | Current status                                | What it proves                                                                |
| ---------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------- |
| SIWC baseline, Windows                               | Previously exercised before public migration  | Protocol, native integration and live minimal inference; not a new macOS test |
| Public project standalone unit/package tests         | Passing locally                               | Synthetic protocol/lifecycle tests and independent distributable source       |
| Public project Windows installation migration        | Pending                                       | Must preserve actual profile, grants and selected model                       |
| macOS 26.5.2 / arm64 / Node 24.14.0 / DSH 0.2.0-rc.2 | Environment supplied; real validation pending | No GUI/inference success claimed yet                                          |
| GitHub Actions Windows/macOS                         | Pending execution                             | Node/package tests only, never OAuth or desktop proof                         |

Statuses must be updated only from actual execution, not anticipated compatibility. Personal traces, screenshots and profile data are deliberately excluded from this repository.

## Native checks

`npm run test:native` and `npm run test:race` use the installed DSH services with temporary generated records and controlled upstreams. They verify source registration/unloading, original-source preservation, authenticated carrier routing, chunk/replay assembly, file reload and cross-process atomic rotation. They are not real-account inference tests.

Real desktop acceptance must be user-controlled: install in the actual desktop profile, perform official sign-in, confirm Agent attribution, check the original selector/efforts, exercise a tiny approved text/tool exchange, recover after normal restart, and distinguish real refresh from clock/service simulations.

Remote revocation tests use controlled upstreams unless explicitly approved otherwise; don't disconnect a user's active grant merely to make a test record.
