#!/usr/bin/env bash
# Prove a backup is restorable. An untested backup is a hope, not a backup.
#
#   scripts/restore-drill.sh                            # a throwaway beside production
#   scripts/restore-drill.sh --scratch-project <name>   # ...in a stack the drill owns
#   scripts/restore-drill.sh --project <name>           # ...in one the caller already has up
#   scripts/restore-drill.sh --dry-run                  # decide everything, touch nothing
#   scripts/restore-drill.sh --archive <file> --target <db>   # a named copy, kept
#
# The identity is the PRIVATE age key: BACKUP_AGE_KEY in .env, or --key for one
# run. It is on this box because scripts/restore-drill.timer runs this
# unattended — README, "Backups", is what that protects and what it does not.
#
# With no --archive the newest object under this project's own prefix in the
# bucket is pulled — scripts/backup.sh writes there, and the bucket is shared —
# and one older than BACKUP_MAX_AGE_HOURS (36 by default: a nightly cadence plus
# slack) fails the drill. A month-old dump restores perfectly and says nothing
# about the backups that stopped being taken.
#
# WHO OWNS THE STACK is what the flag says, never what the stack's state
# suggests. Inferring it from liveness is the shorter way and the wrong one: a
# failed drill leaves its stack standing, so the next run finds it answering,
# reads that as somebody else's, and a full copy of production sits on the disk
# from then on.
#
#   --scratch-project  the drill's own. Started if it is not answering, and
#                      taken down with its volumes once the drill passes,
#                      whether or not this run was the one that started it. A
#                      FAILED drill leaves it standing, because that copy is the
#                      evidence; the next scratch run's pass is what reclaims
#                      it, and the same pass reclaims one left behind when
#                      TimeoutStartSec killed the unit partway.
#   --project          the caller's. It has to be answering already: the drill
#                      never starts it and never stops it. This is the mode
#                      scripts/preview.sh calls — being filled is the point
#                      there, and the stack is somebody's to look at afterwards.
#
# The two are one question, so naming both is refused, and neither may name the
# deployed project: the lanes that exist are this repo's own, `<project>-<lane>`.
#
# WHERE THE RESTORE LANDS decides what becomes of the database itself, and there
# are four places:
#
#   throwaway  no project flag and no --target: <db>_restore_drill, in the
#              deployed stack's own Postgres. Dropped once the drill passes,
#              because a weekly copy of production kept beside production is a
#              second copy of production. The only database this script deletes.
#   lane       either project flag: that stack's own database, in its own
#              container and on its own volume. Left filled — what happens to it
#              afterwards is the stack's fate above, not the database's.
#   named      --target <db>: yours, kept however the drill turns out.
#   deployed   --target <the deployed database>: production itself, which
#              additionally requires CONFIRM=yes. A drill must never be one typo
#              away from being an outage.
#
# One drill at a time per stack: a second one is refused rather than queued,
# since both would be dropping and recreating the same database under each
# other. The lock sits beside the checkout, because a timer's drill and a hand
# drill have to resolve the same path — and the per-context runtime directories
# they are each given do not.
#
# Every target is folded to lower case before it is compared and refused unless
# it is already lower case, because that is the only shape Postgres stores an
# unquoted identifier in: `--target SHOP` names the database `shop`, and a guard
# that compared the two as bytes read them as different databases.
set -euo pipefail

# shellcheck source=scripts/stack.sh
. "$(dirname "${BASH_SOURCE[0]}")/stack.sh"

# Before anything is decided. The names below are what the guard compares, and
# .env is allowed to set them — read later, it would be deciding what to drop
# after the refusal had already passed on a different name.
load_env_file "$REPO_DIR/.env"

DB_SERVICE="${DB_SERVICE:-postgres}"
DB_USER="${DB_USER:-project_template}"
DB_NAME="${DB_NAME:-project_template}"
MIN_TABLES="${MIN_TABLES:-4}"
# Nightly, plus a night's slack: the drill runs weekly, so anything older than
# this means backups stopped between two of its runs.
BACKUP_MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-36}"
# Where the compose file mounts the pgdata volume, which is the filesystem the
# restore has to fit on.
DB_VOLUME="${DB_VOLUME:-/var/lib/postgresql/data}"

key=""
archive=""
project=""
# none, caller, or drill. Named by the flag in the loop below and read nowhere
# else: every question about the stack — start it? take it down? — is this one
# question, and a second variable holding the same answer is where the two
# drifted apart.
stack_owner=none
target=""
dry_run=no

