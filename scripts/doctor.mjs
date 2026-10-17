import {
  findDesktop,
  readHostInfo,
  assessHost,
  SUPPORTED_DSH_VERSIONS,
  DSH_COMPATIBILITY_RANGE,
} from './host.mjs';
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
        candidateNativeChecksRequired: assessment.status === 'candidate',
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
