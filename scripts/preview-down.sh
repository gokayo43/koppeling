#!/usr/bin/env bash
# Removes the preview stack and its data. Volumes included — a preview that
# survives is a second production nobody is watching.
set -euo pipefail

# shellcheck source=scripts/stack.sh
. "$(dirname "${BASH_SOURCE[0]}")/stack.sh"
cd "$REPO_DIR"
# The preview's env file is gone once this has run before, and `down` needs
# nothing it held — compose's own defaults cover it. So this is the one caller
# that cannot use preview_compose, which passes that file unconditionally.
env_files=(--env-file .env)
if [ -f "$PREVIEW_ENV" ]; then env_files+=(--env-file "$PREVIEW_ENV"); fi

$DOCKER compose "${env_files[@]}" -p "$PREVIEW_PROJECT" down -v --remove-orphans
rm -f "$PREVIEW_ENV"
echo "· $PREVIEW_PROJECT gone, volumes included"
