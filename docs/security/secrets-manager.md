# AWS Secrets Manager Integration (Phase P2.0)

**Audience:** Platform engineers operating PROOVRA in staging / production. Local-dev contributors do NOT need AWS — see §3.

**Status:** Production-safe. The integration is **opt-in via env var**, **non-blocking on AWS failure**, and **always preserves env fallback**.

---

## 1. Architecture

```
        ┌──────────────────────────┐
        │  process.env[NAME]       │  ← always works; canonical fallback
        └──────────────┬───────────┘
                       │
        ┌──────────────▼───────────┐
        │  AWS Secrets Manager     │  ← takes precedence when configured
        │  in-memory cache (TTL)   │
        └──────────────────────────┘
                       │
        ┌──────────────▼───────────┐
        │  resolveRuntimeSecret()  │  ← AWS first, env fallback
        │  getSecret() / require…  │
        └──────────────────────────┘
                       │
   ┌───────────────────┼───────────────────┐
   │                   │                   │
auth/middleware    ai-provider     stripe / paypal / resend
   AUTH_JWT_SECRET    OPENAI_API_KEY  …
```

**Resolution order** (highest precedence first):

1. AWS Secrets Manager cache (when `AWS_SECRETS_ENABLED=true` and hydration succeeded)
2. `process.env[NAME]`
3. `null` / throw (depending on caller)

The cache is in-memory only; there is no shared / Redis-backed cache. Each API instance hydrates independently at boot.

---

## 2. Configuration

| Env var | Default | Effect |
| --- | --- | --- |
| `AWS_SECRETS_ENABLED` | `false` | Set to `"true"` to enable AWS Secrets Manager. Without this, the loader is a no-op. |
| `AWS_SECRET_NAME` | `proovra/prod/app-secrets` | The Secret ID to fetch. Must be a JSON object of name→string. |
| `AWS_SECRETS_REGION` | (falls back to `AWS_REGION`, then `us-east-1`) | Region used by the Secrets Manager client. **Decoupled from `AWS_REGION` so KMS signing can stay in a different region** (e.g. `eu-north-1`). |
| `AWS_REGION` | `eu-north-1` (in our prod) | App-wide AWS region — used by KMS signing and S3. **Not consulted by Secrets Manager when `AWS_SECRETS_REGION` is set.** |
| `AWS_SECRETS_REFRESH_TTL_MS` (legacy: `SECRETS_REFRESH_TTL_MS`) | `3600000` (1h) | Background refresh interval. Floor 60s; ceiling 24h. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | — | Picked up by the standard AWS SDK credential chain. Prefer IAM roles in EKS / ECS. |

**Region split (important):**

```
┌────────────────────┬──────────────────┬─────────────────────────┐
│ Component          │ Region read from │ Production value        │
├────────────────────┼──────────────────┼─────────────────────────┤
│ Secrets Manager    │ AWS_SECRETS_REGION (fallback AWS_REGION) │ us-east-1               │
│ KMS evidence signer│ AWS_REGION       │ eu-north-1              │
│ S3                 │ S3_REGION        │ <bucket-region>         │
└────────────────────┴──────────────────┴─────────────────────────┘
```

Setting `AWS_SECRETS_REGION=us-east-1` does NOT mutate `AWS_REGION` — KMS signing continues to read `eu-north-1` directly.

**Secret payload format** (stored in AWS Secrets Manager):

```json
{
  "OPENAI_API_KEY": "sk-...",
  "AUTH_JWT_SECRET": "…",
  "STRIPE_SECRET_KEY": "sk_live_…",
  "PAYPAL_SECRET": "…",
  "RESEND_API_KEY": "re_…"
}
```

Only the keys listed in `MIGRATED_SECRETS` (the bounded allowlist in `services/api/src/config/runtime-secrets.ts`) are sourced from this payload today. Other keys can be present — the loader caches all string-valued entries — but the call-sites still read from `process.env` until they're migrated.

---

## 3. Local development

**Do NOT set `AWS_SECRETS_ENABLED` in dev.** The loader is a no-op; everything reads from your existing `.env` / `docker-compose.yml`.

```bash
# .env (local dev)
AUTH_JWT_SECRET=local-dev-secret
OPENAI_API_KEY=
RESEND_API_KEY=
# AWS_SECRETS_ENABLED unset → AWS client never instantiates
```

Local Docker Compose is unchanged.

---

## 4. Production deployment

1. Create the secret in AWS:

   ```bash
   aws secretsmanager create-secret \
     --name proovra/prod/app-secrets \
     --secret-string file://secrets.json
   ```

2. Grant the API task / pod IAM role read access:

   ```json
   {
     "Effect": "Allow",
     "Action": ["secretsmanager:GetSecretValue"],
     "Resource": "arn:aws:secretsmanager:us-east-1:<acct>:secret:proovra/prod/app-secrets-*"
   }
   ```

3. Set deployment env:

   ```
   AWS_SECRETS_ENABLED=true
   AWS_SECRET_NAME=proovra/prod/app-secrets
   AWS_REGION=us-east-1
   ```

4. Deploy. The API logs `aws_secrets.hydration_started` then `aws_secrets.hydration_succeeded` with a `keyCount` field. No secret values are logged.

5. Verify via the health route (requires an authenticated workspace operator):

   ```
   GET /v1/runtime/secrets-health?teamId=<…>
   ```

   Expected response:

   ```json
   {
     "health": {
       "awsEnabled": true,
       "awsConnected": true,
       "cacheLoaded": true,
       "fallbackMode": "aws_primary",
       "cachedKeyCount": 5,
       "secretName": "proovra/prod/app-secrets",
       "region": "us-east-1",
       "degraded": false
     },
     "migrated": [
       { "name": "OPENAI_API_KEY", "source": "aws", "present": true },
       …
     ]
   }
   ```

