#!/usr/bin/env bash
#
# PHASE 6 — Integrations platform staging verification.
#
# Runs the 14 numbered steps from
# docs/integrations/STAGING_VERIFICATION_CLOSURE.md in sequence.
# Stops on first failure with a clear message. Exit 0 on success,
# non-zero otherwise.
#
# Required environment variables:
#   STAGING_API_BASE         e.g. https://api.staging.proovra.app
#   STAGING_ADMIN_TOKEN      Bearer JWT for an OWNER/ADMIN session
#   STAGING_TEAM_ID          workspace UUID under test
#   INTEGRATION_CRON_SECRET  cron header value (>= 16 chars)
#   TEST_WEBHOOK_URL         public HTTPS URL of the test receiver
#
# Optional:
#   STEP_UP_HELPER           "env" | "file:<path>" | "todo" (default)
#   STEP_UP_TOKEN            used when STEP_UP_HELPER=env
#
# Hard rules baked into the script:
#   - Raw secrets are NEVER printed in full. The script masks
#     rawKey / rawSecret / Authorization to first 12 chars.
#   - Step-up tokens are masked the same way.
#   - On any non-2xx response from a step, the script prints the
#     body (with secret-mask applied) and exits non-zero.
#   - No request body or response body is appended to durable log
#     output — only HTTP status + the named fields the step
#     records.

set -uo pipefail

# ---------------------------------------------------------------------------
# 0. Pretty output + helpers
# ---------------------------------------------------------------------------

# Avoid bashisms that ShellCheck flags as portability problems.
# This script assumes bash >= 4.

cBold=$'\033[1m'
cDim=$'\033[2m'
cRed=$'\033[31m'
cGrn=$'\033[32m'
cYel=$'\033[33m'
cBlu=$'\033[34m'
cRst=$'\033[0m'

step() {
    printf '\n%s== STEP %s — %s%s\n' "${cBold}${cBlu}" "$1" "$2" "${cRst}"
}

ok() {
    printf '   %sOK%s %s\n' "${cGrn}" "${cRst}" "$1"
}

note() {
    printf '   %s.. %s%s\n' "${cDim}" "$1" "${cRst}"
}

die() {
    printf '\n%sFAIL%s %s\n' "${cRed}" "${cRst}" "$1" >&2
    exit 1
}

mask12() {
    # Print only the first 12 chars of stdin, followed by an ellipsis
    # when the input is longer. Never echoes the rest.
    local raw
    raw="$(cat)"
    if [ -z "$raw" ]; then
        printf '<empty>'
    elif [ "${#raw}" -le 12 ]; then
        # Even short values are masked beyond 4 chars so a 16-char
        # placeholder can't be visually compared.
        printf '%s' "${raw:0:4}…"
    else
        printf '%s…' "${raw:0:12}"
    fi
}

require_env() {
    local name="$1"
    if [ -z "${!name:-}" ]; then
        die "Missing required env var: $name"
    fi
}

# Wrap curl so every call is silent-but-verbose-on-error, writes the
# response body to a tmpfile, and yields the HTTP status on stdout.
# Usage:
#   http_call STATUS_VAR BODY_FILE_VAR METHOD URL [-- header pairs...]
# Trailing positional args after `--` are appended verbatim to curl
# (use them for -H and -d).
http_call() {
    local _status_var="$1"; shift
    local _body_var="$1"; shift
    local _method="$1"; shift
    local _url="$1"; shift
    local _body_tmp
    _body_tmp="$(mktemp)"
    local _status
    _status="$(curl -sS -o "${_body_tmp}" -w '%{http_code}' \
        -X "${_method}" \
        --connect-timeout 10 \
        --max-time 30 \
        "$@" \
        "${_url}")" || {
        rm -f "${_body_tmp}"
        die "curl failed against ${_url}"
    }
    printf -v "${_status_var}" '%s' "${_status}"
    printf -v "${_body_var}" '%s' "${_body_tmp}"
}

# Pluck a JSON field with `jq`. Falls back to a clear error if jq is
# missing — we deliberately do NOT roll a regex parser.
require_jq() {
    command -v jq >/dev/null 2>&1 || die "jq is required (apt install jq / brew install jq)"
}

