# Owner procedure — TSA trust, Reem's TEAM grant, output recovery

Run on the Production host as the deploy user, in order, in ONE shell (the
variables carry between steps). Every command is read-only unless marked
**WRITES**. No secret is printed. Stop at any step whose expected result does
not match and send its output back.

## 0. Release and tools

```bash
cd /opt/proovra/app
git fetch --tags origin
export GHCR_OWNER=jalalattar29-netizen
export RELEASE_SHA="$(git rev-parse origin/main)"          # must equal the SHA in the hand-off
export IMAGE_TAG="sha-${RELEASE_SHA:0:7}"
export PROJECT="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$(docker ps -qf name=proovra-api | head -n1)")"
export NEW_COMPOSE="/tmp/proovra-compose-${IMAGE_TAG}.yml"
git show "${RELEASE_SHA}:infra/docker/docker-compose.prod.yml" > "$NEW_COMPOSE"
# Interpolation (${DATABASE_URL} …) and relative paths resolve from the REAL
# compose directory, exactly as for the running services.
export DC="docker compose -p $PROJECT --project-directory /opt/proovra/app/infra/docker -f $NEW_COMPOSE"
echo "release=$RELEASE_SHA tag=$IMAGE_TAG project=$PROJECT"
for svc in api worker; do
  docker pull -q "ghcr.io/${GHCR_OWNER}/proovra-${svc}:${IMAGE_TAG}"
  docker image inspect --format "${svc} revision={{ index .Config.Labels \"org.opencontainers.image.revision\" }}" "ghcr.io/${GHCR_OWNER}/proovra-${svc}:${IMAGE_TAG}"
done                                                        # both revisions must equal $RELEASE_SHA
# The previous release (for rollback):
export PREV_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$(docker ps -qf name=proovra-api | head -n1)")"
export PREV_SHA="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$PREV_IMAGE")"
mkdir -p .deploy-state && echo "previous image=$PREV_IMAGE revision=$PREV_SHA" | tee .deploy-state/pre-incident-release.txt
# One-off containers of the NEW image with the service's own environment:
export TOOL="$DC run --rm --no-deps -T --entrypoint node proovra-api"
```

## 1. `.env` — no line has to be added

`docker-compose.prod.yml` now sets `TSA_TRUST_BUNDLE_PATH=/run/proovra/tsa/trust-bundle.pem`
itself (it overrides any value in `.env`). Leave every existing TSA variable as it
is: `TSA_ENABLED`, `TSA_URL`, `TSA_PROVIDER`, `TSA_HASH_ALGORITHM`,
`TSA_TIMEOUT_MS`, `TSA_USERNAME`, `TSA_PASSWORD`, and — if present — the optional
`TSA_TRUST_ANCHOR_SHA256` / `TSA_ACCEPTED_POLICY_OIDS`. Step 2 checks the two
optional ones against the installed bundle and prints the exact line to change
only if one contradicts it.

## 2. Official GLOBALTRUST trust bundle — **WRITES** `/opt/proovra/app/secrets/tsa/trust-bundle.pem`

```bash
git show "${RELEASE_SHA}:scripts/install-tsa-trust-bundle.sh" > /tmp/install-tsa-trust-bundle.sh
sudo ENV_FILE=/opt/proovra/app/.env bash /tmp/install-tsa-trust-bundle.sh
sudo ENV_FILE=/opt/proovra/app/.env bash /tmp/install-tsa-trust-bundle.sh --check   # expect: OK: trust bundle installed and consistent.
```

Expected: `[1] … GLOBALTRUST 2015 QUALIFIED TIMESTAMP 1 sha256=945522340e54…3fc9`,
`[2] … GLOBALTRUST 2015 sha256=416b1f9e84e7…b3cc`, `OK`. Exit 3 prints the one
`.env` line to correct (an existing pin without the root, or an allowlist
without `1.2.40.0.36.1.1.8.1`); correct it and rerun `--check`.

## 3. Compose render

