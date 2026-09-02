#!/usr/bin/env sh
# =============================================================================
# FIND EXACTLY ONE PROOVRA API CONTAINER, OR REFUSE.
# =============================================================================
#
# The handoff previously said "docker ps to find it", which is an instruction to
# guess. On a host running more than one stack — a blue/green pair mid-deploy,
# a leftover from a rollback — guessing selects a container that is not serving
# traffic, and every number the diagnostic then produces describes the wrong
# process.
#
# So this refuses rather than picks. Zero candidates and two candidates are
# both errors, and the second is the dangerous one because it looks like
# success.
#
# STRATEGIES, IN ORDER. The first that yields ANY candidate wins, and its
# result is then required to be unique — a later strategy is never used to
# break a tie, because a tie means the operator has to look.
#
#   1. compose service label `api`
#   2. compose service label `proovra-api`
#   3. container name containing `proovra` and `api`
#
# Exit codes:
#   0  exactly one, printed as: <id> <image> <name> <workdir> <started>
#   1  none found
#   2  more than one — the candidates are listed and nothing is chosen
#
# Usage:
#   API=$(sh find-api-container.sh | awk '{print $1}') || exit 1
# =============================================================================

set -eu

candidates=""
strategy=""

try() {
  found=$(docker ps --filter "$1" --format '{{.ID}}' 2>/dev/null || true)
  if [ -n "$found" ] && [ -z "$candidates" ]; then
    candidates="$found"
    strategy="$2"
  fi
}

try "label=com.docker.compose.service=api" "compose service label 'api'"
try "label=com.docker.compose.service=proovra-api" "compose service label 'proovra-api'"

if [ -z "$candidates" ]; then
  # Name matching is last, and deliberately requires BOTH words: a filter on
  # "api" alone matches any container whose name happens to contain it.
  candidates=$(docker ps --filter "name=proovra" --format '{{.ID}} {{.Names}}' 2>/dev/null \
    | awk '$2 ~ /api/ {print $1}' || true)
  strategy="container name containing 'proovra' and 'api'"
fi

count=$(printf '%s\n' "$candidates" | grep -c . || true)

if [ "$count" -eq 0 ]; then
  echo "REFUSED: no PROOVRA API container is running." >&2
  echo "Tried: compose label 'api', compose label 'proovra-api', name match." >&2
  echo "Run 'docker ps' and identify it by hand before continuing." >&2
  exit 1
fi

if [ "$count" -gt 1 ]; then
  echo "REFUSED: $count candidates matched by $strategy." >&2
  echo "Choosing one automatically could profile a container that is not" >&2
  echo "serving traffic — a blue/green pair mid-deploy looks exactly like this." >&2
  echo "" >&2
  printf '%s\n' "$candidates" | while read -r c; do
    [ -n "$c" ] || continue
    docker inspect --format '  {{.Id}} {{.Config.Image}} {{.Name}} started={{.State.StartedAt}}' "$c" >&2
  done
  echo "" >&2
  echo "Set API=<id> by hand and skip this script." >&2
  exit 2
fi

id="$candidates"

# Everything an operator needs to confirm they profiled the right thing, and to
# say so afterwards in a ticket.
docker inspect --format \
  '{{.Id}} {{.Config.Image}} {{.Name}} workdir={{.Config.WorkingDir}} started={{.State.StartedAt}} revision={{index .Config.Labels "org.opencontainers.image.revision"}}' \
  "$id"