jget() {
    # jget FILE FILTER -> stdout
    jq -er "$2" "$1" 2>/dev/null || die "jq could not extract '$2' from response"
}

jget_or_null() {
    # Returns the value or the literal string "null" if absent.
    jq -r "$2 // \"null\"" "$1" 2>/dev/null
}

print_response_summary() {
    # Print a bounded preview of the response body with raw secret
    # masking applied. Used only on the failure path.
    local _file="$1"
    if [ ! -s "${_file}" ]; then
        printf '   (empty response body)\n'
        return
    fi
    # Mask any rawKey / rawSecret / pwk_v... / 64-hex-char tokens.
    sed -E \
        -e 's/("rawKey"[[:space:]]*:[[:space:]]*")[^"]+(")/\1<masked>\2/g' \
        -e 's/("rawSecret"[[:space:]]*:[[:space:]]*")[^"]+(")/\1<masked>\2/g' \
        -e 's/(pwk_v[0-9]+_)[A-Za-z0-9_-]{4,}/\1<masked>/g' \
        -e 's/("keyHash"[[:space:]]*:[[:space:]]*")[^"]+(")/\1<masked>\2/g' \
        -e 's/("previousKeyHash"[[:space:]]*:[[:space:]]*")[^"]+(")/\1<masked>\2/g' \
        "${_file}" | head -c 2000
    printf '\n'
}

# ---------------------------------------------------------------------------
# 1. Validate environment
# ---------------------------------------------------------------------------

require_jq

require_env STAGING_API_BASE
require_env STAGING_ADMIN_TOKEN
require_env STAGING_TEAM_ID
require_env INTEGRATION_CRON_SECRET
require_env TEST_WEBHOOK_URL

STEP_UP_HELPER="${STEP_UP_HELPER:-todo}"

printf '%sIntegrations staging verification%s\n' "${cBold}" "${cRst}"
printf '  STAGING_API_BASE        = %s\n' "${STAGING_API_BASE}"
printf '  STAGING_TEAM_ID         = %s\n' "${STAGING_TEAM_ID}"
printf '  TEST_WEBHOOK_URL        = %s\n' "${TEST_WEBHOOK_URL}"
printf '  STEP_UP_HELPER          = %s\n' "${STEP_UP_HELPER}"
printf '  STAGING_ADMIN_TOKEN     = %s\n' "$(printf '%s' "${STAGING_ADMIN_TOKEN}" | mask12)"
printf '  INTEGRATION_CRON_SECRET = %s\n' "$(printf '%s' "${INTEGRATION_CRON_SECRET}" | mask12)"

# ---------------------------------------------------------------------------
# Step-up helper
# ---------------------------------------------------------------------------
# Returns the token via stdout, or empty string if the helper has no
# token to offer. Step handlers that REQUIRE step-up call
# `assert_step_up_or_pause <PURPOSE>` first; that aborts the run with
# instructions when the helper is `todo`.

step_up_token() {
    case "${STEP_UP_HELPER}" in
        env)
            printf '%s' "${STEP_UP_TOKEN:-}"
            ;;
        file:*)
            local _path="${STEP_UP_HELPER#file:}"
            if [ -r "${_path}" ]; then
                # Trim a single trailing newline.
                tr -d '\n' < "${_path}"
            fi
            ;;
        todo|*)
            printf ''
            ;;
    esac
}

assert_step_up_or_pause() {
    local purpose="$1"
    local tok
    tok="$(step_up_token)"
    if [ -z "${tok}" ]; then
        if [ "${STEP_UP_HELPER}" = "todo" ]; then
            printf '\n%sSTEP-UP REQUIRED%s purpose=%s\n' "${cYel}" "${cRst}" "${purpose}" >&2
            printf '   Issue a step-up token for this purpose, re-run with\n' >&2
            printf '   STEP_UP_HELPER=env STEP_UP_TOKEN=<token> ./scripts/verify-integrations-staging.sh\n' >&2
            die "Step-up token unavailable for purpose=${purpose}"
        fi
        die "STEP_UP_HELPER=${STEP_UP_HELPER} produced no token for purpose=${purpose}"
    fi
    printf '%s' "${tok}"
}

