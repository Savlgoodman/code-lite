#!/usr/bin/env sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

cd "$REPO_ROOT"

# The values are validated by build-version.mjs before shell assignments are emitted.
eval "$(node scripts/build-version.mjs --format=shell)"

printf 'Building Code Lite Remote %s\n' "$CODE_LITE_DISPLAY_VERSION"
npm run build --prefix ui-remote
printf 'PWA output: %s\n' "$REPO_ROOT/ui-remote/dist"
