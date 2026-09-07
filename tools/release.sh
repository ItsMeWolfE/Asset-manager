#!/usr/bin/env bash
#
# Cut a release.
#
#   tools/release.sh 3.1.0 "Short title" "Longer note shown in the update prompt"
#
# Updates the three places a version number lives, keeps CHANGELOG.md and the
# in-app release list in step, then commits and tags. Push the tag and GitHub
# Pages redeploys; every running copy offers the update on its next start.

set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: tools/release.sh <version> <title> [notes]" >&2
  exit 1
fi

VERSION="$1"
TITLE="$2"
NOTES="${3:-$TITLE}"
TODAY="$(date +%Y-%m-%d)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "version must look like 3.1.0" >&2
  exit 1
fi

cd "$ROOT"

if [ -n "$(git status --porcelain)" ]; then
  echo "working tree is dirty; commit or stash first" >&2
  exit 1
fi

# 1. the version the running app reports
#
# BUILD_ID is rewritten back to the placeholder on purpose: the deploy workflow
# stamps it, so anything committed here would be a stale copy of some earlier
# deploy.
cat > assets/js/core/version.js <<JS
// Single source of truth for the running version.
//
// release.sh keeps this value, version.json and the sw.js cache name in step.
// Nothing else in the app should hardcode a version number.
export const APP_VERSION = '$VERSION';

// Which deploy this copy came from, stamped by .github/workflows/pages.yml
// with a hash of the files that actually ship. Two copies reporting the same
// APP_VERSION but different BUILD_IDs are running different code.
//
// Stays 'dev' in the repository and in any local checkout, which is the honest
// answer for files that were never deployed.
export const BUILD_ID = 'dev';
JS

# 2. what the update check reads
cat > version.json <<JSON
{
  "version": "$VERSION",
  "build": "dev",
  "built": "dev",
  "released": "$TODAY",
  "title": "$TITLE",
  "notes": "$NOTES"
}
JSON

# 3. the service worker cache name; changing it is what triggers the update
sed -i.bak -E "s/^const CACHE_VERSION = '.*';/const CACHE_VERSION = '$VERSION';/" sw.js
rm -f sw.js.bak

# 4. the in-app release list
tmp="$(mktemp)"
{
  head -n 1 assets/js/data/changelog.js
  printf 'export const CHANGELOG = [\n{version:"v%s",title:"%s",description:"%s"},\n' "$VERSION" "$TITLE" "$NOTES"
  tail -n +2 assets/js/data/changelog.js | sed '1s/^export const CHANGELOG = \[$//' | sed '/^$/d'
} > "$tmp"
mv "$tmp" assets/js/data/changelog.js

# 5. the file humans read
tmp="$(mktemp)"
{
  printf '# Changelog\n\n## %s - %s\n\n**%s**\n\n%s\n' "$VERSION" "$TODAY" "$TITLE" "$NOTES"
  tail -n +2 CHANGELOG.md
} > "$tmp"
mv "$tmp" CHANGELOG.md

git add -A
git commit -m "Release $VERSION: $TITLE"
git tag -a "v$VERSION" -m "$TITLE"

echo
echo "Released $VERSION. Now run:"
echo "  git push && git push --tags"