# Common header sets.
auth_header() {
    printf 'Authorization: Bearer %s' "${STAGING_ADMIN_TOKEN}"
}
step_up_header() {
    local tok
    tok="$(assert_step_up_or_pause "$1")"
    printf 'x-proovra-step-up-token: %s' "${tok}"
}
cron_header() {
    printf 'x-proovra-integration-cron-secret: %s' "${INTEGRATION_CRON_SECRET}"
}

expect_status() {
    local got="$1"
    local want="$2"
    local body_file="$3"
    local label="$4"
    if [ "${got}" != "${want}" ]; then
        printf '\n%sHTTP %s (expected %s) at %s%s\n' \
            "${cRed}" "${got}" "${want}" "${label}" "${cRst}" >&2
        print_response_summary "${body_file}" >&2
        rm -f "${body_file}"
        exit 1
    fi
}

# ---------------------------------------------------------------------------
# Step 1 — Diagnostics
# ---------------------------------------------------------------------------

step 1 "GET /v1/integrations/diagnostics"
S=""
B=""
http_call S B GET \
    "${STAGING_API_BASE}/v1/integrations/diagnostics?teamId=${STAGING_TEAM_ID}" \
    -H "$(auth_header)"
expect_status "$S" "200" "$B" "diagnostics"

DIAG_ENABLED="$(jget "$B" '.diagnostics.enabled')"
DIAG_API_BOUND="$(jget "$B" '.diagnostics.apiKeySecretBound')"
DIAG_API_LEN="$(jget "$B" '.diagnostics.apiKeySecretLengthValid')"
DIAG_CRON_BOUND="$(jget "$B" '.diagnostics.cronSecretBound')"
DIAG_REASON="$(jget_or_null "$B" '.diagnostics.reason')"
rm -f "$B"

[ "${DIAG_ENABLED}" = "true" ]    || die "diagnostics.enabled is ${DIAG_ENABLED}; integrations disabled (reason=${DIAG_REASON})"
[ "${DIAG_API_BOUND}" = "true" ]  || die "diagnostics.apiKeySecretBound is false"
[ "${DIAG_API_LEN}" = "true" ]    || die "diagnostics.apiKeySecretLengthValid is false"
[ "${DIAG_CRON_BOUND}" = "true" ] || die "diagnostics.cronSecretBound is false"
[ "${DIAG_REASON}" = "null" ]     || die "diagnostics.reason is non-null: ${DIAG_REASON}"
ok "diagnostics enabled, all secrets bound, reason null"

# ---------------------------------------------------------------------------
# Step 2 — Health snapshot baseline
# ---------------------------------------------------------------------------

step 2 "GET /v1/integrations/health"
http_call S B GET \
    "${STAGING_API_BASE}/v1/integrations/health?teamId=${STAGING_TEAM_ID}" \
    -H "$(auth_header)"
expect_status "$S" "200" "$B" "health"

BASELINE_ACTIVE_API_KEYS="$(jget "$B" '.health.activeApiKeys')"
BASELINE_ACTIVE_WEBHOOKS="$(jget "$B" '.health.activeWebhooks')"
BASELINE_DELIVERIES_24H="$(jget "$B" '.health.deliveriesLast24h')"
HEALTH_AVG_LATENCY="$(jget_or_null "$B" '.health.averageLatencyMsLast24h')"
HEALTH_WINDOW="$(jget "$B" '.health.windowHours')"
rm -f "$B"

[ "${HEALTH_WINDOW}" = "24" ] || die "health.windowHours is ${HEALTH_WINDOW}; expected 24"
# Forbidden: average == 0 while deliveries == 0 (must be null).
if [ "${BASELINE_DELIVERIES_24H}" = "0" ] && [ "${HEALTH_AVG_LATENCY}" = "0" ]; then
    die "health.averageLatencyMsLast24h is 0 with no deliveries; expected null"