```bash
$DC config proovra-api 2>/dev/null \
  | grep -nE "image: |TSA_TRUST_BUNDLE_PATH|/run/proovra/tsa|/opt/proovra/app/secrets/tsa"
$DC run --rm --no-deps -T --entrypoint sh proovra-api \
  -c 'ls -l /run/proovra/tsa/trust-bundle.pem && openssl x509 -in /run/proovra/tsa/trust-bundle.pem -noout -subject'
```

Expected: `image: ghcr.io/jalalattar29-netizen/proovra-api:sha-…`,
`TSA_TRUST_BUNDLE_PATH: /run/proovra/tsa/trust-bundle.pem`, the read-only mount,
and the bundle readable inside the container.

## 4. Schema

```bash
$TOOL dist/scripts/internal-grant-rollout.js verify-schema; echo "exit $?"
```

`exit 0` / `"verdict": "PASS"` → go to step 6. Otherwise:

## 5. Migrations — only if step 4 failed

```bash
$TOOL dist/scripts/internal-grant-rollout.js readiness; echo "exit $?"     # must be exit 0, "READY"
export MIGRATE_BACKUP_ID=<the Neon snapshot/branch id you just created>     # backup first (Neon console → Branches → Create branch)
$DC run --rm --no-deps -T -e MIGRATE_ALLOW_REMOTE=1 -e MIGRATE_BACKUP_ID="$MIGRATE_BACKUP_ID" \
  --entrypoint node proovra-api scripts/safe-migrate.mjs deploy --allow-remote; echo "exit $?"   # WRITES the schema
$TOOL dist/scripts/internal-grant-rollout.js verify-schema; echo "exit $?"   # must now PASS
```

## 6. Deploy API + worker — **WRITES** (containers)

```bash
test -z "$(git status --short --untracked-files=no)" && echo "checkout clean"
git checkout --quiet --detach "$RELEASE_SHA"
GHCR_OWNER="$GHCR_OWNER" RELEASE_SHA="$RELEASE_SHA" IMAGE_TAG="$IMAGE_TAG" ./scripts/deploy-prod-pull.sh --plan
GHCR_OWNER="$GHCR_OWNER" RELEASE_SHA="$RELEASE_SHA" IMAGE_TAG="$IMAGE_TAG" ./scripts/deploy-prod-pull.sh
```

The script refuses a mismatched image revision, runs the schema gate from the
new image, starts the API and waits for `/readyz == 200` before the worker.

## 7. Health

```bash
curl -fsS http://127.0.0.1:8080/health; echo
curl -sS -w '  HTTP %{http_code}\n' http://127.0.0.1:8080/readyz      # {"status":"ok"} HTTP 200
curl -fsS http://127.0.0.1:8090/health | head -c 400; echo
curl -sS -w '  HTTP %{http_code}\n' https://api.proovra.com/readyz
export EXEC="docker compose -f infra/docker/docker-compose.prod.yml exec -T proovra-api node"
```

## 8. Platform Admin actor

```bash
$EXEC dist/scripts/internal-grant-rollout.js admins
export ADMIN_ID=<the id from that list that is YOUR account>
```

## 9. Reem — before

```bash
export REEM_ID=54b5d495-e16f-4253-b22d-ef68056b7315
export GRANT_KEY="owner-test:reem.ammar@hotmail.com:team:2026-10"
$EXEC dist/scripts/internal-plan-grant.js status --user-id=$REEM_ID                        # expect []
$EXEC dist/scripts/internal-grant-rollout.js snapshot --user-id=$REEM_ID --out=/tmp/reem-before.json
#   expect personalTeamId "6488cb98-a338-4c4f-913d-6d66345f60e6", activeGrant null
```

## 10. Grant — **WRITES** one `plan_grants` row + one audit event

```bash
export EXPIRES="$(date -u -d '+90 days' +%Y-%m-%dT%H:%M:%SZ)"; echo "$EXPIRES" | tee .deploy-state/reem-grant-expires.txt
$EXEC dist/scripts/internal-plan-grant.js apply --user-id=$REEM_ID --actor-user-id=$ADMIN_ID \
  --reason="Owner-authorized PROOVRA end-to-end product testing" \
  --idempotency-key="$GRANT_KEY" --expires-at="$EXPIRES" --confirm               # "created": true
```

## 11. Idempotent replay — writes nothing

