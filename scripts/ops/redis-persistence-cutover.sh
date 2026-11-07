#!/usr/bin/env bash
# OPS-020 — move the production Redis onto persistent storage WITHOUT losing a job.
#
# Before this release the `redis` service ran with the image defaults: its data
# lived in the image's anonymous /data volume, snapshotted (RDB) on the default
# schedule, with no AOF and no eviction policy. This release mounts a named
# volume (`redis_data`) with `--appendonly yes --maxmemory-policy noeviction`.
# A new named volume starts EMPTY, so recreating the container naively would
# drop every waiting, delayed, active and retrying BullMQ job and every queue
# counter. An empty Redis is not an acceptable rollout step; this script carries
# the data across and proves it arrived.
#
# It acts on CONTAINERS, so the same steps run on the production host (compose)
# and in the local rehearsal (plain `docker run`, see the runbook):
#
#   snapshot <container>                 key counts for every queue key + DBSIZE (no values)
#   save     <container>                 synchronous SAVE; refuses unless it succeeded just now
#   seed     <old> <new>                 load the old container's dump.rdb into the new (created,
#                                        NOT started) container's /data volume, through a one-off
#                                        seed Redis started WITHOUT AOF, check it, then switch AOF
#                                        on there so the AOF is written from the loaded data
#
# WHY A SEED STEP (found in the 2026-11-07 rehearsal on redis 7.4.11): a Redis
# started with --appendonly yes and no AOF on disk does NOT load dump.rdb. It
# starts empty, creates an empty AOF and then overwrites dump.rdb with an empty
# snapshot. Copying dump.rdb into the new volume and starting the compose
# container (which runs --appendonly yes) therefore loses every job. Loading
# with AOF off and enabling it at runtime (CONFIG SET appendonly yes rewrites
# the AOF from memory) is the supported conversion.
#   verify   <container> <snapshot-file> the new Redis holds every queue key with the same
#                                        length, AOF is on and fully written
#
# Order on the host (docs: release plan, "Redis data preservation"):
#   1. stop proovra-worker (graceful: active jobs finish or are released), then proovra-api
#      — nothing writes to Redis from here on;
#   2. snapshot redis > before.txt ; save redis
#   3. docker compose ... up --no-start redis   (creates the new container + volume; with the
#      new compose file the old container is replaced, so FIRST `docker rename` the old one,
#      e.g. to redis-pre-cutover, and stop it — keep it until step 6 passes)
#   4. snapshot redis-pre-cutover | diff - before.txt   (still identical after the stop)
#      seed redis-pre-cutover <new redis container> before.txt
#   5. docker start <new>; verify <new> before.txt
#   6. docker restart <new>; verify <new> before.txt   (proves the AOF, not only the RDB, holds it)
#   7. start proovra-api, then proovra-worker (deploy-prod-pull.sh does this with the new images)
#   8. only after the release is accepted: docker rm redis-pre-cutover
#
# Rollback before step 7: start redis-pre-cutover again (its anonymous volume is untouched).
#
# Prints counts and key NAMES only, never values. Exits non-zero on any mismatch.
set -euo pipefail

QUEUE_PATTERN="${QUEUE_PATTERN:-bull:*}"

cli() { docker exec "$1" redis-cli --no-auth-warning "${@:2}"; }

snapshot() {
  local c="$1"
  # One exec, the loop runs inside the container (one round trip, not two per key).
  # SCAN, never KEYS: bounded work per call on a live server.
  docker exec -e P="$QUEUE_PATTERN" "$c" sh -c '
    echo "DBSIZE $(redis-cli --no-auth-warning DBSIZE)"
    redis-cli --no-auth-warning --scan --pattern "$P" | LC_ALL=C sort | while IFS= read -r key; do
      type=$(redis-cli --no-auth-warning TYPE "$key")
      case "$type" in
        list) len=$(redis-cli --no-auth-warning LLEN "$key") ;;
        zset) len=$(redis-cli --no-auth-warning ZCARD "$key") ;;
        set) len=$(redis-cli --no-auth-warning SCARD "$key") ;;
        hash) len=$(redis-cli --no-auth-warning HLEN "$key") ;;
        stream) len=$(redis-cli --no-auth-warning XLEN "$key") ;;
        string) len=$(redis-cli --no-auth-warning STRLEN "$key") ;;
        *) len="?" ;;
      esac
      printf "%s %s %s
" "$type" "$len" "$key"
    done'
}

save() {
  local c="$1" before after status
  before="$(cli "$c" LASTSAVE)"
  sleep 1
  [ "$(cli "$c" SAVE)" = "OK" ] || { echo "SAVE did not answer OK" >&2; exit 1; }
  after="$(cli "$c" LASTSAVE)"
  status="$(cli "$c" INFO persistence | tr -d '\r' | awk -F: '$1=="rdb_last_bgsave_status"{print $2}')"
  if [ "$after" -le "$before" ]; then echo "LASTSAVE did not advance ($before -> $after)" >&2; exit 1; fi
  echo "saved at $after (last background save status: ${status:-n/a})"
}