fi
ok "health baseline: activeApiKeys=${BASELINE_ACTIVE_API_KEYS} activeWebhooks=${BASELINE_ACTIVE_WEBHOOKS} deliveries24h=${BASELINE_DELIVERIES_24H} avgLatency=${HEALTH_AVG_LATENCY}"

# ---------------------------------------------------------------------------
# Step 3 — List API keys
# ---------------------------------------------------------------------------

step 3 "GET /v1/integrations/api-keys"
http_call S B GET \
    "${STAGING_API_BASE}/v1/integrations/api-keys?teamId=${STAGING_TEAM_ID}" \
    -H "$(auth_header)"
expect_status "$S" "200" "$B" "api-keys list"

BASELINE_API_KEY_COUNT="$(jq -r '.apiKeys | length' "$B")"
# Hard assertion: no secret-shaped fields ever appear in the list projection.
if jq -e '.apiKeys[] | (.rawKey? // .keyHash? // .previousKeyHash?)' "$B" >/dev/null 2>&1; then
    die "apiKeys list projection includes rawKey/keyHash/previousKeyHash"
fi
rm -f "$B"
ok "api-key list returned ${BASELINE_API_KEY_COUNT} keys; no secret-shaped fields"

# ---------------------------------------------------------------------------
# Step 4 — Create API key (step-up gated)
# ---------------------------------------------------------------------------

step 4 "POST /v1/integrations/api-keys (step-up: INTEGRATION_API_KEY_CREATE)"
TS_TAG="$(date -u +%Y%m%dT%H%M%SZ)"
CREATE_BODY="$(jq -nc \
    --arg teamId "${STAGING_TEAM_ID}" \
    --arg name "phase6-verify-${TS_TAG}" \
    '{teamId:$teamId, name:$name, scopes:["integration.evidence.read"]}')"

http_call S B POST \
    "${STAGING_API_BASE}/v1/integrations/api-keys" \
    -H "$(auth_header)" \
    -H "$(step_up_header INTEGRATION_API_KEY_CREATE)" \
    -H "content-type: application/json" \
    --data-raw "${CREATE_BODY}"
expect_status "$S" "201" "$B" "api-keys create"

API_KEY_ID="$(jget "$B" '.apiKey.id')"
API_KEY_PREFIX="$(jget "$B" '.apiKey.keyPrefix')"
API_KEY_STATUS="$(jget "$B" '.apiKey.status')"
RAW_KEY="$(jget "$B" '.rawKey')"
# Hard assertion: response MUST NOT include hash material.
if jq -e '(.apiKey.keyHash // .apiKey.previousKeyHash // .keyHash // .previousKeyHash)' "$B" >/dev/null 2>&1; then
    die "api-keys create response includes a hash field"
fi
rm -f "$B"

[ "${API_KEY_STATUS}" = "ACTIVE" ] || die "new API key status is ${API_KEY_STATUS}"
case "${API_KEY_PREFIX}" in
    pwk_v*) : ;;
    *) die "API key prefix has wrong shape: ${API_KEY_PREFIX}" ;;
esac
RAW_KEY_MASK="$(printf '%s' "${RAW_KEY}" | mask12)"
ok "created apiKey id=${API_KEY_ID} prefix=${API_KEY_PREFIX} rawKey=${RAW_KEY_MASK}"

# ---------------------------------------------------------------------------
# Step 5 — Public API self-test
# ---------------------------------------------------------------------------

step 5 "GET /v1/integrations/api/evidence (bearer = rawKey)"
http_call S B GET \
    "${STAGING_API_BASE}/v1/integrations/api/evidence?limit=1" \
    -H "Authorization: Bearer ${RAW_KEY}"
expect_status "$S" "200" "$B" "public API evidence list"
EV_COUNT="$(jq -r '.evidence | length' "$B")"
rm -f "$B"
ok "public API accepted the new rawKey (returned ${EV_COUNT} evidence rows)"

# ---------------------------------------------------------------------------
# Step 6 — Create webhook endpoint (step-up gated)
# ---------------------------------------------------------------------------

