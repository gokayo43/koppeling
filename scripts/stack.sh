# shellcheck shell=bash
# What every script that talks to the stack starts from: how the docker daemon
# is reached, which compose file, and what the deployed compose project is
# called. Sourced, not run — and it can end the program, so nothing that has to
# report on a failure may source it. Where the repo is and how its .env is read
# come from scripts/env-file.sh, which cannot.
#
# The project name is the one fact that must not be guessed. restore-drill.sh
# refuses to restore over that project's database, so a second name for the same
# stack — a nested `name:` read by mistake, a quoted one that compares unequal,
# a directory compose would have spelled differently, an environment variable
# that outranks the file — is a way around the refusal rather than a cosmetic
# difference. It is also this stack's identity in the backup bucket, below.

# shellcheck source=scripts/env-file.sh
. "$(dirname "${BASH_SOURCE[0]}")/env-file.sh"

DOCKER="${DOCKER:-docker}"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_DIR/docker-compose.yml}"

# Anchored, because an unanchored match also takes the indented `name:` under a
# volume or a network, which compose reads as that resource's name and not the
# project's. Quotes and a trailing CR come off: they are the same name to
# compose and a different string to `=`, which is what the refusal compares.
DEPLOYED_PROJECT="$(awk '/^name:[[:space:]]/ {
  sub(/^name:[[:space:]]+/, "")
  sub(/\r$/, "")
  gsub(/^["'"'"']|["'"'"']$/, "")
  print
  exit
}' "$COMPOSE_FILE")"
if [ -z "$DEPLOYED_PROJECT" ]; then
  echo "[stack] $COMPOSE_FILE declares no top-level 'name:' — the deployed project is named there, not guessed from the directory" >&2
  exit 2
fi

# Where this stack's archives live in the bucket, written by scripts/backup.sh
# and read back by scripts/restore-drill.sh — one string, including its
# separator, so the two cannot disagree about the layout. A bucket is shared
# across the box's stacks, and a drill that read the newest object in the whole
# of one restored whatever was written last, by whichever product.
# shellcheck disable=SC2034 # read by the scripts that source this file, not here.
BACKUP_PREFIX="$DEPLOYED_PROJECT/"

# COMPOSE_PROJECT_NAME outranks the compose file, and .env reaches compose
# through --env-file as well as through this script's own loading. Left alone,
# the stack these scripts checked and the stack they then talked to could be two
# different stacks.
project_name_override() {
  if [ -n "${COMPOSE_PROJECT_NAME:-}" ]; then
    echo "environment"
    return
  fi
  if [ -f "$REPO_DIR/.env" ] && grep -qE '^[[:space:]]*COMPOSE_PROJECT_NAME[[:space:]]*=' "$REPO_DIR/.env"; then
    echo "$REPO_DIR/.env"
    return
  fi
}

override="$(project_name_override)"
if [ -n "$override" ]; then
  echo "[stack] COMPOSE_PROJECT_NAME is set in $override — it outranks '$DEPLOYED_PROJECT' in $COMPOSE_FILE, so these commands cannot know which stack they would reach. Unset it." >&2
  exit 2
fi
unset override

# The same class, one key further in: compose resolves a variable from the
# process environment before any --env-file, and ORIGINS_ENV is the single key
# carrying a preview's origins. Inherited, it hands the preview's containers —
# and, where a web image bakes its API origin in, that browser bundle too — the
# deployed origins while the ports stay the preview's, which is the production
# stack wearing a preview's clothes with nothing in compose's output saying so.
if [ -n "${ORIGINS_ENV:-}" ]; then
  echo "[stack] ORIGINS_ENV is set in the environment — it outranks the origins file these scripts write, so a preview would answer at whatever it names, on the preview's own ports. Unset it." >&2
  exit 2
fi


# The preview stack, named once. Not overridable and not a parameter: an
# inherited PROJECT naming the deployed stack would point `down -v` at
# production's volumes, aim a load generator at production, or restore over it —
# and no caller has a use for another name. `restore-drill.sh` refuses any
# --project that is not the deployed one or `<deployed>-<lane>`, and the
# separator is load-bearing there: without it another product's stack whose name
# merely begins with ours reads as a lane of this repo.
PREVIEW_PROJECT="${DEPLOYED_PROJECT}-preview"
# `<environment>.env`, the shape deploy.env has: a file the containers are handed
# and a checkout never loads. Under a `.env.` name it would be `.env.<mode>` to
# vite, and it is also what the web image's build reads its origins out of —
# which a name .dockerignore keeps out of the build context could not be.
#
# The price is that any image built while a preview exists carries this file:
# every Dockerfile here does `COPY . .`, and nothing reads it there. Paid on
# purpose. Excluding it per Dockerfile works — `Dockerfile.api.dockerignore` is
# honoured, by compose too — but such a file REPLACES `.dockerignore` rather
# than adding to it (both measured), so each one would restate the whole list,
# and a copy that drifted would put `.env`, `backups` and `node_modules` into a
# shipped image. A preview's own ports sitting unread in a layer is the smaller
# of the two.
PREVIEW_ENV="$REPO_DIR/preview.env"

# compose, scoped to that project and reading both env files. The preview's own
# file has to reach compose's interpolation however $DOCKER is spelled — `sudo
# docker` starts a clean environment — so it is passed rather than exported, and
# it comes second so its ports win over the dev ones in .env.
preview_compose() {
  $DOCKER compose --env-file "$REPO_DIR/.env" --env-file "$PREVIEW_ENV" -p "$PREVIEW_PROJECT" "$@"
}
