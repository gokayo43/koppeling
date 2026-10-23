#!/usr/bin/env bash
# Boots the real images against their own database, on their own ports.
#
#   scripts/preview.sh                         # fresh database + migrations
#   scripts/preview.sh --restore               # ...from the latest backup instead
#   scripts/preview-down.sh                    # take it away, volumes included
#
# This is the pre-deploy smoke path once a repo has real users: the images are
# the ones that would ship, the migrations run the way they would run, and
# --restore makes the rehearsal double as a restore drill — the only way to find
# out a backup is unreadable before the night you need it. --key overrides the
# identity for one run; without it the drill takes BACKUP_AGE_KEY out of .env.
#
# Migrations run either way, and after the restore: a backup is older than the
# code being previewed, so the pending migrations are exactly what the deploy
# would apply to production.
#
# Its own compose project name, so nothing here can reach the running stack:
# `docker compose -p` scopes containers, networks and volumes together.
set -euo pipefail

# shellcheck source=scripts/stack.sh
. "$(dirname "${BASH_SOURCE[0]}")/stack.sh"
restore=""
key=""

while [ $# -gt 0 ]; do
  case "$1" in
    --restore) restore=1; shift ;;
    --key) key="${2:?--key needs an age identity file}"; shift 2 ;;
    *) echo "[preview] unknown argument: $1" >&2; exit 2 ;;
  esac
done
# Whether there is an identity at all, and where it comes from when --key does
# not say, is the drill's rule — so the drill is what answers, here rather than
# after the images are built. --dry-run decides everything and touches nothing.
drill_key=()
if [ -n "$key" ]; then drill_key=(--key "$key"); fi
if [ -n "$restore" ]; then
  "$(dirname "${BASH_SOURCE[0]}")/restore-drill.sh" \
    --project "$PREVIEW_PROJECT" "${drill_key[@]}" --dry-run >/dev/null
fi

# A port, or nothing gets written. What is asked for here ends up in the file
# below as a value and inside an origin, and the file is read by two parsers
# that do not agree about the edges of a value: compose trims a trailing space
# and the grep in a web image's Dockerfile keeps it, so a padded port becomes a
# bundle calling an origin the API does not answer at. It is refused where it
# enters instead.
check_port() {
  case "$2" in
    '' | *[!0-9]*)
      echo "[preview] $1 must be a port number, not '$2'" >&2
      exit 2
      ;;
  esac
}

WEB_PORT="${PREVIEW_WEB_PORT:-5190}"
POSTGRES_PORT="${PREVIEW_POSTGRES_PORT:-5490}"
check_port PREVIEW_WEB_PORT "$WEB_PORT"
check_port PREVIEW_POSTGRES_PORT "$POSTGRES_PORT"
# scaffold:monorepo
API_PORT="${PREVIEW_API_PORT:-5191}"
REDIS_PORT="${PREVIEW_REDIS_PORT:-6390}"
check_port PREVIEW_API_PORT "$API_PORT"
check_port PREVIEW_REDIS_PORT "$REDIS_PORT"
# scaffold:monorepo

# Ports and origins of its own: the dev stack and the deployed stack are both on
# this box, and a preview that pointed its browser bundle or its auth cookies at
# the production hostname would be previewing production.
#
# Written to a file rather than exported, because the values have to reach
# compose's interpolation however $DOCKER is spelled — an exported port would
# silently fall back to the dev one in .env, which is a preview stack fighting
# the stack it is previewing. It is also the record every other preview script
# reads its ports back out of.
#
# Every key here reaches the stack, which is the whole of the isolation: one
# that nothing reads leaves compose resolving that value from the developer's
# own .env, or the containers from deploy.env, silently and with no sign in the
# output. The ports get there by interpolation; the origins are what ORIGINS_ENV
# is for — it names this file as the one the containers and the web image's
# build read theirs from, in deploy.env's place. `preview.test.ts` holds this
# file to the compose file and to deploy.env's shape.
ORIGINS_ENV_NAME="$(basename "$PREVIEW_ENV")"
cat > "$PREVIEW_ENV" <<ENV
ORIGINS_ENV=${ORIGINS_ENV_NAME}
POSTGRES_PORT=${POSTGRES_PORT}
WEB_PORT=${WEB_PORT}
SITE_URL=http://127.0.0.1:${WEB_PORT}
# scaffold:monorepo
REDIS_PORT=${REDIS_PORT}
API_PORT=${API_PORT}
PUBLIC_API_URL=http://127.0.0.1:${API_PORT}
# scaffold:monorepo
ENV

cd "$REPO_DIR"
echo "· building the images that would ship"
preview_compose build

# Postgres first and alone. Everything else waits on `migrate`, and a restore
# has to land before the migrations do — into a database nothing is connected
# to, since Postgres refuses to drop one that has clients.
echo "· starting the preview database"
preview_compose up -d --wait postgres

if [ -n "$restore" ]; then
  # find, not ls: backup names carry a timestamp, and -printf sorts on mtime
  # without a filename ever reaching the shell as a word.
  latest="$(find "$REPO_DIR/backups" -maxdepth 1 -name '*.sql.gz.age' -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | head -1 | cut -d' ' -f2-)"
  [ -n "$latest" ] || { echo "[preview] no backup in $REPO_DIR/backups — run scripts/backup.sh first" >&2; exit 1; }
  echo "· restoring $(basename "$latest") (this is the restore drill)"
  DOCKER="$DOCKER" scripts/restore-drill.sh \
    --project "$PREVIEW_PROJECT" --archive "$latest" "${drill_key[@]}"
fi

echo "· migrating and booting $PREVIEW_PROJECT"
preview_compose up -d --wait

echo
echo "preview up on http://127.0.0.1:${WEB_PORT}  (project $PREVIEW_PROJECT)"
echo "tear it down with: scripts/preview-down.sh"