# The header comment is the help text; printing it from the file keeps the two
# from drifting.
usage() {
  awk 'NR > 1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --key) key="${2:?--key needs an age identity file}"; shift 2 ;;
    --archive) archive="${2:?--archive needs a path}"; shift 2 ;;
    --target) target="${2:?--target needs a database name}"; shift 2 ;;
    --project | --scratch-project)
      if [ "$stack_owner" != none ]; then
        echo "[drill] --project and --scratch-project are the same question — who owns the stack — so name one, not both" >&2
        exit 2
      fi
      case "$1" in
        --project) stack_owner=caller ;;
        --scratch-project) stack_owner=drill ;;
      esac
      project="${2:?$1 needs a compose project name}"
      shift 2
      ;;
    --dry-run) dry_run=yes; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[drill] unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# One home for the path, .env, and a flag that overrides it for one run.
[ -n "$key" ] || key="${BACKUP_AGE_KEY:-}"
[ -n "$key" ] || {
  echo "[drill] no age identity — set BACKUP_AGE_KEY in .env, or pass --key <file>" >&2
  usage >&2
  exit 2
}

# `-p` with the name the compose file already declares is the deployed stack
# under another spelling, and compose resolves a project purely by its label, so
# an unrelated product's stack on the same daemon would answer to it just as
# readily. The lanes that legitimately exist are this project's own
# (`<project>-preview`, `<project>-drill`), so anything else is refused rather
# than reasoned about. The separator is the whole of the rule: on a bare prefix,
# another product's `<project>analytics` reads as a lane of this repo.
if [ "$stack_owner" != none ]; then
  case "$project" in
    "$DEPLOYED_PROJECT")
      echo "[drill] '$project' is the deployed stack, whichever flag names it — a drill restores beside production, never into it under another spelling; a lane is '$DEPLOYED_PROJECT-<lane>'" >&2
      exit 2
      ;;
    "$DEPLOYED_PROJECT"-*) ;;
    *)
      echo "[drill] '$project' is not a lane of this repo: it has to be '$DEPLOYED_PROJECT-<lane>'" >&2
      exit 2
      ;;
  esac
fi

# Which of the four places this is, decided once. Two questions are asked of the
# answer at opposite ends of this script — whether production is about to be
# overwritten, and whether the copy may be deleted afterwards — and a rule
# spelled out twice is a rule that ends up meaning two things.
fold() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

if [ "$stack_owner" != none ]; then
  landing=lane
  [ -n "$target" ] || target="$DB_NAME"
elif [ -z "$target" ]; then
  landing=throwaway
  target="${DB_NAME}_restore_drill"
elif [ "$(fold "$target")" = "$(fold "$DB_NAME")" ]; then
  landing=deployed
else
  landing=named
fi

# The deployed guard first, so a name that IS the deployed database in Postgres's
# eyes is told that rather than told it is malformed.
if [ "$landing" = deployed ] && [ "${CONFIRM:-}" != "yes" ]; then
  echo "[drill] refusing to restore over '$DB_NAME' in the deployed stack ('$DEPLOYED_PROJECT') without CONFIRM=yes" >&2
  exit 2
