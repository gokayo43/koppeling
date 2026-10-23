#!/usr/bin/env bash
# Ramp the running preview stack and write down what it held.
#
#   scripts/preview.sh            # the stack this measures — bring it up first
#   scripts/preview-capacity.sh   # the number
#   scripts/preview-capacity.sh --dry-run
#
# This is the capacity measurement testing.md asks for before real users arrive
# and again after a hot-path change: the images that would ship, on the box that
# would run them, behind a real Postgres. CI's ramp is a different thing — a
# shared GitHub runner hosting the app beside a Postgres, a Redis and whatever
# else the job started — and docs/gates/capacity.md in dev-config says so in as
# many words: a trend line against the last run, never a claim about how much
# load the app holds. This is the claim, and `ran-on` below is what makes the
# published table say which of the two it is.
#
# It reaches the preview project's own ports and nothing else, and refuses
# outright when that project is not up. A "capacity ramp" that quietly found the
# deployed stack instead would be a load test against production.
#
# The ramp, the verified k6 fetch and the reader that turns k6's summary into a
# table all come from dev-config, where CI takes them from too — so this number
# and CI's are produced by one script, on one k6, and graded by one set of
# rules, which is what makes them comparable rather than merely similar.
set -euo pipefail

# shellcheck source=scripts/stack.sh
. "$(dirname "${BASH_SOURCE[0]}")/stack.sh"

dry_run=no
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=yes; shift ;;
    *) echo "[capacity] unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ ! -f "$PREVIEW_ENV" ]; then
  echo "[capacity] no $PREVIEW_ENV — bring up the stack this measures first: scripts/preview.sh" >&2
  exit 2
fi
# The ports the preview claimed, which is what `preview_compose` interpolates.
load_env_file "$PREVIEW_ENV"

cd "$REPO_DIR"
if [ -z "$(preview_compose ps --status running --quiet)" ]; then
  echo "[capacity] nothing of '$PREVIEW_PROJECT' is running — scripts/preview.sh brings it up" >&2
  exit 2
fi

# What to ramp is the shipped workflow's answer, not a copy of it: CI already
# names the health route and the paths worth loading, per shape, in the one file
# a scaffolded repo keeps. Reading it here is what makes this number and CI's
# measurements of the same surface.
CI_WORKFLOW="$REPO_DIR/.github/workflows/ci.yml"
if [ ! -f "$CI_WORKFLOW" ]; then
  echo "[capacity] no $CI_WORKFLOW — there is no record of what this repo's CI ramps" >&2
  exit 2
fi

# The port is the app's own, as the workflow names it; the path is the health
# route. Both come back as they are written there.
mapfile -t shipped < <(bun -e '
  const asked = Bun.YAML.parse(await Bun.file(Bun.argv[1]).text()).jobs?.check?.with ?? {};
  const health = new URL(String(asked["health-url"] ?? "http://localhost:3000/api/health"));
  console.log(health.port || (health.protocol === "https:" ? "443" : "80"));
  console.log(health.pathname);
  console.log(String(asked["capacity-path"] ?? "").split(/[,\n]/).map((p) => p.trim()).filter(Boolean).join(", "));
' "$CI_WORKFLOW")

# Where the preview publishes that port. Compose is the authority on its own
# port mapping, so nothing here needs to know which shape this repo is or which
# service serves health — the workflow says which port of the app answers, and
# this says where the preview put it.
# The ${} below are JS template literals, not shell expansions.
# shellcheck disable=SC2016
published="$(preview_compose ps --format json | bun -e '
  const target = Number(Bun.argv[1]);
  const rows = (await Bun.stdin.text())
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => { const parsed = JSON.parse(line); return Array.isArray(parsed) ? parsed : [parsed]; });
  const hit = rows.flatMap((row) => row.Publishers ?? []).find((p) => p.TargetPort === target && p.PublishedPort);
  if (hit === undefined) {
    console.error(`no container of this preview publishes port ${target}`);
    process.exit(1);
  }
  console.log(hit.PublishedPort);
' "${shipped[0]}")"

HEALTH_URL="http://127.0.0.1:${published}${shipped[1]}"
CAPACITY_PATH="${CAPACITY_PATH:-${shipped[2]}}"
export HEALTH_URL CAPACITY_PATH

# Everything about where the load goes has been decided by now, so this reports
# the ramp that would actually run.
if [ "$dry_run" = yes ]; then
  echo "[capacity] would ramp $PREVIEW_PROJECT: $HEALTH_URL plus $CAPACITY_PATH"
  exit 0
fi

if ! curl -sf --connect-timeout 2 --max-time 5 "$HEALTH_URL" > /dev/null; then
  echo "[capacity] $HEALTH_URL did not answer — '$PREVIEW_PROJECT' is up but not serving" >&2
  exit 1
fi

# Installed as a git dependency, so the whole repo is here rather than the few
# config files a registry tarball would carry.
GATES="$REPO_DIR/node_modules/@gokayo43/dev-config/.github/actions"
for tool in "$GATES/_lib/k6.sh" "$GATES/db-gate/capacity.js" "$GATES/db-gate/capacity.main.ts"; do
  if [ ! -f "$tool" ]; then
    echo "[capacity] $tool is missing — run 'bun install'" >&2
    exit 1
  fi
done

# k6 extracts into $RUNNER_TEMP, which is GitHub's name for somewhere to put a
# binary. Off a runner that is this run's own directory, thrown away with the
# binary it holds. The version and its checksum are dev-config's, beside the
# fetch — one pin for this ramp and the one CI runs.
RUNNER_TEMP="$(mktemp -d)"
export RUNNER_TEMP
trap 'rm -rf "$RUNNER_TEMP"' EXIT
# shellcheck source=/dev/null
. "$GATES/_lib/k6.sh"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$REPO_DIR/capacity"
summary="$REPO_DIR/capacity/$stamp.json"
rendered="$REPO_DIR/capacity/$stamp.md"

echo "· ramping $PREVIEW_PROJECT: $HEALTH_URL plus $CAPACITY_PATH"
"$K6" run --quiet \
  --summary-trend-stats='avg,min,med,p(95),p(99),max' \
  --summary-export "$summary" "${CAPACITY_SCRIPT:-$GATES/db-gate/capacity.js}"

# The reader CI uses, so the table has the same columns and "more than a tenth
# of the requests failed" fails here for the same reason it fails there. What
# differs is the sentence under the number, and ran-on is what says so.
INPUT_SUMMARY_FILE="$summary" INPUT_STEP_SUMMARY="$rendered" INPUT_RAN_ON=deployed-shape \
  bun "$GATES/db-gate/capacity.main.ts"

echo
echo "capacity: $rendered  (raw k6 summary: $summary)"
