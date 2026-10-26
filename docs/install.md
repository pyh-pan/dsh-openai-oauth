# Installation

Use a local Windows/macOS DSH Desktop, Node.js 24+, npm and Git. Loading has a minimum requirement of `>=0.2.0-rc.2`; actual capabilities follow the [forward-compatibility policy](forward-compatibility.md). Read [platform evidence](compatibility.md) separately from loading eligibility. There are no production npm dependencies other than the installed Host peer. The package is source ESM and requires no prepare/build scripts.

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

The helper starts the installed Electron executable in its supported Node/CLI mode. It does not start a second GUI, patch the app, dump config or install a replacement Host. Inspect the doctor-reported metadata, `contractIssues` and `sessionContractIssues`. `eligible: true` describes core structural eligibility, not session protection, behavioral validation or GUI acceptance. Component-version differences are diagnostic only; real module identity and necessary Interfaces still matter. The helper invokes the native CLI after structural discovery. Neither installation nor production startup automatically runs release tests on a new version label.

Run the native synthetic checks explicitly when reviewing a source change for deployment:

```sh
npm run test:native
npm run test:race
npm run test:compaction
npm run test:presets
```

Quit the current desktop normally only after tasks finish; reopen the same installation after installation/removal. Complete sign-in yourself in Settings → Models. A callback on another machine cannot authorize this local Host.

## Unified compaction

The same provider package adapts compatible supported native presets in memory and checks the actual retained session revision before Responses dispatch. It does not persist full preset snapshots. If the former `@local/dsh-siwc-compaction-compat` bundle is installed, migrate it through the native manager after validating the new main entry; do not keep it as an independent update dependency. See [migration and per-session verification](compaction.md#installation-and-migration-from-the-former-local-bundle). Verify the projected selected preset (including cordis), not merely a standard creation header or a visible model source.

## Updating a linked checkout safely

Perform provider deployment from an external terminal or an independent assistant, not a DSH conversation using that provider. Native profile changes can unload it immediately through HMR; an approved idle window must include the deploying conversation itself. Preserve code and rollback references first, finish active tasks, and agree on a normal Quit/reopen boundary.

For an existing link, keep the same package owner and use the native `add -w` command from the reviewed checkout. Switching to a new reviewed checkout uses the same command from that directory. Verify the actual package version, canonical link target, selected bundle and loading diagnostics afterwards; neither exit code zero nor `application: applied` proves that a new package replaced a retained link. The CLI can also preserve an existing dependency's deselected bundle state; if the files updated but the source is still absent, enable that bundle through the native plugin manager and recheck loading. Do not invent a `plugin enable` CLI subcommand (the general plugin command forwards arguments to pnpm) or hand-edit the manifest.

**Do not convert an existing Windows checkout Junction to an archive by removing it and then adding a tarball.** A disposable reproduction with Desktop 0.2.1-rc.2 and its bundled pnpm 11.28.5 retained the old link on the first archive add; remove left the Junction in place, and the next archive add deleted files in the linked source directory, including synthetic Git metadata. Native linked-to-linked replacement preserved both fixture sources, including when the dependency declaration said `file:` but the actual installation remained a link. This is evidence for that installed Windows tuple, not a macOS or future-release claim. Stop on an unfamiliar layout or failed check; do not patch the framework, manually rewrite profile files, or repeat destructive remove/add attempts.

If a checkout is damaged, preserve its remaining objects/worktrees and recover into a separate complete repository before deployment. Do not repair Git metadata in place while experimenting with the installer. Archive conversion needs an upstream-safe, separately verified migration path.

## Archives

Use this route only for a clean/archive installation with no existing checkout link for this package. See the linked-checkout warning above before replacing any existing installation.

```sh
npm run pack
npm run dsh -- plugin --profile desktop add ./artifacts/pyh-pan-dsh-openai-oauth-0.3.8.tgz
```

## Missing source and authorization settings after a DSH upgrade

There are two distinct historical failures: plugin 0.3.1 was rejected by rc.2's package-level peer policy, removing both entries; plugin 0.3.6 loaded its client on rc.3 but its Host startup test failed on an exact rc.2 compaction lock, leaving the management route absent. Neither symptom proves a saved grant was lost.

From 0.3.7 the DSH peer policy has a minimum floor, compaction follows actual capabilities, and production no longer invokes the release-test runner. The client distinguishes a missing route (`DSH_SOURCE_NOT_LOADED`), access denial, malformed response and genuine transport failure. Session integration errors appear as fixed coverage diagnostics while account settings remain available, provided the essential account/owner contracts pass.

1. Run `npm run doctor` without opening credentials. Inspect core and session Interface diagnostics; do not treat a new/unknown version label alone as a failure.
2. Review/update an isolated checkout and run source/package and native checks explicitly. Do not edit an active linked checkout while developing.
3. Preserve the package owner, grant namespace and link form. Use the native add command; a different old private owner needs the [migration procedure](migration.md). Do not delete grants, edit profile files or install another owner.
4. At an approved idle window, deploy from an independent terminal/assistant, Quit normally and reopen. Verify subscription settings, the existing model picker, all supported presets and the target Agent's actual selected/retained revision. Keep other providers and the current selection unchanged.
5. If a necessary contract fails, stop the affected operation and collect only sanitized diagnostics. Do not use `allow-version`, `*` or a framework/ASAR patch. Reauthorization, if actually required, belongs to the user.
   Install only reviewed commits/archives. A source checkout is linked; keep it at a stable location. Normal package removal preserves grants. See README and migration.md.
