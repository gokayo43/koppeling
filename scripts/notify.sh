#!/usr/bin/env bash
# Tells the watchdog what became of a scheduled job.
#
#   scripts/notify.sh heartbeat <slug>
#   scripts/notify.sh failure   <slug> [the unit that failed]
#
# The units call this and nothing else does. That is the whole design: a
# heartbeat means THE SCHEDULED RUN happened, and only systemd knows whether a
# run was the scheduled one — a job that reported on itself would let anyone
# rehearsing by hand forge the heartbeat and leave the timer dead with nothing
# to say so. So backup.sh and restore-drill.sh know nothing about any of this;
# `ExecStartPost=` reports the success and `OnFailure=` reports the failure.
#
# Both routes are keyed on the same slug — the failure one 404s on a slug no
# heartbeat has ever declared, so a unit spells its slug once and uses it twice.
#
# Unset HEARTBEAT_URL or HEARTBEAT_TOKEN and this is a no-op, which is what a
# box with no watchdog wants.
set -euo pipefail

# Only the repo's location and the .env parser. NOT scripts/stack.sh: it reads
# the compose file and exits 2 when that file names no project, which would take
# this program out before it could report the failure it was started for.
# shellcheck source=scripts/env-file.sh
. "$(dirname "${BASH_SOURCE[0]}")/env-file.sh"
load_env_file "$REPO_DIR/.env"

route="${1:?heartbeat or failure}"
slug="${2:?the slug the watchdog knows this job by}"
# systemd withholds MONITOR_UNIT when one handler serves several jobs, so an
# absent body is a thing that happens and is not a reason to withhold the
# alert: the slug already says which job, and the body only names the run.
body="${3:-}"

# An allowlist, because the two routes are literals in unit files and a typo in
# one would otherwise be a POST to a path the watchdog answers 404 to — for
# ever, and in silence, since a ping that does not land is not fatal here.
case "$route" in
  heartbeat | failure) ;;
  *)
    echo "[watchdog] '$route' is not a route: heartbeat or failure" >&2
    exit 2
    ;;
esac

[ -n "${HEARTBEAT_URL:-}" ] && [ -n "${HEARTBEAT_TOKEN:-}" ] || exit 0

# --data is a POST on its own; with no body there is nothing to imply the method
# so it is named. Never both.
if [ -n "$body" ]; then method=(--data "$body"); else method=(-X POST); fi

# The token reaches curl on stdin and never as an argument: an -H value sits in
# the process table for the length of the request, where any local user's `ps`
# reads it. `@-` takes the header line as it stands, so no spelling of a token
# needs escaping on the way through. curl 7.55 or newer.
#
# Bounded, because this runs as ExecStartPost= and a watchdog that blackholes
# packets otherwise hangs until the job's own TimeoutStartSec kills it — and
# then systemd fails a unit whose ExecStart succeeded, which pages for a backup
# that worked. Measured: unbounded gives Result=timeout, bounded Result=success
# with the ping swallowed below. Both bounds sit far under either job's start
# timeout.
printf 'authorization: Bearer %s\n' "$HEARTBEAT_TOKEN" \
  | curl -fsS --connect-timeout 10 --max-time 30 -H @- "${method[@]}" "$HEARTBEAT_URL/$route/$slug" \
  || echo "[watchdog] $route/$slug did not reach $HEARTBEAT_URL" >&2
