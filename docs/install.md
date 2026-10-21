# Installation

Use a local Windows/macOS DSH Desktop, Node.js 24+, npm and Git. Validated releases are **0.2.1-rc.2, 0.2.1-rc.1 and 0.2.0-rc.2**; later in-range 0.2.x releases are contract-tested candidates under the [forward-compatibility policy](forward-compatibility.md), not automatically validated releases. There are no production npm dependencies other than the installed Host peer. The package is source ESM and requires no prepare/build scripts.

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

The helper starts the installed Electron executable in its supported Node/CLI mode. It does not start a second GUI, patch the app, dump config or install a replacement Host. Verify the doctor-reported version, component tuple, `compatibility` classification and `contractIssues` before proceeding. `eligible: true` is not a behavioral or GUI validation. Candidate install/activation CLI operations automatically run both isolated native suites before touching the real profile (native removal remains available after structural checks for recovery); candidate startup after a direct Desktop update also checks the running installation before creating its real-account runtime.

Run native synthetic checks:

```sh
npm run test:native
npm run test:race
```

Quit the current desktop normally only after tasks finish; reopen the same installation after installation/removal. Complete sign-in yourself in Settings → Models. A callback on another machine cannot authorize this local Host.

## Updating a linked checkout safely

Perform provider deployment from an external terminal or an independent assistant, not a DSH conversation using that provider. Native profile changes can unload it immediately through HMR; an approved idle window must include the deploying conversation itself. Preserve code and rollback references first, finish active tasks, and agree on a normal Quit/reopen boundary.

For an existing link, keep the same package owner and use the native `add -w` command from the reviewed checkout. Switching to a new reviewed checkout uses the same command from that directory. Verify the actual package version, canonical link target, selected bundle and loading diagnostics afterwards; neither exit code zero nor `application: applied` proves that a new package replaced a retained link. The CLI can also preserve an existing dependency's deselected bundle state; if the files updated but the source is still absent, enable that bundle through the native plugin manager and recheck loading. Do not invent a `plugin enable` CLI subcommand (the general plugin command forwards arguments to pnpm) or hand-edit the manifest.

**Do not convert an existing Windows checkout Junction to an archive by removing it and then adding a tarball.** A disposable reproduction with Desktop 0.2.1-rc.2 and its bundled pnpm 11.28.5 retained the old link on the first archive add; remove left the Junction in place, and the next archive add deleted files in the linked source directory, including synthetic Git metadata. Native linked-to-linked replacement preserved both fixture sources, including when the dependency declaration said `file:` but the actual installation remained a link. This is evidence for that installed Windows tuple, not a macOS or future-release claim. Stop on an unfamiliar layout or failed check; do not patch the framework, manually rewrite profile files, or repeat destructive remove/add attempts.

If a checkout is damaged, preserve its remaining objects/worktrees and recover into a separate complete repository before deployment. Do not repair Git metadata in place while experimenting with the installer. Archive conversion needs an upstream-safe, separately verified migration path.

## Archives

Use this route only for a clean/archive installation with no existing checkout link for this package. See the linked-checkout warning above before replacing any existing installation.

```sh
npm run pack
npm run dsh -- plugin --profile desktop add ./artifacts/pyh-pan-dsh-openai-oauth-0.3.4.tgz
```

## Missing source and authorization settings after a DSH upgrade

DSH Desktop 0.2.1-rc.2 checks bundle requirements during startup. Plugin 0.3.1 declared only `0.2.0-rc.2 || 0.2.1-rc.1` for its DSH peer, so rc.2 skips the entire bundle: both the model source and client authorization settings disappear before OAuth can run. Optional peer metadata does not exempt a peer from this policy. This symptom alone does not mean a saved grant was lost or expired.

Plugin 0.3.2 restores rc.2 loading and adopts a bounded same-minor candidate range shared by the manifest/helper, with mandatory isolated behavioral checks and live contract guards. Candidates are never relabeled as validated just because a version string matches. No version exemption is granted; see [what future updates can break](forward-compatibility.md).

1. Use `npm run doctor` to identify the actual release tuple without inspecting credentials. An old checkout reports `UNSUPPORTED_DSH_VERSION` and refuses installation.
2. Review/update this checkout to the compatible revision and run the complete checks above, including both native suites when a local Desktop is available.
3. For an existing link to this same package, use the same native add command; do not remove grants, edit profile files, or install a second owner. A different old private bundle needs the [migration procedure](migration.md).
4. After active tasks finish, Quit DSH normally and reopen it. Verify Settings → Models → ChatGPT subscription and the existing model picker; keep other providers and the current selection unchanged. If authorization is actually required, complete it yourself through the official flow.
5. If the runtime is out of policy, a contract check fails, or either entry remains absent, stop and collect only package identity/version and sanitized failure information. Do not use `allow-version`, broaden the range to `*`, or patch ASAR/framework dependencies to force loading.

Install only reviewed commits/archives. A source checkout is linked; keep it at a stable location. Normal package removal preserves grants. See README and migration.md.
