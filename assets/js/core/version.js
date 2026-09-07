// Single source of truth for the running version.
//
// release.sh keeps this value, version.json and the sw.js cache name in step.
// Nothing else in the app should hardcode a version number.
export const APP_VERSION = '3.3.0';

// Which deploy this copy came from, stamped by .github/workflows/pages.yml
// with a hash of the files that actually ship. Two copies reporting the same
// APP_VERSION but different BUILD_IDs are running different code.
//
// Stays 'dev' in the repository and in any local checkout, which is the honest
// answer for files that were never deployed.
export const BUILD_ID = 'dev';
