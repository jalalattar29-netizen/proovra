# PHASE R8.1.9 — Session-light, Email-side Snooze Link, Send-test Digest & Admin Recovery Event Feed

**Status:** Shipped
**Date:** 2026-05-25
**Predecessors:** R8 → R8.1.8 (cryptographic MFA, login challenge, durable challenge store, org enforcement, scheduled GC, circuit breaker, admin lifecycle, lost-factor recovery with verified-email preflight, admin SPA, self-cancel, per-org fail-mode, user-facing verify page, per-account throttle, admin quorum SPA, pending digest job, consolidated multi-team digest, digest preferences endpoints, preferences UI, snooze quick action, digest preview endpoint + UI, HTML digest email, verify-page auth optimization)

## What this phase closes

R8.1.8 named four remaining operational polish gaps. R8.1.9 closes all four:

1. **Verify page still called `/v1/auth/me` for session detection** — the dedicated session-light endpoint (`GET /v1/auth/session-light`) is cleaner, lighter, accepts both Bearer _and_ HttpOnly cookie, and returns only `{ authenticated: boolean }` with no user data leakage.
2. **No one-click snooze in digest emails** — admins had to click through to the admin console to snooze. R8.1.9 embeds a signed one-click snooze URL directly in the email body.
3. **No send-test flow for the admin** — admins couldn't send themselves a test digest to validate their preferences before relying on the daily worker. R8.1.9 adds a rate-limited send-test endpoint.
4. **No admin-facing recovery event feed** — admins couldn't see a chronological feed of `mfa_recovery_*` security events scoped to their teams. R8.1.9 adds a bounded, labeled event feed endpoint.

## What this phase deliberately does NOT do

- Does NOT create a session from the snooze-link endpoint or the send-test endpoint (contract tests 13–18). Neither endpoint calls `signJwt`, sets a cookie, or modifies session state.
- Does NOT return raw `details` JSON from the event feed. The feed builds bounded, human-readable summary labels from the `eventType` enum and short id hash-prefixes (contract test 20).
- Does NOT expose OTPs, recovery codes, TOTP secrets, ciphertext, IVs, auth tags, or raw user emails in any R8.1.9 surface.
- Does NOT introduce a parallel auth surface. `session-light` lives inside `auth.routes.ts` alongside the canonical session endpoint (contract bonus A).
- Does NOT touch capture / upload / custody / report-package / TSA / OTS (contract bonus C).

## Part 1 — Session-light endpoint

### `GET /v1/auth/session-light`

Intentionally **unauthenticated** (no `requireAuth`). The endpoint:

1. Extracts the token from the `Authorization: Bearer …` header OR from the `proovra_session` HttpOnly cookie.
2. Verifies the signature and expiry using `verifyJwt`.
3. Refuses pending-MFA tokens (`payload.mfa === "pending"` → `{ authenticated: false }`).
4. Checks the session revocation registry (`isSessionRevoked`). Collapses to `false` on any registry read error (fail-closed).
5. Returns exactly `{ authenticated: boolean }`. Nothing else.

**Hard rules:**
- NEVER mutates session state.
- NEVER refreshes the session cookie.
- All error states (invalid signature, expired, missing, revoked, pending MFA) collapse to `{ authenticated: false }` without leaking the specific reason.

### Why this replaces R8.1.8's `/v1/auth/me` probe

R8.1.8 optimized the verify page to check `localStorage["proovra-token"]` before calling `/v1/auth/me`. The optimization prevented an unnecessary round-trip for anonymous users, but introduced an HONEST CAVEAT: SSO-only users whose session exists as an HttpOnly cookie only (no localStorage entry) were classified as anonymous and shown the "Return to sign in" CTA.

`session-light` accepts the HttpOnly cookie directly at the server, so the localStorage pre-check is no longer needed. SSO-only users now receive the "Continue to home" CTA correctly.

## Part 2 — Verify page session-light integration

`apps/web/app/auth/mfa-recovery/verify/page.tsx` updated:

