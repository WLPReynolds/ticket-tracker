#!/usr/bin/env bash
# Sets the release version in all three places at once:
#   - APP_VERSION in js/config.js          (v2026-11-10.07:30)
#   - every ?v= stamp in index.html         (?v=2026-11-10.0730)
#   - VERSION in sw.js                      ('2026-11-10.0730')
# Usage, from anywhere in the repo:
#   tools/stamp-version.sh v2026-11-10.07:30
# Then run tools/check.sh.
# Works with macOS's bash 3.2 and Linux (uses perl rather than sed -i,
# which differs between the two).
set -euo pipefail
cd "$(dirname "$0")/.."

ver="${1:-}"
if ! [[ "$ver" =~ ^v[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]{2}:[0-9]{2}$ ]]; then
  echo "Usage: tools/stamp-version.sh vYYYY-MM-DD.HH:MM   (e.g. v2026-11-10.07:30)" >&2
  exit 1
fi
stamp="${ver#v}"        # 2026-11-10.07:30
stamp="${stamp/:/}"     # 2026-11-10.0730

VER="$ver" perl -pi -e "s/^const APP_VERSION = '[^']*';/const APP_VERSION = '\$ENV{VER}';/" js/config.js
STAMP="$stamp" perl -pi -e 's/\?v=[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]{4}/?v=$ENV{STAMP}/g' index.html
STAMP="$stamp" perl -pi -e "s/^const VERSION = '[^']*';/const VERSION = '\$ENV{STAMP}';/" sw.js

echo "Stamped $ver (URLs and service worker: $stamp)."
echo "Now run tools/check.sh"
