#!/usr/bin/env bash
# Remediation integration runner — disposable loopback infra only
# (er-pg 127.0.0.1:58532, er-redis 127.0.0.1:58479, er-minio 127.0.0.1:59000).
# Runs the API's own integration config (credential scrub + outbound guard + ledger).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
export TEST_DATABASE_URL="postgresql://er:er@127.0.0.1:58532/er_remediation_test"
export RUN_LIVE_INTEGRATION_NO_TESTCONTAINERS=1
export P7_TEST_REDIS_URL="redis://127.0.0.1:58479"
export P7_NETWORK_LEDGER="${P7_NETWORK_LEDGER:-$repo/.p7tmp/remediation-network.jsonl}"
cd "$repo/services/api"
# The canonical integration invoker (package.json test:integration:run) — never the raw runner.
exec pnpm run test:integration:run "$@"