- The post-verify session detection now calls `GET /v1/auth/session-light` unconditionally (no localStorage pre-check).
- `probe.authenticated` replaces `me?.user?.id` as the boolean source.
- The R8.1.8 localStorage pre-check (`hasLocalToken`) is removed.

The page remains NEVER minting a session: no `signJwt`, no `setToken`, no `document.cookie =`, no `setCookie('proovra_session', …)`.

## Part 3 — Signed digest snooze token

`services/api/src/services/security/mfa-digest-snooze-token.ts` (new)

Pure HS256 JWT utility — no Prisma, no fetch. Exports:

| Export | Purpose |
|---|---|
| `signMfaDigestSnoozeToken(input, secret)` | Builds a signed snooze token embedding `purpose`, `sub`, `teamId`, `snoozeSeconds`, `jti`, `iat`, `exp` |
| `verifyMfaDigestSnoozeToken(token, secret)` | Verifies sig, expiry, and purpose; returns `{ ok, payload?, reason? }` |
| `MFA_DIGEST_SNOOZE_PURPOSE` | `"mfa_recovery_digest_snooze"` discriminator constant |
| `MFA_DIGEST_SNOOZE_TTL_SECONDS` | 15 days — token TTL matches snooze duration |

**Hard rules:**
- Token purpose `"mfa_recovery_digest_snooze"` is checked by `verifyMfaDigestSnoozeToken`; any other value returns `wrong_purpose`.
- Signature verified with `timingSafeEqual` — no naive string comparison.
- JTI (`randomBytes(16).toString("hex")`) is unique per signing — single-use enforcement at the endpoint layer.
- Token cannot outlive the snooze it describes (`exp = now + snoozeSeconds`).

## Part 4 — Email-side signed snooze link endpoint

### `GET /v1/identity/mfa-admin/digest-preferences/snooze-link?token=…`

**Anonymous** — the signed token is the auth proof for this single action.

Lifecycle:
1. Extract `?token=` from the query string. Return 400 if absent.
2. `verifyMfaDigestSnoozeToken` — check sig + expiry + purpose. Return 400 on failure.
3. In-process JTI replay guard (`snoozeLinkJtiSeen`). Return 409 on replay.
   - Multi-instance correctness: the worst case (two replicas each accepting the token once) writes the same `suppressUntil` twice — idempotent outcome.
4. Apply snooze: `updateDigestPreference({ actorUserId: payload.sub, teamId: payload.teamId, suppressUntil: now + snoozeSeconds })`.
5. Emit `mfa_recovery_digest_snooze_link_used` security event.
6. Return `{ ok: true, message, suppressUntil }`.

The URL is built using `buildMfaDigestSnoozeUrl` (exported from `mfa-admin.routes.ts` for email-service callers).

## Part 5 — Send-test digest endpoint

### `POST /v1/identity/mfa-admin/digest-preferences/preview/send-test`

**Authenticated** (`requireAuth`). Rate-limited per user:
- Max **3** test emails per rolling 24-hour window.
- Min **60-second** cooldown between tests.

On accept:
1. Builds a `previewDigestForAdmin` payload (same as the preview endpoint, `includeSuppressed: false`).
2. Looks up the admin's own email address (`prisma.user.findUnique`).
3. Builds a signed global snooze URL (`buildMfaDigestSnoozeUrl`) for inclusion in the test email.
4. Sends via `email.sendMfaRecoveryAdminDigestEmail(email, "[TEST] preview for …", requestCount, adminSpaUrl, snoozeUrl)`.
5. Emits `mfa_recovery_digest_test_sent` (success) or `mfa_recovery_digest_test_failed` (transport failure) as security events and analytics.

**Hard rules:**
- Send target is ALWAYS the calling admin's own email — never another address.
- The test email does NOT write `MfaRecoveryAdminDigestLog` — the daily worker tick is unaffected.
- Subject is prefixed `[TEST]` so the admin can unambiguously distinguish a test from a scheduled digest.

## Part 6 — Digest email snooze link copy

### `sendMfaRecoveryAdminDigestEmail` update