fi
# The target is interpolated into DROP/CREATE DATABASE as an identifier, so a
# strict allowlist is what stops a crafted value smuggling extra SQL — and lower
# case only, because that is the only shape an unquoted identifier reaches the
# catalogue in. Every statement below quotes it as well, so what is dropped is
# the string that was checked and not a folded relative of it.
if ! [[ "$target" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  echo "[drill] invalid target database name: '$target' — lower case, digits and underscores, since that is what Postgres would store it as" >&2
  exit 2
fi
if [ ! -f "$key" ] && [ "$dry_run" = no ]; then
  echo "[drill] age identity file not found: $key" >&2
  exit 2
fi
if [ -n "$archive" ] && [ ! -f "$archive" ] && [ "$dry_run" = no ]; then
  echo "[drill] archive not found: $archive" >&2
  exit 2
fi

# Everything the real run decides has been decided by now, so this reports the
# same target that would actually be dropped and recreated.
if [ "$dry_run" = yes ]; then
  echo "[drill] arguments valid — would restore ${archive:-<newest archive under $BACKUP_PREFIX>} into '$target' ($landing)"
  exit 0
fi

# Serialised on the stack, which is what two drills would be fighting over: the
# second one's DROP DATABASE lands while the first one's psql is still loading
# into it. Refused rather than queued — the caller is a timer, and a drill that
# waited would still be holding the lock when the next week's came round. The
# descriptor is held for the life of this process, so the lock goes when it does,
# crash included.
#
# Beside the checkout, which is the only home every caller resolves alike: a
# unit, a sudo shell, cron and a login shell all reach $REPO_DIR. The runtime
# directories each of those is given instead are private to each — a unit gets
# no XDG_RUNTIME_DIR at all, and RuntimeDirectory= gives it one of its own
# (both measured) — so a lock kept there is a lock the timer's drill and a hand
# drill cannot both see, and the one collision it exists to stop is exactly
# that one: systemd already refuses to run this unit beside itself (measured).
# Not /tmp either, where the name is predictable and the mode is 1777 and any
# local user could take the lock first and stop the drill for good; a deploy
# checkout belongs to the deploy user.
lock_key="${project:-$DEPLOYED_PROJECT}"
lock_file="$REPO_DIR/.restore-drill.$lock_key.lock"
exec 9>"$lock_file"
if ! flock -n 9; then
  echo "[drill] another drill holds $lock_file — '$lock_key' is being restored into right now" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [ -z "$archive" ]; then
  : "${BACKUP_R2_BUCKET:?set BACKUP_R2_BUCKET in .env}"
  : "${BACKUP_R2_ENDPOINT:?set BACKUP_R2_ENDPOINT in .env}"
  echo "[drill] finding the newest archive under '$BACKUP_PREFIX' in r2://$BACKUP_R2_BUCKET"
  # The bucket does the filtering and the sorting. `aws s3 ls` is the shorter
  # way and the wrong one: its table carries no LastModified to bound an age
  # against, and the last line of an unfiltered listing is whichever product on
  # this shared bucket was backed up most recently. `|| []` because a prefix
  # nothing has been written under yet comes back with no Contents key at all,
  # which sort_by refuses.
  # shellcheck disable=SC2016 # the query is JMESPath; its backticks are that language's literals.
  newest="$(aws s3api list-objects-v2 \
    --bucket "$BACKUP_R2_BUCKET" --prefix "$BACKUP_PREFIX" \
    --endpoint-url "$BACKUP_R2_ENDPOINT" \
    --query 'sort_by(Contents || `[]`, &LastModified)[-1].[Key,LastModified]' \
    --output text)"
  case "$newest" in
    '' | None)
      echo "[drill] nothing under '$BACKUP_PREFIX' in r2://$BACKUP_R2_BUCKET — this stack has never been backed up" >&2
      exit 1
      ;;
  esac
  IFS=$'\t' read -r newest_key newest_modified <<<"$newest"
  # A timestamp this box cannot read is the endpoint answering in a shape the
  # API does not document, and guessing an age from it is how a stale archive
  # gets restored anyway. Captured, because `set -e` would otherwise take the
  # script out before the diagnostic.
  if ! modified_at="$(date -d "$newest_modified" +%s 2>/dev/null)"; then
    echo "[drill] could not read when '$newest_key' was written — got '$newest_modified'" >&2
    exit 1
  fi
  age_hours=$(( ($(date -u +%s) - modified_at) / 3600 ))
  if [ "$age_hours" -gt "$BACKUP_MAX_AGE_HOURS" ]; then
    echo "[drill] the newest archive under '$BACKUP_PREFIX' is ${age_hours}h old and the bound is ${BACKUP_MAX_AGE_HOURS}h — the backups have stopped, and restoring this one would prove nothing about the nights nothing was written" >&2
    exit 1
  fi
  archive="$work/$(basename "$newest_key")"
  aws s3 cp "s3://$BACKUP_R2_BUCKET/$newest_key" "$archive" \
    --endpoint-url "$BACKUP_R2_ENDPOINT" --only-show-errors
fi

compose_args=(-f "$COMPOSE_FILE")
if [ "$stack_owner" != none ]; then compose_args+=(-p "$project"); fi
# Named rather than left to compose's own loading, which reads the .env beside
# whatever the caller's working directory happens to be — and a systemd unit's
# is `/`. Naming any --env-file turns that loading off, so this is the one that
# answers the compose file's interpolation for every command below, `down -v`
# included. Unconditionally: guarding on the file existing hands the missing
# case straight back to the cwd-relative loading this exists to prevent, and
# compose refuses a named file it cannot find, which is the honest answer.
compose_args+=(--env-file "$REPO_DIR/.env")
if [ "$stack_owner" = drill ]; then
  # A port of its own, written to a file rather than exported for the reason
  # scripts/preview.sh writes one: `sudo docker` starts a clean environment, so
  # an exported value would silently fall back to .env's. Second, so it wins.
  printf 'POSTGRES_PORT=%s\n' "${DRILL_POSTGRES_PORT:-5495}" > "$work/drill.env"
  compose_args+=(--env-file "$work/drill.env")
fi
dc() { $DOCKER compose "${compose_args[@]}" exec -T "$DB_SERVICE" "$@"; }

if [ "$stack_owner" != none ] && ! dc pg_isready -U "$DB_USER" -q >/dev/null 2>&1; then
  if [ "$stack_owner" = caller ]; then
    echo "[drill] the '$project' stack is not answering, and --project is the caller's own: this drill neither starts it nor stops it. scripts/preview.sh brings its stack up before it calls here; --scratch-project is the flag for one the drill should own." >&2
    exit 1
  fi
  echo "[drill] starting the '$project' stack's database"
  $DOCKER compose "${compose_args[@]}" up -d --wait "$DB_SERVICE"
fi

# A floor, not an estimate. gzip over pg_dump's plain text runs about 3-5x, and
# what Postgres then writes is at least the size of that text again once pages,
# indexes and TOAST are counted — so four times the archive is a number the
# restore is certain to exceed, not one it is expected to land on. Clearing it
# proves nothing; failing it proves the restore cannot finish, and an hour of
# psql is an expensive way to find that out.
NEEDED_PER_BYTE=4
archive_bytes="$(stat -c %s "$archive")"
needed=$((archive_bytes * NEEDED_PER_BYTE))
# Captured rather than assigned, because `set -e` kills the script on a failing
# command substitution and the diagnostic below never reaches anyone.
if ! free_kb="$(dc df -Pk "$DB_VOLUME" | awk 'NR == 2 { print $4 }')"; then
  echo "[drill] could not ask '$DB_VOLUME' how much room is left" >&2
  exit 1
fi
case "$free_kb" in
  *[!0-9]* | "")
    echo "[drill] could not read the free space on $DB_VOLUME — got '$free_kb'" >&2
    exit 1
    ;;
