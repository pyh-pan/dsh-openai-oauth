import { findDesktop, readHostInfo, isSupportedHost, SUPPORTED_DSH_VERSIONS } from './host.mjs';
try {
  const host = findDesktop();
  const info = readHostInfo(host);
  const supported = isSupportedHost(info);
  console.log(
    JSON.stringify(
      {
        ...info,
        supported,
        supportedVersions: SUPPORTED_DSH_VERSIONS,
        location: host.customLocation ? 'custom' : 'standard',
        credentialsInspected: false,
        desktopGuiValidated: false,
      },
      null,
      2,
    ),
  );
  if (!supported) {
    console.error('UNSUPPORTED_DSH_VERSION');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