step 6 "POST /v1/integrations/webhooks (step-up: INTEGRATION_WEBHOOK_CREATE)"
WH_BODY="$(jq -nc \
    --arg teamId "${STAGING_TEAM_ID}" \
    --arg url "${TEST_WEBHOOK_URL}" \
    --arg desc "phase6-verify-${TS_TAG}" \
    '{teamId:$teamId, url:$url, description:$desc, eventTypes:["evidence.completed"]}')"

http_call S B POST \
    "${STAGING_API_BASE}/v1/integrations/webhooks" \
    -H "$(auth_header)" \
    -H "$(step_up_header INTEGRATION_WEBHOOK_CREATE)" \
    -H "content-type: application/json" \
    --data-raw "${WH_BODY}"
expect_status "$S" "201" "$B" "webhooks create"

WEBHOOK_ID="$(jget "$B" '.webhook.id')"
WEBHOOK_SECRET_PREFIX="$(jget "$B" '.webhook.secretPrefix')"
WEBHOOK_STATUS="$(jget "$B" '.webhook.status')"
RAW_SECRET="$(jget "$B" '.rawSecret')"
PREV_SECRET_PREFIX_NULL="$(jget_or_null "$B" '.webhook.previousSecretPrefix')"
# Hard assertion: response MUST NOT include ciphertext material.
if jq -e '(.webhook.secretCiphertext // .webhook.previousSecretCiphertext // .secretCiphertext // .previousSecretCiphertext)' "$B" >/dev/null 2>&1; then
    die "webhooks create response includes a ciphertext field"
fi
rm -f "$B"

[ "${WEBHOOK_STATUS}" = "ACTIVE" ] || die "new webhook status is ${WEBHOOK_STATUS}"
[ "${PREV_SECRET_PREFIX_NULL}" = "null" ] || die "new webhook previousSecretPrefix is non-null: ${PREV_SECRET_PREFIX_NULL}"
RAW_SECRET_MASK="$(printf '%s' "${RAW_SECRET}" | mask12)"
ok "created webhook id=${WEBHOOK_ID} secretPrefix=${WEBHOOK_SECRET_PREFIX} rawSecret=${RAW_SECRET_MASK}"

# ---------------------------------------------------------------------------
# Step 7 — Send a test event (step-up gated)
# ---------------------------------------------------------------------------

step 7 "POST /v1/integrations/webhooks/${WEBHOOK_ID}/test (step-up: INTEGRATION_WEBHOOK_TEST)"
TEST_BODY="$(jq -nc \
    --arg teamId "${STAGING_TEAM_ID}" \
    '{teamId:$teamId, payload:{marker:"phase6-verify"}}')"

http_call S B POST \
    "${STAGING_API_BASE}/v1/integrations/webhooks/${WEBHOOK_ID}/test" \
    -H "$(auth_header)" \
    -H "$(step_up_header INTEGRATION_WEBHOOK_TEST)" \
    -H "content-type: application/json" \
    --data-raw "${TEST_BODY}"
expect_status "$S" "202" "$B" "webhook test send"

TEST_DELIVERY_ID="$(jget "$B" '.deliveryId')"
TEST_EVENT_ID="$(jget "$B" '.eventId')"
rm -f "$B"
ok "queued test event deliveryId=${TEST_DELIVERY_ID} eventId=${TEST_EVENT_ID}"

# ---------------------------------------------------------------------------
# Step 8 — Verify delivery landed
# ---------------------------------------------------------------------------

step 8 "GET /v1/integrations/webhook-deliveries/${TEST_DELIVERY_ID} (poll until terminal)"
DELIVERY_STATUS=""
DELIVERY_RESP_STATUS=""
DELIVERY_DURATION="null"
ATTEMPTS=0
MAX_POLLS=15  # ~30s at 2s each
while [ "${ATTEMPTS}" -lt "${MAX_POLLS}" ]; do
    http_call S B GET \
        "${STAGING_API_BASE}/v1/integrations/webhook-deliveries/${TEST_DELIVERY_ID}?teamId=${STAGING_TEAM_ID}" \
        -H "$(auth_header)"
    expect_status "$S" "200" "$B" "delivery fetch"
    DELIVERY_STATUS="$(jget "$B" '.delivery.status')"
    DELIVERY_RESP_STATUS="$(jget_or_null "$B" '.delivery.responseStatus')"
    DELIVERY_DURATION="$(jget_or_null "$B" '.delivery.responseDurationMs')"
    rm -f "$B"
    case "${DELIVERY_STATUS}" in
        SENT|FAILED|CANCELLED) break ;;
    esac
    note "status=${DELIVERY_STATUS}; polling…"
    sleep 2
    ATTEMPTS=$((ATTEMPTS + 1))