esac
free_bytes=$((free_kb * 1024))
if [ "$needed" -gt "$free_bytes" ]; then
  echo "[drill] $DB_VOLUME has $free_bytes bytes free and a $archive_bytes-byte archive needs at least $needed — the restore cannot finish" >&2
  exit 1
fi

echo "[drill] (re)creating '$target'"
dc psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$target\";" >/dev/null
dc psql -U "$DB_USER" -d postgres -c "CREATE DATABASE \"$target\" OWNER \"$DB_USER\";" >/dev/null

echo "[drill] restoring $(basename "$archive") into '$target'"
# ON_ERROR_STOP because psql's default is to report an error, carry on with the
# next statement and exit 0: a dump that died a third of the way in restored
# four tables, printed one ERROR nobody reads, and cleared the table floor
# below. -o /dev/null keeps the dump's own SELECT output out of the drill log;
# errors still arrive on stderr.
age --decrypt --identity "$key" "$archive" \
  | gunzip \
  | dc psql -U "$DB_USER" -d "$target" -v ON_ERROR_STOP=1 -q -o /dev/null

tables="$(dc psql -U "$DB_USER" -d "$target" -tAc \
  "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
echo "[drill] restored $tables tables"
if [ "$tables" -lt "$MIN_TABLES" ]; then
  echo "[drill] ERROR: fewer than $MIN_TABLES tables — the backup is not usable" >&2
  exit 1
fi
echo "[drill] PASS"

# Nothing this script owns outlives a pass. The throwaway it named is dropped;
# a stack --scratch-project put in its hands is taken down with its volumes,
# which is how a full copy of production can be restored weekly without one
# sitting on the disk afterwards. A drill that FAILED gets neither: that copy is
# the evidence. A --target somebody named is theirs, and so is a --project
# stack — the drill only ever fills that one.
if [ "$landing" = throwaway ]; then
  echo "[drill] dropping '$target'"
  dc psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$target\";" >/dev/null
fi
if [ "$stack_owner" = drill ]; then
  echo "[drill] taking '$project' down, volumes included"
  $DOCKER compose "${compose_args[@]}" down -v --remove-orphans
fi
