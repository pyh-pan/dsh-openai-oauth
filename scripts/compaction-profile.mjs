// Read-only native boot primitives ONLY. loadProfile/loadProfileDirectory and
// readBundlePatches without an initial profile can migrate/write manifests.
export function readCompactionProfile(
  boot,
  { profileDir, home, installAnchor, runtimeVersion, presetId, join },
) {
  const manifest = boot.readProfileManifest('dsh', profileDir);
  const bundles = manifest.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || bundles.some((name) => typeof name !== 'string'))
    throw new Error('SIWC_PROFILE_BUNDLE_LIST_UNSUPPORTED');
  const layers = bundles.map((name) => {
    if (name === '@deepseek-ai/dsh-experimental-schedule-bundle')
      throw new Error('SIWC_PROFILE_REQUIRES_NATIVE_MIGRATION');
    const dir = boot.resolveBundleDir('dsh', name, installAnchor, profileDir);
    const metadata = boot.readProfileManifest('dsh', dir);
    if (!metadata.dsh?.bundle || boot.evaluatePluginCompatibility(metadata, {}, runtimeVersion))
      throw new Error('SIWC_PROFILE_BUNDLE_CONTRACT_UNSUPPORTED');
    return boot
      .bundlePatchPaths(dir, metadata.dsh.bundle)
      .flatMap((path) => boot.loadOverlayPatches('dsh', path));
  });
  const userLayers = [
    boot.loadOptionalPatches('dsh', join(profileDir, boot.PROFILE_PATCH_FILENAME)) ?? [],
    boot.loadOptionalPatches('dsh', join(home, 'cordis.patch.yml')) ?? [],
  ];
  const base = boot.composeEntries(layers);
  const target = base.find(
    (row) => row.name === '@deepseek-ai/dsh-agent-preset' && row.config?.id === presetId,
  );
  if (!target || target.disabled) throw new Error('SIWC_PRESET_NOT_FOUND_OR_DISABLED');
  // A bundle installs BELOW these layers. Silently emitting a replacement that
  // a user's whole-config override wins over would leave the old bug active.
  if (
    userLayers
      .flat()
      .some((patch) => patch.id === target.id || patch.insert?.some((row) => row.id === target.id))
  )
    throw new Error('SIWC_PRESET_HIGHER_PRIORITY_OVERRIDE_REQUIRES_REVIEW');
  const effective = boot.composeEntries([...layers, ...userLayers]);
  const selected = effective.find((row) => row.id === target.id);
  if (!selected || selected.disabled) throw new Error('SIWC_PRESET_NOT_FOUND_OR_DISABLED');
  return { layers, userLayers, target: selected };
}