done

[ "${DELIVERY_STATUS}" = "SENT" ] \
    || die "delivery did not land within 30s: status=${DELIVERY_STATUS} responseStatus=${DELIVERY_RESP_STATUS}"
case "${DELIVERY_RESP_STATUS}" in
    200|201|202|204) : ;;
    *) die "delivery landed but responseStatus is ${DELIVERY_RESP_STATUS}" ;;
esac
ok "delivery SENT responseStatus=${DELIVERY_RESP_STATUS} responseDurationMs=${DELIVERY_DURATION}"

# ---------------------------------------------------------------------------
# Step 9 — List deliveries for the endpoint
# ---------------------------------------------------------------------------

step 9 "GET /v1/integrations/webhooks/${WEBHOOK_ID}/deliveries"
http_call S B GET \
    "${STAGING_API_BASE}/v1/integrations/webhooks/${WEBHOOK_ID}/deliveries?teamId=${STAGING_TEAM_ID}&limit=10" \
    -H "$(auth_header)"
expect_status "$S" "200" "$B" "deliveries list"

DELIVERY_COUNT="$(jq -r '.deliveries | length' "$B")"
# Hard assertion: no row exposes payloadJson (it's deliberately
# projected away by projectIntegrationDelivery).
if jq -e '.deliveries[] | .payloadJson?' "$B" >/dev/null 2>&1; then
    die "deliveries list projection includes payloadJson"
fi
rm -f "$B"
[ "${DELIVERY_COUNT}" -ge 1 ] || die "deliveries list is empty after sending a test event"
ok "deliveries list contains ${DELIVERY_COUNT} row(s); payloadJson not projected"

# ---------------------------------------------------------------------------
# Step 10 — Rotate webhook secret (step-up gated)
# ---------------------------------------------------------------------------

step 10 "POST /v1/integrations/webhooks/${WEBHOOK_ID}/rotate-secret (step-up: INTEGRATION_WEBHOOK_SECRET_ROTATE)"
ROT_BODY="$(jq -nc \
    --arg teamId "${STAGING_TEAM_ID}" \
    '{teamId:$teamId, graceMinutes:10}')"
http_call S B POST \
    "${STAGING_API_BASE}/v1/integrations/webhooks/${WEBHOOK_ID}/rotate-secret" \
    -H "$(auth_header)" \
    -H "$(step_up_header INTEGRATION_WEBHOOK_SECRET_ROTATE)" \
    -H "content-type: application/json" \
    --data-raw "${ROT_BODY}"
expect_status "$S" "200" "$B" "webhook rotate-secret"

NEW_WEBHOOK_SECRET_PREFIX="$(jget "$B" '.webhook.secretPrefix')"
ROTATED_PREV_PREFIX="$(jget "$B" '.previousSecretPrefix')"
PREV_VALID_UNTIL="$(jget "$B" '.previousSecretValidUntilUtc')"
ROT_RAW_SECRET="$(jget "$B" '.rawSecret')"
rm -f "$B"

[ "${NEW_WEBHOOK_SECRET_PREFIX}" != "${WEBHOOK_SECRET_PREFIX}" ] \
    || die "secret rotation did not change the prefix"
[ "${ROTATED_PREV_PREFIX}" = "${WEBHOOK_SECRET_PREFIX}" ] \
    || die "previousSecretPrefix=${ROTATED_PREV_PREFIX} != old prefix=${WEBHOOK_SECRET_PREFIX}"
ROT_SECRET_MASK="$(printf '%s' "${ROT_RAW_SECRET}" | mask12)"
ok "rotated secret newPrefix=${NEW_WEBHOOK_SECRET_PREFIX} prevPrefix=${ROTATED_PREV_PREFIX} validUntil=${PREV_VALID_UNTIL} rawSecret=${ROT_SECRET_MASK}"

