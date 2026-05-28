# SSO Health Dashboard (Phase P1.1)

**Audience:** identity admins responsible for SSO uptime + cert rotation.

**Canonical path:** `/security-center/sso/health`.

---

## 1. What it does

Aggregates the existing `SsoConnection` + `SsoCallbackAttempt` data into a per-connection health snapshot that's diagnosable from a single screen. No new tables, no new ingestion path — this is a read aggregator.

The snapshot covers:

- **Connection health status**: `HEALTHY` / `DEGRADED` / `OUTAGE` / `DISABLED` / `UNCONFIGURED`.
- **Cert expiry band**: `ok` / `warning` (≤90d) / `expiring` (≤30d) / `expired`.
- **Attempt counts** in two windows: last 24 hours and last 7 days. Each window breaks down into `total`, `failed`, `replayed`.
- **Failure-reason taxonomy** (bounded). See §3.
- **Recommended action** — operator-facing one-liner pointing to the next remediation step.

## 2. Health-status state machine

| Status | When |
| --- | --- |
| `DISABLED` | Connection status is `DISABLED` or `REVOKED`. |
| `UNCONFIGURED` | No `samlCertFingerprint` or status is `PENDING`. |
| `OUTAGE` | Cert is `expired`, OR an outage was previously detected and not cleared. |
| `DEGRADED` | Consecutive-failure count exceeds threshold, or cert is in `warning` / `expiring` band. |
| `HEALTHY` | Otherwise. |

Overall workspace status is the worst per-connection status across enabled connections.

## 3. Failure-reason taxonomy

The bounded set:

- `invalid_signature`
- `expired_certificate`
- `audience_mismatch`
- `acs_mismatch`
- `missing_nameid`
- `missing_email`
- `clock_skew`
- `replay_detected`
- `idp_unreachable`
- `metadata_invalid`
- `unknown`

Raw `SsoCallbackAttempt.failureReason` strings are mapped through `classifyFailure()` — operators never see the raw library error text, only the bounded category.

## 4. Recommended-action rules

`pickRecommendedAction()` picks one of:

| Trigger | Recommendation |
| --- | --- |
| `DISABLED` | "Connection is disabled. Re-activate to allow SSO logins." |
| `UNCONFIGURED` | "Ingest IdP metadata to configure." |
| Cert `expired` | "Rotate via the certificate rotation panel." |
| Cert `expiring` | "Stage a rotation certificate before the IdP rotates." |
| `invalid_signature` dominant | "Verify the IdP's signing cert matches the PROOVRA-side fingerprint." |
| `audience_mismatch` dominant | "Confirm the IdP's audience configuration." |
| `replay_detected` dominant | "Investigate possible session-replay attempt (audit center)." |
| Otherwise | `null` — connection is operationally fine. |

## 5. Audit events

- `sso_health_checked` (every read, severity INFO; WARNING when overall status is DEGRADED).

## 6. Metrics

- `sso_health_checked_total`
- `sso_health_degraded_total`

## 7. Honest scope

- This is a **read aggregator over existing data**. We do not poll the IdP. We do not synthesize health from SAML metadata pulls.
- The cert expiry computation runs on `samlCertNotAfter` ingested from the IdP's signing certificate during metadata ingestion. If that field is null (metadata never ingested) the band reports `ok` with `daysUntilExpiry: null` — the connection is flagged `UNCONFIGURED` upstream.
- The 7-day window is bounded by a hard limit of 1000 attempts read per connection. Workspaces with very high callback volumes may see the count understated; this is by design (bounded read), not a bug. Operators should still consult the audit center for incident forensics.