```bash
$EXEC dist/scripts/internal-plan-grant.js apply --user-id=$REEM_ID --actor-user-id=$ADMIN_ID \
  --reason="Owner-authorized PROOVRA end-to-end product testing" \
  --idempotency-key="$GRANT_KEY" --expires-at="$EXPIRES" --confirm               # "created": false, same grant id
```

## 12. Reem — after

```bash
$EXEC dist/scripts/internal-grant-rollout.js snapshot --user-id=$REEM_ID --out=/tmp/reem-after.json
$EXEC dist/scripts/internal-grant-rollout.js compare --before=/tmp/reem-before.json --after=/tmp/reem-after.json \
  --expect=grant-applied --idempotency-key="$GRANT_KEY" --expiry-days=90      # "verdict": "PASS"
$EXEC dist/scripts/internal-plan-grant.js status --user-id=$REEM_ID           # exactly ONE grant, TEAM, INTERNAL_TEST
```

## 13. Existing timestamp — validate the KEPT reply (never restamps)

```bash
export EVIDENCE_ID=c30b0572-96d8-44fb-80d0-94f4520b8980
$EXEC dist/scripts/repair-tsa-failed-with-token.js --evidence-id $EVIDENCE_ID            # DRY RUN
#   VALIDATED …            → run the --apply line below
#   NOT-VALIDATED … code=X → stop here for the timestamp (it stays truthfully FAILED); send X back; continue at 14
$EXEC dist/scripts/repair-tsa-failed-with-token.js --evidence-id $EVIDENCE_ID --apply    # WRITES validation fields + TIMESTAMP_APPLIED custody event
$EXEC dist/scripts/repair-tsa-failed-with-token.js --evidence-id $EVIDENCE_ID            # replay: "no candidate rows found"
```

## 14. Report + verification package recovery

```bash
$EXEC dist/scripts/recover-evidence-outputs.js recover --user-id=$REEM_ID                # DRY RUN: "would request first_issuance"
$EXEC dist/scripts/recover-evidence-outputs.js recover --user-id=$REEM_ID --apply        # WRITES one request per record (queued)
$EXEC dist/scripts/recover-evidence-outputs.js recover --user-id=$REEM_ID --apply        # replay: deduplicated / nothing to recover
for i in $(seq 1 30); do
  $EXEC dist/scripts/recover-evidence-outputs.js status --evidence-id $EVIDENCE_ID --expect-complete >/tmp/reem-outputs.json && break
  sleep 10
done; cat /tmp/reem-outputs.json
```

## 15. Proof

```bash
$EXEC dist/scripts/internal-grant-rollout.js snapshot --user-id=$REEM_ID | grep -A3 '"effective"'      # TEAM / INTERNAL_GRANT
$EXEC dist/scripts/internal-plan-grant.js status --user-id=$REEM_ID | grep -c '"idempotencyKey"'      # 1
$EXEC dist/scripts/recover-evidence-outputs.js status --evidence-id $EVIDENCE_ID --expect-complete; echo "exit $?"
#   exit 0; "status": "REPORTED"; reports[0].objectExists true; packages[0] reportVersion = reports[0].version, objectExists true
curl -sS -w '  HTTP %{http_code}\n' http://127.0.0.1:8080/readyz
```

Downloads: signed in as Reem (her own credentials), open the record →
**Report PDF** and **Verification Package** both download (the stored objects
are proven present by the `status` line above).

## 16. Rollback (never deletes evidence, reports or packages)

```bash
# Grant:
$EXEC dist/scripts/internal-plan-grant.js revoke --user-id=$REEM_ID --actor-user-id=$ADMIN_ID \
  --reason="Rollback of owner test grant" --confirm
# Application images (the release recorded in step 6, or the one recorded in step 0):
GHCR_OWNER="$GHCR_OWNER" ./scripts/deploy-prod-pull.sh --rollback
#   or explicitly: GHCR_OWNER="$GHCR_OWNER" RELEASE_SHA="$PREV_SHA" IMAGE_TAG="sha-${PREV_SHA:0:7}" ./scripts/deploy-prod-pull.sh
```

Issued reports and packages stay downloadable after a revoke (outputs already
earned are kept); a revoke only stops NEW issuance.
