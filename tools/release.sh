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
printf '// Single source of truth for the running version.\n//\n// release.sh keeps this value, version.json and the sw.js cache name in step.\n// Nothing else in the app should hardcode a version number.\nexport const APP_VERSION = '"'"'%s'"'"';\n' "$VERSION" > assets/js/core/version.js

# 2. what the update check reads
cat > version.json <<JSON
{
  "version": "$VERSION",
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