The `EmailService` interface and implementation now accept an optional fifth parameter:

```typescript
snoozeUrl?: string | null
```

When provided, both the HTML body and the plain-text body include:

**HTML:** A low-profile info block:
> Not ready to review now? [Snooze these digest emails for 15 days] — security events and audit logs are unaffected.

**Text:**
> To snooze these digest emails for 15 days: `<snooze-url>`

When omitted (e.g. `RESEND_API_KEY` not configured in dev), the email is sent without the snooze block. Backward-compatible — existing callers that pass 4 arguments still compile.

### Worker update (`mfa-recovery-digest.ts`)

The worker's `sendAdminDigest` helper now accepts `snoozeUrl: string | null` and conditionally embeds the block in both the HTML and text bodies. The worker builds the snooze URL for each admin using `buildDigestSnoozeUrl(adminUserId)` — a self-contained inline implementation of the same HS256 JWT signing as `mfa-digest-snooze-token.ts`. Returns `null` when `AUTH_JWT_SECRET` is absent (test environments without secrets), causing the email to be sent without the snooze link.

## Part 7 — Admin recovery event feed

### `GET /v1/identity/mfa-admin/recovery-events?limit=N&windowDays=D`

**Authenticated** (`requireAuth`). Service: `readRecoveryEventFeed`.

Returns a bounded, labeled chronological list of `mfa_recovery_*` security events scoped to the actor's ACTIVE OWNER/ADMIN teams. Pagination: `limit` (default 100, max 200), `windowDays` (default 14, max 60).

**Row shape:**
```typescript
interface RecoveryFeedRow {
  id: string;
  eventType: string;       // bounded enum
  severity: string;        // bounded enum
  createdAt: string;       // ISO
  teamId: string | null;
  teamName: string | null; // resolved from Team table
  summary: string;         // human-readable label — NEVER raw details
}
```

**Hard rules:**
- `details` is fetched from Prisma only to build the `summary` label. It is NEVER returned to the caller.
- `buildSummary` uses the bounded `eventType` enum + a 8-char id hash-prefix of `actorUserId`/`targetUserId` when present. No email addresses, no tokens, no free-form payload dump.
- Tenant-scoped strictly to the actor's ACTIVE OWNER/ADMIN memberships. Cross-team reads are impossible.
- Read-only — no `SecurityEvent` write is performed by this service.

Emits `mfa_recovery_event_feed_viewed` analytics on every call for adoption tracking.

## New security events (R8.1.9)

| Event | Severity | Emitter |
|---|---|---|
| `mfa_recovery_digest_snooze_link_used` | `INFO` | Snooze-link route |
| `mfa_recovery_digest_test_sent` | `INFO` | Send-test route |
| `mfa_recovery_digest_test_failed` | `WARNING` | Send-test route on transport error |

Analytics event: `mfa_recovery_event_feed_viewed` (route layer only).

## Operational notes

### Session-light reliability

`session-light` fails closed: any error (Prisma timeout on revocation lookup, malformed JWT, missing secret) collapses to `{ authenticated: false }`. The verify page continues to render `Return to sign in` — a slightly degraded UX vs `Continue to home` but never a false session claim.

### Snooze token cross-instance replay

Single-process replay is enforced by `snoozeLinkJtiByExp` (in-process Map). Multi-instance replay: two API replicas each accepting the same token once results in `updateDigestPreference` being called twice with the same `suppressUntil` — idempotent outcome (snoozed for 15 days either way). There is no observable security difference.

### Worker signing autonomy

The worker's `buildDigestSnoozeUrl` duplicates the HS256 signing logic from `mfa-digest-snooze-token.ts` to avoid a cross-service import dependency. Any future change to the token shape (payload fields, algorithm, TTL) **must be applied to both implementations simultaneously**.

### What does NOT change

- The daily digest worker schedule and idempotency log remain unchanged.
- The admin SPA (`/security-center/mfa-recovery`) receives no code changes in R8.1.9.
- Capture / upload / custody / report-package / TSA / OTS are completely unaffected.
