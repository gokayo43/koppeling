# shellcheck shell=bash
# Where the repo is, and how to read its .env. Sourced, and nothing else:
# no daemon, no compose file, no guard that can end the program. That is the
# whole point of it being its own file — scripts/notify.sh runs when a job has
# already failed, and a stack guard exiting 2 underneath it would swallow the
# alert that something went wrong.
#
# REPO_DIR comes off this file's own location rather than the caller's, so it
# is the same answer however deep the sourcing goes.

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Reads a .env the way compose does: KEY=VALUE lines, optional surrounding
# quotes, no expansion and no execution.
#
# `. file` under `set -a` is the alternative, and it hands bash a file full of
# secrets to EXECUTE — a password holding `$(...)`, a backtick or even a space
# is a command, and the one file guaranteed to hold awkward characters is this
# one.
load_env_file() {
  local file="$1" line key value
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      ''|'#'*) continue ;;
      *=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    key="${key#export }"
    case "$key" in
      ''|*[!A-Za-z0-9_]*) continue ;;
    esac
    # Only a matched pair comes off; a quote inside the value is part of it.
    case "$value" in
      \"*\") value="${value#\"}"; value="${value%\"}" ;;
      \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac
    export "$key=$value"
  done < "$file"
}