# Trigger a second test event so the receiver sees the dual-signature
# header during the grace window.
note "Sending a second test event so the receiver can observe v1=<new>,v1=<old> signature"
TEST_BODY2="$(jq -nc \
    --arg teamId "${STAGING_TEAM_ID}" \
    '{teamId:$teamId, payload:{marker:"phase6-verify-rotated"}}')"
http_call S B POST \
    "${STAGING_API_BASE}/v1/integrations/webhooks/${WEBHOOK_ID}/test" \
    -H "$(auth_header)" \
    -H "$(step_up_header INTEGRATION_WEBHOOK_TEST)" \
    -H "content-type: application/json" \
    --data-raw "${TEST_BODY2}"
expect_status "$S" "202" "$B" "second webhook test send"
DUAL_DELIVERY_ID="$(jget "$B" '.deliveryId')"
rm -f "$B"
ok "dual-sign test event queued deliveryId=${DUAL_DELIVERY_ID} (receiver must confirm comma-separated header)"

# ---------------------------------------------------------------------------
# Step 11 — Webhook retry sweeper
# ---------------------------------------------------------------------------

step 11 "POST /v1/integrations/process-webhook-retries (cron secret)"
http_call S B POST \
    "${STAGING_API_BASE}/v1/integrations/process-webhook-retries" \
    -H "$(cron_header)" \
    -H "content-type: application/json" \
    --data-raw '{"batchSize":50}'
expect_status "$S" "200" "$B" "webhook retries sweeper"
RETRY_PROCESSED="$(jget_or_null "$B" '.summary.processed')"
RETRY_DELIVERED="$(jget_or_null "$B" '.summary.delivered')"
rm -f "$B"
ok "retry sweep processed=${RETRY_PROCESSED} delivered=${RETRY_DELIVERED}"

# ---------------------------------------------------------------------------
# Step 12 — Secret cleanup sweeper (dryRun)
# ---------------------------------------------------------------------------

step 12 "POST /v1/integrations/process-secret-cleanup (dryRun)"
http_call S B POST \
    "${STAGING_API_BASE}/v1/integrations/process-secret-cleanup" \
    -H "$(cron_header)" \
    -H "content-type: application/json" \
    --data-raw '{"dryRun":true}'
expect_status "$S" "200" "$B" "secret-cleanup sweeper"
SC_API="$(jget "$B" '.apiKeyRowsCleared')"
SC_WH="$(jget "$B" '.webhookRowsCleared')"
SC_DRY="$(jget "$B" '.dryRun')"
rm -f "$B"
[ "${SC_DRY}" = "true" ] || die "secret-cleanup dryRun flag did not echo true"
ok "secret-cleanup dryRun: apiKeyRowsCleared=${SC_API} webhookRowsCleared=${SC_WH}"
note "Seeded-expiry follow-up is documented in STAGING_VERIFICATION_CLOSURE.md (Secret-cleanup verification)"

# ---------------------------------------------------------------------------
# Step 13 — Revoke the API key + assert rejection
# ---------------------------------------------------------------------------

step 13 "POST /v1/integrations/api-keys/${API_KEY_ID}/revoke (step-up: INTEGRATION_API_KEY_REVOKE)"
REVOKE_BODY="$(jq -nc \
    --arg teamId "${STAGING_TEAM_ID}" \
    '{teamId:$teamId, reason:"phase6-verify cleanup"}')"
http_call S B POST \
    "${STAGING_API_BASE}/v1/integrations/api-keys/${API_KEY_ID}/revoke" \
    -H "$(auth_header)" \
    -H "$(step_up_header INTEGRATION_API_KEY_REVOKE)" \
    -H "content-type: application/json" \
    --data-raw "${REVOKE_BODY}"
expect_status "$S" "200" "$B" "api-key revoke"
REVOKED_STATUS="$(jget "$B" '.apiKey.status')"
REVOKED_REASON="$(jget_or_null "$B" '.apiKey.revokedReason')"
rm -f "$B"
[ "${REVOKED_STATUS}" = "REVOKED" ] || die "expected REVOKED, got ${REVOKED_STATUS}"
[ "${REVOKED_REASON}" = "phase6-verify cleanup" ] \
    || die "revokedReason did not round-trip: ${REVOKED_REASON}"
