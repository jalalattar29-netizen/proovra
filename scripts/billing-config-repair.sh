#!/usr/bin/env bash
# BILLING CONFIGURATION REPAIR — owner-run, on the Production host.
#
#   ./scripts/billing-config-repair.sh discover       read-only
#   ./scripts/billing-config-repair.sh set-prices     writes the env file only
#   ./scripts/billing-config-repair.sh recreate-api   recreates proovra-api only
#
# WHY THIS EXISTS. `deploy-prod-pull.sh` deploys a release: it checks out a commit
# and recreates the API AND the worker. A price id needs neither. This changes one
# file and recreates one container, on the image ALREADY RUNNING, so a configuration
# repair cannot ship unrelated commits or roll anything back.
#
# Every value it needs is read from the running container or asked for one at a
# time and validated. It prints ids, amounts and states, never a credential, and
# never prints the env file.

set -euo pipefail

ENV_FILE="${COMPOSE_ENV_FILE:-/opt/proovra/app/.env}"
COMPOSE_FILE="${COMPOSE_FILE_PATH:-/opt/proovra/app/infra/docker/docker-compose.prod.yml}"
PROJECT="${COMPOSE_PROJECT_NAME:-docker}"
API="docker-proovra-api-1"
SKUS="TEAM_100_GB TEAM_500_GB TEAM_1_TB PERSONAL_10_GB PERSONAL_50_GB PERSONAL_200_GB"

fail() {
  echo "STOP: $*" >&2
  exit 1
}

running_image() {
  docker inspect --format '{{.Config.Image}}' "${API}" 2>/dev/null ||
    fail "${API} is not running."
}

discover() {
  local image revision
  image="$(running_image)"
  revision="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${API}")"
  echo "image=${image}"
  echo "revision=${revision}"
  docker inspect --format 'started={{.State.StartedAt}} restarts={{.RestartCount}}' "${API}"
  # Amounts are the effective prices the page shows; ids and cents are not secret.
  docker exec "${API}" node -e '
    const catalogue = { PERSONAL_10_GB: 299, PERSONAL_50_GB: 799, PERSONAL_200_GB: 1999, TEAM_100_GB: 999, TEAM_500_GB: 3499, TEAM_1_TB: 5999 };
    for (const s of Object.keys(catalogue)) {
      const raw = (process.env["BILLING_STORAGE_" + s + "_EUR_PRICE_CENTS"] || "").trim();
      const override = /^\d+$/.test(raw) ? Number(raw) : null;
      const price = (process.env["STRIPE_STORAGE_" + s + "_MONTHLY_EUR_PRICE_ID"] || "").trim();
      console.log(s, "stripe_price=" + (price || "UNSET"), "effective_cents=" + (override ?? catalogue[s]),
        "source=" + (override === null ? "catalogue" : "override"),
        "product=" + ((process.env["STRIPE_STORAGE_" + s + "_PRODUCT_ID"] || "").trim() || "UNSET"),
        "paypal_plan=" + ((process.env["PAYPAL_PLAN_STORAGE_" + s + "_EUR"] || "").trim() || "UNSET"));
    }
    const k = process.env.STRIPE_SECRET_KEY || "";
    console.log("stripe_key_mode=" + (k.startsWith("sk_live_") ? "live" : k.startsWith("sk_test_") ? "test" : k ? "other" : "unset"));
  '
  echo "Check the catalogue figures above against billing.service.ts at this revision before trusting a 'catalogue' row."
}

set_prices() {
  [ -w "${ENV_FILE}" ] || fail "${ENV_FILE} is not writable by this user."
  local backup sku key count value changed=0
  backup="${ENV_FILE}.before-billing-repair.$(date -u +%Y%m%dT%H%M%SZ)"
  ( umask 077 && cp -p "${ENV_FILE}" "${backup}" )
  echo "Backup written (keep it private): ${backup}"
  echo "Paste each Live price id from the Stripe Dashboard. Press Enter to skip a SKU."
  for sku in ${SKUS}; do
    key="STRIPE_STORAGE_${sku}_MONTHLY_EUR_PRICE_ID"
    count="$(grep -c "^${key}=" "${ENV_FILE}" || true)"
    if [ "${count}" != "0" ]; then
      echo "  ${key}: already present (${count} line). Edit it by hand if it is wrong."
      continue
    fi
    read -r -p "  ${sku}: " value
    [ -n "${value}" ] || continue
    [[ "${value}" =~ ^price_[A-Za-z0-9]{8,}$ ]] || fail "'${value}' is not a Stripe price id. Nothing further was written."
    printf '%s=%s\n' "${key}" "${value}" >>"${ENV_FILE}"
    changed=$((changed + 1))
  done
  echo "${changed} line(s) added. Running containers do not see this until recreated."
  echo "Compare the file with the backup for ONLY these lines before recreating:"
  echo "  diff '${backup}' '${ENV_FILE}' | grep -E '^[<>]' | sed -E 's/^([<>] [A-Z0-9_]+)=.*/\\1/'"
}

recreate_api() {
  [ -r "${COMPOSE_FILE}" ] || fail "compose file ${COMPOSE_FILE} is not readable (set COMPOSE_FILE_PATH)."
  local image tag owner before after
  image="$(running_image)"
  [[ "${image}" =~ ^ghcr\.io/([a-z0-9-]+)/proovra-api:(sha-[0-9a-f]{7,40})$ ]] ||
    fail "the running image '${image}' is not an immutable ghcr sha tag; use the release procedure instead."
  owner="${BASH_REMATCH[1]}"
  tag="${BASH_REMATCH[2]}"
  before="$(docker inspect --format '{{.Image}}' "${API}")"
  echo "Recreating proovra-api on the image already running: ${image}"
  GHCR_OWNER="${owner}" IMAGE_TAG="${tag}" docker compose -p "${PROJECT}" --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" \
    up -d --no-deps --pull never proovra-api
  after="$(docker inspect --format '{{.Image}}' "${API}")"
  [ "${before}" = "${after}" ] || fail "the image changed from ${before} to ${after}. Investigate before continuing."
  echo "Same image. The worker was not touched."
}

case "${1:-}" in
  discover) discover ;;
  set-prices) set_prices ;;
  recreate-api) recreate_api ;;
  *) fail "usage: $0 discover|set-prices|recreate-api" ;;
esac