seed() {
  local old="$1" new="$2" expected="$3" tmp vol seedc="redis-cutover-seed-$$" actual
  if [ "$(docker inspect -f '{{.State.Running}}' "$new")" = "true" ]; then
    echo "refusing: $new is running; create it with --no-start and seed before it starts" >&2
    exit 1
  fi
  vol="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$new")"
  [ -n "$vol" ] || { echo "$new has no /data volume" >&2; exit 1; }
  tmp="$(mktemp -d)"
  docker cp "$old:/data/dump.rdb" "$tmp/dump.rdb"
  [ -s "$tmp/dump.rdb" ] || { echo "the old container has no dump.rdb" >&2; rm -rf "$tmp"; exit 1; }
  # The new volume must not already hold an AOF (it would win over the RDB).
  if docker run --rm -v "$vol:/data" redis:7-alpine sh -c 'test -e /data/appendonlydir'; then
    echo "refusing: volume $vol already has an appendonlydir" >&2; rm -rf "$tmp"; exit 1
  fi
  docker create --name "$seedc" -v "$vol:/data" "$(docker inspect -f '{{.Config.Image}}' "$new")"     redis-server --appendonly no --maxmemory-policy noeviction >/dev/null
  docker cp "$tmp/dump.rdb" "$seedc:/data/dump.rdb"
  rm -rf "$tmp"
  docker start "$seedc" >/dev/null
  for _ in $(seq 1 30); do [ "$(cli "$seedc" PING 2>/dev/null || true)" = "PONG" ] && break; sleep 1; done
  actual="$(mktemp)"
  snapshot "$seedc" >"$actual"
  if ! diff <(grep -v '^DBSIZE' "$expected") <(grep -v '^DBSIZE' "$actual") >/dev/null; then
    echo "the seed Redis did not load the same queue keys; nothing was started on the new container" >&2
    docker rm -f "$seedc" >/dev/null; rm -f "$actual"; exit 1
  fi
  rm -f "$actual"
  [ "$(cli "$seedc" CONFIG SET appendonly yes)" = "OK" ] || { echo "CONFIG SET appendonly failed" >&2; exit 1; }
  for _ in $(seq 1 120); do
    local st
    st="$(cli "$seedc" INFO persistence | tr -d '')"
    if echo "$st" | grep -q '^aof_rewrite_in_progress:0' && echo "$st" | grep -q '^aof_rewrite_scheduled:0'        && echo "$st" | grep -q '^aof_last_bgrewrite_status:ok' && echo "$st" | grep -q '^aof_enabled:1'; then
      break
    fi
    sleep 1
  done
  cli "$seedc" SHUTDOWN >/dev/null 2>&1 || true
  docker wait "$seedc" >/dev/null
  docker rm "$seedc" >/dev/null
  docker run --rm -v "$vol:/data" redis:7-alpine sh -c 'test -s /data/appendonlydir/appendonly.aof.manifest'     || { echo "no AOF manifest was written to $vol" >&2; exit 1; }
  echo "seeded $vol: queue keys loaded and an AOF written from them"
}

verify() {
  local c="$1" expected="$2" actual aof rewriting
  for _ in $(seq 1 30); do
    [ "$(cli "$c" PING 2>/dev/null || true)" = "PONG" ] && break
    sleep 1
  done
  actual="$(mktemp)"
  snapshot "$c" >"$actual"
  # Queue keys must match exactly (type, length, name). DBSIZE may only differ by
  # keys outside the queue pattern that expired in between (rate-limit windows).
  if ! diff <(grep -v '^DBSIZE' "$expected") <(grep -v '^DBSIZE' "$actual"); then
    echo "QUEUE KEYS DIFFER (expected < > actual)" >&2
    rm -f "$actual"
    exit 1
  fi
  aof="$(cli "$c" CONFIG GET appendonly | tail -1)"
  [ "$aof" = "yes" ] || { echo "appendonly is '$aof', not yes" >&2; rm -f "$actual"; exit 1; }
  for _ in $(seq 1 60); do
    rewriting="$(cli "$c" INFO persistence | tr -d '\r' | awk -F: '$1=="aof_rewrite_in_progress"{print $2}')"
    [ "$rewriting" = "0" ] && break
    sleep 1
  done
  [ "$rewriting" = "0" ] || { echo "AOF rewrite still in progress" >&2; rm -f "$actual"; exit 1; }
  echo "verified: $(grep -vc '^DBSIZE' "$actual") queue keys identical; $(head -1 "$expected") before, $(head -1 "$actual") now; AOF on and written"
  rm -f "$actual"
}

cmd="${1:-}"
case "$cmd" in
  snapshot) snapshot "${2:?container}" ;;
  save) save "${2:?container}" ;;
  seed) seed "${2:?old container}" "${3:?new container}" "${4:?snapshot file}" ;;
  verify) verify "${2:?container}" "${3:?snapshot file}" ;;
  *)
    sed -n '2,40p' "$0"
    exit 2
    ;;
esac