The response NEVER contains secret values.

---

## 5. Failure modes

| AWS condition | Loader behaviour | App behaviour |
| --- | --- | --- |
| `AWS_SECRETS_ENABLED` unset / `"false"` | No-op. | Env-only mode. Same as before P2.0. |
| AWS API returns access-denied | `lastErrorCode = "access_denied"`; warning log; `fallbackMode = "env_only"`. | Continues. Reads from env. |
| AWS API returns not-found | `lastErrorCode = "not_found"`; warning log. | Continues. Reads from env. |
| AWS API times out / DNS fails | `lastErrorCode = "network"`; warning log. | Continues. Reads from env. |
| Secret payload is not JSON | `lastErrorCode = "decode"`; warning log. | Continues. Reads from env. |
| Initial fetch succeeds; periodic refresh fails | Previous cache stays valid. New `lastErrorCode` set. | Continues. Reads from cache. |
| API is restarted | Hydration runs once at boot; same model. | Same model. |

**The app NEVER crashes on AWS failure.** This is a hard contract — see the test suite `phase-p2-0-secrets-manager.test.ts`.

---

## 6. Operational recovery

If `/v1/runtime/secrets-health` shows `degraded: true` in production:

1. Inspect `lastErrorCode`:
   - `access_denied` → check the IAM role attached to the API task / pod.
   - `not_found` → confirm `AWS_SECRET_NAME` matches the actual secret ID.
   - `network` → AWS endpoint reachability (VPC endpoints / NAT).
   - `decode` → the secret payload is not a JSON object of name→string.
2. The app is still serving traffic via env fallback. There is no urgency to bounce the API.
3. Restart any one API pod after fixing the cause. Verify the pod's health route shows `degraded: false`. Roll the rest.

---

## 7. Cache behaviour

- **TTL refresh.** Every `SECRETS_REFRESH_TTL_MS` (default 1 hour) the loader re-fetches the secret. A failed refresh **does NOT invalidate the previous cache** — the app keeps using the last successful values. This protects against transient AWS issues.
- **No request-time fetch.** `getSecret()` is synchronous and in-memory. There is zero AWS network traffic on the request path.
- **Single-process cache.** Each API instance has its own cache. Rotating a secret in AWS takes up to `SECRETS_REFRESH_TTL_MS` to propagate; a deploy / rolling-restart forces immediate re-hydration.

---

## 8. Migration strategy

The bounded allowlist `MIGRATED_SECRETS` defines which env names are sourced via AWS today:

| Secret | Migrated |
| --- | --- |
| `OPENAI_API_KEY` | ✅ |
| `AUTH_JWT_SECRET` | ✅ |
| `STRIPE_SECRET_KEY` | ✅ |
| `PAYPAL_SECRET` | ✅ |
| `RESEND_API_KEY` | ✅ |
| `TWILIO_API_KEY` / `TWILIO_API_SECRET` | not yet |
| `KMS_KEY_ID` (config string, not a secret) | n/a |
| `DATABASE_URL` | not yet |
| `IDENTITY_SECURITY_HASH_SECRET` | not yet |
| `COMMUNICATIONS_RECIPIENT_HASH_SECRET` | not yet |
| `API_KEY_SECRET` | not yet |
| `NOTIFICATION_CRON_SECRET` / `INTEGRATION_CRON_SECRET` | not yet |
| `PAYPAL_CLIENT_ID` / `PAYPAL_WEBHOOK_ID` | not yet |
| `STRIPE_WEBHOOK_SECRET` | not yet |

To migrate another secret:

1. Add the name to `MIGRATED_SECRETS` in `services/api/src/config/runtime-secrets.ts`.
2. Update the consuming code to call `getSecret(NAME)` instead of `process.env.NAME`.
3. Add the value to the AWS Secrets Manager payload (deploys can race here — keep the env value set until the next rolling deploy completes).
4. After the rolling deploy, optionally remove the env value from deployment manifests.

Order matters: it is safe to add to `MIGRATED_SECRETS` and AWS before flipping call-sites — the call-site fallback to env continues to work either way.

---

## 9. Security guarantees

- The loader logs **only** bounded error codes + key counts. It never serialises secret values.
- The `/v1/runtime/secrets-health` route never returns secret values or key names from the cache (only `cachedKeyCount` + the migrated allowlist with `source` per name).
- AWS SDK error messages are mapped to a bounded `lastErrorCode` enum before persistence; raw error stacks are not surfaced.
- `requireSecret(name)` throws an error containing only the secret name (never the value).
- No secret value is ever included in any audit event, metric label, or trace span.

---

## 10. Metrics

| Metric | Increments when |
| --- | --- |
| `secrets_fetch_success_total` | A boot or refresh hydration succeeds. |
| `secrets_fetch_failure_total` | A boot or refresh hydration fails. |
| `secrets_cache_refresh_total` | The periodic refresh loop fires. |
| `secrets_fallback_total` | AWS is enabled but a `getSecret()` resolved via env (i.e. the secret was missing from the AWS payload). |

All are bounded names registered in `packages/shared-runtime/src/ops/metrics.service.ts`. Cardinality is bounded — no per-secret labels.

---

## 11. Health route

`GET /v1/runtime/secrets-health?teamId=<uuid>`

**Auth:** active workspace member with `identity.member.read` permission.

**Response body:** see §4. **Never** carries secret values.

This is the only operational surface for secret hydration; there is no operator UI yet (the response is consumed by ops dashboards if needed).
