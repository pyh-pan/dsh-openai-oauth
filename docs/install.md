# Installation

Use a local DSH Desktop **0.2.0-rc.2**, Node.js 24+, npm and Git. There are no production npm dependencies other than the installed Host peer. The package is source ESM and requires no prepare/build scripts.

## Discovery

```sh
npm run doctor
```

Default discovery checks standard per-user/system installation locations for Windows/macOS. A custom installation may be supplied through `DSH_APP` (the desktop executable on Windows; the .app bundle or executable on macOS).

PowerShell:

```powershell
$env:DSH_APP = 'D:\Applications\DeepSeek Harness\DeepSeek Harness.exe'
npm run doctor
```

macOS:

```sh
DSH_APP="/Applications/DeepSeek Harness.app" npm run doctor
```

Do not point at another user's profile or copy an app's embedded framework out into this repository.

## Install

```sh
npm ci
npm test
npm run check
npm run test:package
npm run doctor
npm run dsh -- plugin --profile desktop add -w .
```

The helper starts the installed Electron executable in its supported Node/CLI mode. It does not start a second GUI, patch the app, dump config or install a replacement Host. Verify the doctor-reported version before proceeding.

Run native synthetic checks:

```sh
npm run test:native
npm run test:race
```

Quit the current desktop normally only after tasks finish; reopen the same installation after installation/removal. Complete sign-in yourself in Settings → Models. A callback on another machine cannot authorize this local Host.

## Archives

```sh
npm run pack
npm run dsh -- plugin --profile desktop add ./artifacts/pyh-pan-dsh-openai-oauth-0.3.0.tgz
```

Install only reviewed commits/archives. A source checkout is linked; keep it at a stable location. Normal package removal preserves grants. See README and migration.md.
