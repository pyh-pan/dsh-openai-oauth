import { findDesktop, inspectHost } from './host.mjs';
try {
  const host = findDesktop();
  const info = inspectHost(host);
  console.log(
    JSON.stringify(
      {
        ...info,
        location: host.customLocation ? 'custom' : 'standard',
        credentialsInspected: false,
        desktopGuiValidated: false,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
