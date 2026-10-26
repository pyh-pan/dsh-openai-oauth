import {
  findDesktop,
  readHostInfo,
  assessHost,
  SUPPORTED_DSH_VERSIONS,
  DSH_COMPATIBILITY_RANGE,
} from './host.mjs';
import { HOST_VERSION_FIELDS } from '../src/compatibility.js';
try {
  const host = findDesktop();
  const info = readHostInfo(host);
  const assessment = assessHost(info);
  console.log(
    JSON.stringify(
      {
        ...info,
        eligible: assessment.status !== 'unsupported',
        compatibility: assessment.status,
        reason: assessment.reason,
        validatedVersions: SUPPORTED_DSH_VERSIONS,
        eligibleRange: DSH_COMPATIBILITY_RANGE,
        versionDifferences: HOST_VERSION_FIELDS.filter(
          (field) =>
            info[field] !== undefined &&
            info.desktopVersion !== undefined &&
            info[field] !== info.desktopVersion,
        ),
        startupNativeSuites: false,
        behaviorValidatedByDoctor: false,
        location: host.customLocation ? 'custom' : 'standard',
        credentialsInspected: false,
        desktopGuiValidated: false,
      },
      null,
      2,
    ),
  );
  if (assessment.reason) {
    console.error(assessment.reason);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
