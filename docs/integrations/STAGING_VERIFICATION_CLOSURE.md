# PHASE 6 — Integrations Platform Staging Verification (Closure)

End-to-end manual verification plan for the Phase 1–5 work on the
PROOVRA integrations platform (API keys, webhooks, dual-signing
rotation, dual-active API-key rotation, health snapshot, secret
cleanup sweeper). This is a **closure** document — its only purpose
is to prove the existing code paths behave correctly in staging.
There are no code changes associated with this plan.

The companion runnable script is at
`scripts/verify-integrations-staging.sh`. Every numbered step below
is executed (in the same order) by that script. When a step is
gated by step-up MFA the script cannot complete it unattended; see
[Step-up helper](#step-up-helper) for the supported helper modes.

---

## Hard rules carried over from the brief

- **No raw secrets in logs.** `rawKey`, `rawSecret`, `Authorization`
  headers, signing secrets, and webhook payloads MUST NOT appear in
  any captured output. The script prints only the first 12 characters
  of any raw key it ever sees (the operator-visible prefix shape).
- **Backwards compatible step-up purposes.** New dedicated purposes
  (`INTEGRATION_API_KEY_*`, `INTEGRATION_WEBHOOK_*`) are required by
  the production routes. Pre-existing step-up rows carrying the legacy
  `SERVICE_ACCOUNT_*` purposes remain accepted via the canonical
  alias map (`LEGACY_STEP_UP_PURPOSE_ALIASES` in
  `packages/shared/src/identity-security.ts`). Do NOT re-issue
  step-up rows under legacy purposes for new traffic.
- **Honest latency / metrics.** `averageLatencyMsLast24h` is a real
  measured value from `IntegrationWebhookDelivery.responseDurationMs`
  or `null`. If absent in staging, the field is `null`, NOT `0`.
- **No new UI event types.** The UI may only surface event types
  that are actually emitted by an `emitWebhookEvent` call site
  somewhere in `services/api/src` or `services/worker/src`.
- **Receiver is owned by the operator.** No mock receivers are
  committed in this phase. See [Test-receiver setup](#test-receiver-setup).

---

## Environment prerequisites

| Variable | Required | Purpose |
|---|---|---|
| `STAGING_API_BASE` | yes | e.g. `https://api.staging.proovra.app` |
| `STAGING_ADMIN_TOKEN` | yes | Bearer JWT for a workspace `OWNER` or `ADMIN`; used as `Authorization: Bearer ...` against the integrations admin routes (see `services/api/src/middleware/auth.ts`) |
| `STAGING_TEAM_ID` | yes | Workspace (team) UUID the verification runs against |
| `INTEGRATION_CRON_SECRET` | yes for steps 11, 12 | Header `x-proovra-integration-cron-secret` (see `services/api/src/middleware/cron-secret.ts`) |
| `STEP_UP_HELPER` | optional | One of `env`, `file:<path>`, or `todo`. See [Step-up helper](#step-up-helper) |
| `TEST_WEBHOOK_URL` | yes | HTTPS URL of the test receiver (`webhook.site`-style or Node script). MUST be public; the SSRF guard rejects RFC1918/CGNAT/IPv4-mapped-IPv6/`localhost` (`validateWebhookUrl` in `packages/shared/src/integrations.ts`) |

The script prints the resolved values **except** the secret ones,
which it masks.

---

## The 14 steps

Each step lists the endpoint, the expected HTTP status, the
fields the verifier records, and any state-carrying values that
downstream steps consume (e.g. `API_KEY_ID`, `WEBHOOK_ID`,
`DELIVERY_ID`).

Conventions:
- All routes are mounted under `${STAGING_API_BASE}`.
- All admin routes require `Authorization: Bearer ${STAGING_ADMIN_TOKEN}`
  and a `teamId` query/body parameter equal to `${STAGING_TEAM_ID}`.
- `teamId` is always projected on the response — the script asserts
  `teamId === STAGING_TEAM_ID` on every record returned.

### Step 1 — Diagnostics is reachable and reports `enabled:true`

- **Endpoint:** `GET /v1/integrations/diagnostics?teamId=${STAGING_TEAM_ID}`
- **Expected status:** `200`
- **Expected fields:**
  - `diagnostics.enabled === true`
  - `diagnostics.apiKeySecretBound === true`
  - `diagnostics.apiKeySecretLengthValid === true`
  - `diagnostics.cronSecretBound === true`
  - `diagnostics.reason === null`
- **Record:** the boolean tuple; the script asserts they are all
  true and the `reason` is null.
- **Why this is step 1:** the entire integrations surface returns
  503 with `INTEGRATIONS_DISABLED` when the feature flag is off;
  failing fast here saves operator time. `/diagnostics` itself does
  NOT gate on the flag — it exists precisely to explain WHY the
  rest is off.

### Step 2 — Health snapshot baseline

- **Endpoint:** `GET /v1/integrations/health?teamId=${STAGING_TEAM_ID}`
- **Expected status:** `200`
- **Expected fields:** `health.teamId`, `health.windowHours === 24`,
  numeric counters for `activeApiKeys`, `revokedApiKeys`,
  `keysUsedLast24h`, `activeWebhooks`, `disabledWebhooks`,
  `deliveriesLast24h`, `failedDeliveriesLast24h`,
  `pendingOrRetryScheduledCount`, `endpointsCurrentlyFailing`.
  Plus the nullable `successRateLast24h`, `averageLatencyMsLast24h`,
  `oldestPendingDeliveryAt`, `lastSuccessfulDeliveryAt`,
  `lastFailedDeliveryAt`.
- **Record:** `BASELINE_ACTIVE_API_KEYS`, `BASELINE_ACTIVE_WEBHOOKS`,
  `BASELINE_DELIVERIES_24H`. The script uses these to assert deltas
  in steps 4, 6, 9, 14.
- **Forbidden:** `averageLatencyMsLast24h === 0` while
  `deliveriesLast24h === 0`. The contract requires `null` in that
  state.

### Step 3 — List API keys (existing inventory snapshot)

- **Endpoint:** `GET /v1/integrations/api-keys?teamId=${STAGING_TEAM_ID}`
- **Expected status:** `200`
- **Expected fields:** `apiKeys: [{ id, keyPrefix, name, scopes,
  status, createdAt, ... }]`. NO `rawKey`, NO `keyHash`,
  NO `previousKeyHash`. Every record has `teamId === STAGING_TEAM_ID`.
- **Record:** `BASELINE_API_KEY_COUNT = apiKeys.length`.

### Step 4 — Create an API key (step-up required)

- **Endpoint:** `POST /v1/integrations/api-keys`
- **Body:**
  ```json
  {
    "teamId": "${STAGING_TEAM_ID}",
    "name": "phase6-verify-<ISO timestamp>",
    "scopes": ["integration.evidence.read"]
  }
  ```
- **Step-up purpose required:** `INTEGRATION_API_KEY_CREATE`
  (legacy `SERVICE_ACCOUNT_CREATE` rows accepted via alias map).
- **Expected status:** `201`
- **Expected fields:** `apiKey.id`, `apiKey.keyPrefix` (matches
  `pwk_v1_*`), `apiKey.status === "ACTIVE"`, `apiKey.scopes`
  contains the requested scope, and `rawKey` is present (one-shot).
- **Record:** `API_KEY_ID = apiKey.id`, `API_KEY_PREFIX = apiKey.keyPrefix`,
  **mask** of `rawKey` (first 12 chars).
- **Asserts:** the response does NOT contain `keyHash`,
  `previousKeyHash`, or any 64-hex string longer than 16 chars
  outside the `rawKey` field; `rawKey` itself is logged ONLY as
  its 12-char mask.

### Step 5 — Public API self-test against the new key

- **Endpoint:** `GET /v1/integrations/api/evidence?limit=1`
- **Auth:** `Authorization: Bearer <rawKey from step 4>`
- **Expected status:** `200` (even when the list is empty)
- **Expected fields:** `evidence: []` or up to 1 item; `nextCursor`
  null or a UUID. The projection does NOT include `internalNotes`,
  `intakePlanJson`, or actor identifiers.
- **Record:** the response shape only. The script verifies the key
  was usable; it discards the rawKey from memory afterwards (does
  NOT echo it).

### Step 6 — Create a webhook endpoint (step-up required)

- **Endpoint:** `POST /v1/integrations/webhooks`
- **Body:**
  ```json
  {
    "teamId": "${STAGING_TEAM_ID}",
    "url": "${TEST_WEBHOOK_URL}",
    "description": "phase6-verify-<ISO timestamp>",
    "eventTypes": ["evidence.completed"]
  }
  ```
- **Step-up purpose required:** `INTEGRATION_WEBHOOK_CREATE`.
- **Expected status:** `201`
- **Expected fields:** `webhook.id`, `webhook.url` (echoes the
  caller-provided URL after normalization), `webhook.eventTypes`,
  `webhook.status === "ACTIVE"`, `webhook.secretPrefix`,
  `webhook.previousSecretPrefix === null`,
  `webhook.previousSecretValidUntilUtc === null`, and the one-shot
  `rawSecret`.
- **Record:** `WEBHOOK_ID = webhook.id`, `WEBHOOK_SECRET_PREFIX`,
  **mask** of `rawSecret` (first 12 chars).
- **SSRF assertion:** the request body's `url` must be HTTPS and
  public; the URL guard at `validateWebhookUrl` rejects
  `localhost`, `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`,
  `169.254/16`, `100.64/10` (CGNAT), `::1`, `fc00::/7`, `fe80::/10`,
  and the IPv4-mapped-IPv6 variants of all of the above. If the
  staging URL is wrong the response is `400 invalid_url` or
  `400 private_network_blocked`.

### Step 7 — Send a test event (step-up required)

- **Endpoint:** `POST /v1/integrations/webhooks/${WEBHOOK_ID}/test`
- **Body:** `{ "teamId": "${STAGING_TEAM_ID}", "payload": { "marker": "phase6-verify" } }`
- **Step-up purpose required:** `INTEGRATION_WEBHOOK_TEST`. The
  alias map does **not** alias `SERVICE_ACCOUNT_HARDENING_UPDATE`
  to TEST (intentional — a stale hardening row must NOT silently
  satisfy a new test-send).
- **Expected status:** `202`
- **Expected fields:** `deliveryId` (uuid), `eventId` (uuid).
- **Record:** `TEST_DELIVERY_ID = deliveryId`,
  `TEST_EVENT_ID = eventId`.

### Step 8 — Verify the test delivery landed at the receiver

- **Endpoint:** `GET /v1/integrations/webhook-deliveries/${TEST_DELIVERY_ID}?teamId=${STAGING_TEAM_ID}`
- **Expected status:** `200`
- **Expected fields after ≤ 30 s of polling:**
  - `delivery.status === "SENT"` (success path) OR
    `delivery.status === "FAILED"` (receiver rejected — the test
    receiver MUST respond 2xx; a `FAILED` here means the receiver
    is misconfigured).
  - `delivery.attemptCount >= 1`
  - `delivery.responseStatus` in `[200, 201, 202, 204]`
  - `delivery.eventType === "webhook.test"`
- **Receiver-side recording (manual):** open the receiver and
  confirm the captured request shows headers
  `x-proovra-event: webhook.test`,
  `x-proovra-event-id: ${TEST_EVENT_ID}`,
  `x-proovra-timestamp: <unix ms>`,
  `x-proovra-signature: v1=<64 hex chars>`,
  and that the body parses as JSON containing `marker:"phase6-verify"`.
- **Record:** `delivery.responseStatus`, the wall-clock latency
  reported by `delivery.responseDurationMs` (may be null when the
  test endpoint URL was unreachable before the fetch).

### Step 9 — List deliveries for the endpoint

- **Endpoint:** `GET /v1/integrations/webhooks/${WEBHOOK_ID}/deliveries?teamId=${STAGING_TEAM_ID}&limit=10`
- **Expected status:** `200`
- **Expected fields:** `deliveries: [...]`; the row from step 7 is
  present at the top; no row contains `payloadJson` (deliberately
  projected away — see `projectIntegrationDelivery`).
- **Record:** `DELIVERY_COUNT = deliveries.length`.

### Step 10 — Rotate the webhook secret (step-up required)

- **Endpoint:** `POST /v1/integrations/webhooks/${WEBHOOK_ID}/rotate-secret`
- **Body:** `{ "teamId": "${STAGING_TEAM_ID}", "graceMinutes": 10 }`
- **Step-up purpose required:** `INTEGRATION_WEBHOOK_SECRET_ROTATE`
  (legacy `SERVICE_ACCOUNT_HARDENING_UPDATE` accepted via alias).
- **Expected status:** `200`
- **Expected fields:** `webhook.secretPrefix` differs from the
  step-6 prefix; `webhook.previousSecretPrefix === WEBHOOK_SECRET_PREFIX`
  (the OLD value); `previousSecretValidUntilUtc` ≈ `now + 10 minutes`;
  one-shot `rawSecret` is present.
- **Record:** `NEW_WEBHOOK_SECRET_PREFIX`, mask of `rawSecret`,
  `PREVIOUS_VALID_UNTIL_UTC`.
- **Dual-signature window verification:** during this 10-minute
  window the dispatcher emits BOTH signatures in
  `X-Proovra-Signature` as `v1=<new>,v1=<old>` (comma-separated).
  See [Dual-signature verification](#dual-signature-verification).
  Trigger another test event (the script re-runs step 7 with a
  different `marker`) and capture the receiver-side signature
  header.

### Step 11 — Run the webhook retry sweeper (cron secret)

- **Endpoint:** `POST /v1/integrations/process-webhook-retries`
- **Header:** `x-proovra-integration-cron-secret: ${INTEGRATION_CRON_SECRET}`
- **Body:** `{ "batchSize": 50 }`
- **Expected status:** `200`
- **Expected fields:** `summary.processed >= 0`,
  `summary.delivered >= 0`, `summary.transientFailed >= 0`,
  `summary.permanentlyFailed >= 0`.
- **Record:** the counts. The verification only asserts the call
  succeeded; in a clean staging workspace this is often
  `{processed:0}`.

### Step 12 — Run the secret-cleanup sweeper (cron secret)

- **Endpoint:** `POST /v1/integrations/process-secret-cleanup`
- **Header:** `x-proovra-integration-cron-secret: ${INTEGRATION_CRON_SECRET}`
- **Body:** `{ "dryRun": true }`
- **Expected status:** `200`
- **Expected fields:** `apiKeyRowsCleared: 0`, `webhookRowsCleared: 0`,
  `scannedAt: <ISO>`, `dryRun: true`.
- **Record:** the counts. See
  [Secret-cleanup verification](#secret-cleanup-verification) for
  the seeded-expiry variant of this step that proves the sweeper
  actually clears.

### Step 13 — Revoke the test API key (step-up required)

- **Endpoint:** `POST /v1/integrations/api-keys/${API_KEY_ID}/revoke`
- **Body:** `{ "teamId": "${STAGING_TEAM_ID}", "reason": "phase6-verify cleanup" }`
- **Step-up purpose required:** `INTEGRATION_API_KEY_REVOKE` (legacy
  `SERVICE_ACCOUNT_REVOKE` accepted via alias).
- **Expected status:** `200`
- **Expected fields:** `apiKey.status === "REVOKED"`,
  `apiKey.revokedReason === "phase6-verify cleanup"`,
  `apiKey.revokedAt` is recent.
- **Record:** the revoke timestamp. The script then re-runs the
  Step 5 probe against the rawKey and asserts the API rejects with
  `401`.

### Step 14 — Disable the test webhook (step-up required)

- **Endpoint:** `POST /v1/integrations/webhooks/${WEBHOOK_ID}/disable`
- **Body:** `{ "teamId": "${STAGING_TEAM_ID}" }`
- **Step-up purpose required:** `INTEGRATION_WEBHOOK_DISABLE`.
- **Expected status:** `200`
- **Expected fields:** `webhook.status === "DISABLED"`.
- **Record:** disabled timestamp. Verify that re-running step 7
  on the disabled endpoint now returns `404
  endpoint_not_found_or_inactive`.

---

## Step-up helper

The Phase 4-closure routes gate every mutation behind
`requireStepUpForSensitiveAction`. Step-up cannot be satisfied by a
plain Bearer JWT — the caller must additionally present a fresh
`x-proovra-step-up-token` (or compatible header — see
`services/api/src/services/identity-security/step-up-middleware.ts`).
The runnable script supports three helper modes via `STEP_UP_HELPER`:

1. **`env`** — token is read from `STEP_UP_TOKEN` on every call.
   The operator must regenerate it between steps if its TTL
   expires. Used when staging is connected to a step-up issuer the
   operator has scripted access to.

2. **`file:<path>`** — token is read fresh from the file at each
   step (so an operator-side daemon can refresh it on disk). The
   script never writes to this file; it only reads.

3. **`todo`** — the script PAUSES at each gated step and prints the
   required `purpose` + the curl command to run AFTER the operator
   has produced a token. This is the safe default when no
   automation exists.

The script never echoes the step-up token in its log output. It
masks it identically to `rawKey` / `rawSecret`.

---

## Test-receiver setup

The verifier does NOT commit a mock receiver. Pick one of:

### Option A — webhook.site (fastest, low control)

1. Open `https://webhook.site` and copy your unique HTTPS URL.
2. Set `TEST_WEBHOOK_URL` to that URL.
3. After step 7 (and again after step 10), refresh the
   webhook.site page and confirm:
   - The captured request method is `POST`.
   - The headers panel shows `x-proovra-event`,
     `x-proovra-event-id`, `x-proovra-timestamp`,
     `x-proovra-signature: v1=<64 hex>`.
   - The body parses as JSON.
4. webhook.site responds `200` by default, which the dispatcher
   records as `delivery.status = "SENT"`.

### Option B — controlled internal endpoint (recommended for closure)

Stand up a single Cloud Run / Lambda / VM endpoint that:
- Listens on HTTPS at a public hostname (`TEST_WEBHOOK_URL`).
- For every POST: parses the four `x-proovra-*` headers, parses
  the body, recomputes the HMAC, asserts equality in constant
  time, then responds `200` (or `204`) with a small JSON body
  echoing the `deliveryId` from the `x-proovra-event-id` header.
- Logs each delivery's `deliveryId`, `eventType`, and signature
  verification verdict to its operator log. NEVER logs the body
  itself in clear, NEVER logs the signing secret. The secret is
  provided via env var or secret store; the receiver looks it up
  once at start.

A reference Node receiver (do NOT commit unless it already exists;
keep it in your private ops repo) looks like:

```javascript
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

// Secrets are looked up by webhook id from your secret store; this
// example just supports ONE endpoint via env.
const SECRETS = {
  current: process.env.WEBHOOK_SECRET ?? "",
  previous: process.env.WEBHOOK_SECRET_PREVIOUS ?? "",
};

function verify(rawBody, header, secret) {
  if (!secret) return false;
  const sig = createHmac("sha256", secret)
    .update(`${header.timestamp}.${rawBody}`)
    .digest("hex");
  // header.signature looks like "v1=<hex>" — strip the "v1=" prefix.
  const expected = Buffer.from(sig, "hex");
  const got = Buffer.from((header.signature || "").replace(/^v1=/, ""), "hex");
  return expected.length === got.length && timingSafeEqual(expected, got);
}

function parseSignatureTokens(header) {
  // X-Proovra-Signature is a comma-separated list of "<scheme>=<hex>".
  // During a rotation grace window the server emits
  // "v1=<new>,v1=<old>".
  // A spec-compliant receiver MUST accept the request when AT LEAST
  // ONE token verifies under the secret the receiver knows.
  return String(header || "")
    .split(",")
    .map(s => s.trim())
    .filter(s => s.startsWith("v1="))
    .map(s => s.slice(3));
}

createServer((req, res) => {
  if (req.method !== "POST") return res.writeHead(405).end();
  let chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const timestamp = req.headers["x-proovra-timestamp"];
    const signatures = parseSignatureTokens(req.headers["x-proovra-signature"]);
    const evType = req.headers["x-proovra-event"];
    const deliveryId = req.headers["x-proovra-event-id"];

    // Accept if ANY signature token verifies against EITHER current
    // OR previous (the receiver MUST keep both during rotation).
    const ok = signatures.some(sig =>
      verify(raw, { timestamp, signature: `v1=${sig}` }, SECRETS.current) ||
      verify(raw, { timestamp, signature: `v1=${sig}` }, SECRETS.previous)
    );

    // NEVER log the body / secret / raw signatures.
    console.log(JSON.stringify({
      deliveryId,
      eventType: evType,
      verified: ok,
      signatureCount: signatures.length,
    }));

    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok, deliveryId }));
  });
}).listen(process.env.PORT || 8080);
```

---

## Dual-signature verification (rotation grace window)

When the secret is rotated (Step 10), the dispatcher emits the
`X-Proovra-Signature` header as a comma-separated list of
`<scheme>=<hex>` tokens:

```
X-Proovra-Signature: v1=<NEW_HEX>,v1=<OLD_HEX>
```

Exact parsing rule (consumed by the receiver and asserted by the
verifier in step 10):

1. Read `X-Proovra-Signature`.
2. Split on `,`.
3. Trim each element.
4. Keep only elements matching the regex `^v1=([0-9a-f]{64})$`
   (case-insensitive on the hex group, but the dispatcher always
   emits lowercase).
5. The result is the ordered list of candidate HMACs. The
   dispatcher convention is **new first, previous second** — but
   receivers MUST NOT rely on order; verifying against EITHER
   secret in the receiver's possession is sufficient.

Two HMACs of the new+old kind cannot collide on a non-empty body
(they are keyed by different secrets), so a receiver that accepts
the first matching token is safe.

Asserts in step 10:
- The captured `X-Proovra-Signature` header has TWO `v1=` tokens.
- The receiver responds `200`.
- The dispatcher records `delivery.status = "SENT"`.

After `previousSecretValidUntilUtc` passes, the next outbound
delivery emits ONLY the new signature (single token, no comma).
The dispatcher also fires off a lazy `clearExpiredPreviousWebhookSecret`
side effect; the secret-cleanup sweeper covers endpoints that are
quiet during the grace window.

---

## Secret-cleanup verification

The bare `dryRun:true` call in step 12 only proves the route is
reachable. To prove the sweeper actually clears, run a one-shot
seeded variant against the same staging DB:

1. **Seed an expired `previous_*` row.** Pick a webhook endpoint
   in staging (e.g. `WEBHOOK_ID` from step 6 AFTER step 10), and
   manually shift its `previous_secret_valid_until_utc` to a past
   timestamp via a DB session that has SELECT/UPDATE on
   `integration_webhook_endpoints`:

   ```sql
   UPDATE integration_webhook_endpoints
   SET previous_secret_valid_until_utc = NOW() - INTERVAL '1 hour'
   WHERE id = '${WEBHOOK_ID}'
     AND team_id = '${STAGING_TEAM_ID}'
     AND previous_secret_ciphertext IS NOT NULL;
   ```

   Equivalent seed for ApiCredential rotation:

   ```sql
   UPDATE api_credentials
   SET previous_valid_until_utc = NOW() - INTERVAL '1 hour'
   WHERE id = '${SEEDED_API_KEY_ID}'
     AND team_id = '${STAGING_TEAM_ID}'
     AND previous_key_hash IS NOT NULL;
   ```

2. **Run the sweeper for real (NOT dryRun).**

   ```
   POST /v1/integrations/process-secret-cleanup
   x-proovra-integration-cron-secret: ${INTEGRATION_CRON_SECRET}
   { "batchSize": 100 }
   ```

   Expected response:
   ```
   { "apiKeyRowsCleared": >=1, "webhookRowsCleared": >=1,
     "scannedAt": <ISO>, "dryRun": false }
   ```

3. **Confirm idempotency.** Re-run the same call immediately.
   Expected: `apiKeyRowsCleared: 0, webhookRowsCleared: 0`.

4. **Confirm the DB row is cleared.**

   ```sql
   SELECT id,
          previous_secret_ciphertext IS NULL AS secret_cleared,
          previous_secret_prefix IS NULL     AS prefix_cleared,
          previous_secret_valid_until_utc IS NULL AS cutoff_cleared
   FROM integration_webhook_endpoints
   WHERE id = '${WEBHOOK_ID}';
   ```

   All three flags MUST be `true`.

The companion script does NOT run this seeded variant
automatically (writing to staging DB tables is the operator's
responsibility); the SQL is reproduced here for the manual
follow-up.

---

## Observability checks (no raw secret in any log)

After the full scenario has run, pull the captured logs of both
the API service and the worker for the entire scenario window and
prove the absence of raw secret material.

### Required log-grep patterns (must return ZERO matches)

Run these against the captured logs. The patterns target the
**literal raw-key shape** plus the operator-visible field names
that would expose a secret if mishandled.

| Pattern | Why it MUST be empty |
|---|---|
| `pwk_v[0-9]+_[A-Za-z0-9_-]{16,}` | Raw API key bytes |
| `"rawKey":\s*"[^"]+"` | JSON-projected raw API key |
| `"rawSecret":\s*"[^"]+"` | JSON-projected raw webhook secret |
| `(authorization|Authorization):\s*Bearer\s+\S+` | Authorization headers echoed into logs |
| `"keyHash":\s*"[^"]+"` | Stored hash leaked into logs |
| `"previousKeyHash":\s*"[^"]+"` | Previous-key hash leaked |
| `"secretCiphertext":\s*"[^"]+"` | Encrypted webhook secret leaked |
| `"previousSecretCiphertext":\s*"[^"]+"` | Previous webhook ciphertext leaked |
| `x-proovra-integration-cron-secret:\s+\S+` | Cron secret echoed |

### Allowed (must STILL appear)

These confirm the audit hooks fired. They contain only
operator-visible identifiers, never raw secret bytes.

- `integration.api_key.created` (TeamActivity row from step 4)
- `integration.api_key.rotated` (if step 10 covers an API key rotation
  variant — not in default plan)
- `integration.api_key.revoked` (step 13)
- `integration.webhook.secret_rotated` (step 10)
- `integration.webhook.test_sent` (step 7)

### Recommended command (ripgrep)

```bash
# Pull logs of API and worker for the verification window into a
# single file `staging-logs.txt`, then:
rg -nE 'pwk_v[0-9]+_[A-Za-z0-9_-]{16,}'      staging-logs.txt && exit 1
rg -nE '"rawKey":\s*"[^"]+"'                  staging-logs.txt && exit 1
rg -nE '"rawSecret":\s*"[^"]+"'               staging-logs.txt && exit 1
rg -niE '(authorization):\s*bearer\s+\S+'     staging-logs.txt && exit 1
rg -nE '"keyHash":\s*"[^"]+"'                 staging-logs.txt && exit 1
rg -nE '"previousKeyHash":\s*"[^"]+"'         staging-logs.txt && exit 1
rg -nE '"secretCiphertext":\s*"[^"]+"'        staging-logs.txt && exit 1
rg -nE '"previousSecretCiphertext":\s*"[^"]+"' staging-logs.txt && exit 1
rg -niE 'x-proovra-integration-cron-secret:\s+\S+' staging-logs.txt && exit 1
# All nine MUST return zero matches.
```

Each `&& exit 1` ensures a non-zero exit code if ANY pattern hits.
In CI / a one-shot shell wrapper that is the success criterion for
the observability section of this verification.

---

## Sign-off

Phase 6 closure is complete when:

1. Steps 1–14 all pass with the exact status codes above.
2. The receiver-side checks in step 8 + step 10 (dual signature)
   are confirmed.
3. The optional seeded secret-cleanup variant passes.
4. The nine log-grep patterns above return zero matches.

Record the run id, the operator, the date, and the masked
artifacts (`API_KEY_PREFIX`, `WEBHOOK_SECRET_PREFIX`,
`NEW_WEBHOOK_SECRET_PREFIX`) in the closure log entry.