ok "api key revoked reason=${REVOKED_REASON}"

note "Re-probing public API with the revoked rawKey; expect 401"
http_call S B GET \
    "${STAGING_API_BASE}/v1/integrations/api/evidence?limit=1" \
    -H "Authorization: Bearer ${RAW_KEY}"
if [ "$S" = "200" ]; then
    rm -f "$B"
    die "revoked key STILL accepted by the public API (expected 401)"
fi
rm -f "$B"
ok "public API rejects the revoked key with HTTP ${S}"
# Discard the raw key from this script's memory.
RAW_KEY="<revoked>"

# ---------------------------------------------------------------------------
# Step 14 — Disable webhook + assert send-test rejects
# ---------------------------------------------------------------------------

step 14 "POST /v1/integrations/webhooks/${WEBHOOK_ID}/disable (step-up: INTEGRATION_WEBHOOK_DISABLE)"
DIS_BODY="$(jq -nc --arg teamId "${STAGING_TEAM_ID}" '{teamId:$teamId}')"
http_call S B POST \
    "${STAGING_API_BASE}/v1/integrations/webhooks/${WEBHOOK_ID}/disable" \
    -H "$(auth_header)" \
    -H "$(step_up_header INTEGRATION_WEBHOOK_DISABLE)" \
    -H "content-type: application/json" \
    --data-raw "${DIS_BODY}"
expect_status "$S" "200" "$B" "webhook disable"
DISABLED_STATUS="$(jget "$B" '.webhook.status')"
rm -f "$B"
[ "${DISABLED_STATUS}" = "DISABLED" ] || die "expected DISABLED, got ${DISABLED_STATUS}"
ok "webhook ${WEBHOOK_ID} disabled"

note "Re-probing /webhooks/:id/test against a DISABLED endpoint; expect 404"
http_call S B POST \
    "${STAGING_API_BASE}/v1/integrations/webhooks/${WEBHOOK_ID}/test" \
    -H "$(auth_header)" \
    -H "$(step_up_header INTEGRATION_WEBHOOK_TEST)" \
    -H "content-type: application/json" \
    --data-raw "${TEST_BODY}"
if [ "$S" != "404" ]; then
    print_response_summary "$B" >&2
    rm -f "$B"
    die "expected 404 endpoint_not_found_or_inactive on disabled endpoint, got HTTP ${S}"
fi
DISABLED_ERR_CODE="$(jget "$B" '.error.code')"
rm -f "$B"
[ "${DISABLED_ERR_CODE}" = "endpoint_not_found_or_inactive" ] \
    || die "expected error.code endpoint_not_found_or_inactive, got ${DISABLED_ERR_CODE}"
ok "disabled endpoint rejects test send with ${DISABLED_ERR_CODE}"

# ---------------------------------------------------------------------------
# Wrap-up
# ---------------------------------------------------------------------------

printf '\n%sALL 14 STEPS PASSED%s\n' "${cBold}${cGrn}" "${cRst}"
printf '  API key created+revoked: id=%s prefix=%s\n' "${API_KEY_ID}" "${API_KEY_PREFIX}"
printf '  Webhook created+rotated+disabled: id=%s\n' "${WEBHOOK_ID}"
printf '  Webhook secret prefixes: created=%s rotated=%s\n' "${WEBHOOK_SECRET_PREFIX}" "${NEW_WEBHOOK_SECRET_PREFIX}"
printf '  Test deliveries: pre-rotation=%s dual-sign=%s\n' "${TEST_DELIVERY_ID}" "${DUAL_DELIVERY_ID}"
printf '  See docs/integrations/STAGING_VERIFICATION_CLOSURE.md for:\n'
printf '    - dual-signature verification (receiver-side)\n'
printf '    - seeded secret-cleanup verification (DB UPDATE)\n'
printf '    - 9-pattern observability log grep (no raw secret in logs)\n'

exit 0
