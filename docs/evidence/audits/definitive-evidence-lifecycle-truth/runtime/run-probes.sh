#!/usr/bin/env bash
# Evidence-Truth audit — runtime probe runner (audit-only).
#
# Requires three DISPOSABLE loopback containers owned by the audit:
#   et-pg    pgvector/pgvector:pg16  127.0.0.1:58432  db et_evidence_truth_test (migrated)
#   et-redis redis:7                  127.0.0.1:58379
#   et-minio minio                    127.0.0.1:59000  (point7-local-minio creds; harness default port)
#
# Every integration probe runs through the API's OWN integration config, so the
# product harness's credential scrub, outbound socket guard and network ledger
# apply unchanged. The ledger is written next to the results and checked by
# tooling/check.mjs (gate 25).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
results="$here/results"
mkdir -p "$results"

export TEST_DATABASE_URL="postgresql://et:et@127.0.0.1:58432/et_evidence_truth_test"
export RUN_LIVE_INTEGRATION_NO_TESTCONTAINERS=1
export P7_TEST_REDIS_URL="redis://127.0.0.1:58379"
export P7_HOST_S3_PORT=59000
export P7_NETWORK_LEDGER="$results/network-ledger.jsonl"
export ET_REDIS_URL="redis://127.0.0.1:58379"

what="${1:-all}"
if [[ "$what" == all || "$what" == tsa ]]; then
  (cd "$repo/services/api" && node_modules/.bin/tsx "$here/probes/tsa.probe.mts" "$results/rt-tsa.json")
fi
if [[ "$what" == all || "$what" == ots ]]; then
  (cd "$repo/services/worker" && node_modules/.bin/tsx "$here/probes/ots-queue.probe.mts" "$results/rt-ots-queue.json")
fi
if [[ "$what" == all || "$what" == integration ]]; then
  (cd "$repo/services/api" && node_modules/.bin/vitest run --config vitest.integration.config.ts --dir "$here/probes" ${2:+-t "$2"})
fi
