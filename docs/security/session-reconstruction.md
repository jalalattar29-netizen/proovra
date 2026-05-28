# Bounded Session Identity Timeline (Phase P1.1)

**Audience:** identity admins triaging a specific operator session.

**Canonical path:** `/admin/identity/sessions` → click **View timeline** on any session row.

---

## 1. What it is (and what it isn't)

The Session Identity Timeline is a **privacy-safe, bounded reconstruction** of the identity-security events that occurred during a single operator session's lifecycle. It is intentionally **not** a surveillance system.

### What it shows

Only events from the bounded identity event-type allowlist:

- **Login family**: SAML / SSO / direct logins + assertion rejections + JIT outcomes.
- **MFA**: enrollment, challenges, verifications.
- **Step-up**: challenge started / verified / failed; high-risk action gates.
- **Trusted device**: trust / revoke.
- **Risk / adaptive auth**: suspicious session detected, privileged session blocked, quarantine + release.
- **Revocation**: per-session and bulk revoke.

### What it never shows

- Page views, mouse activity, idle time.
- Evidence content reads (those events live in the custody timeline, not the identity timeline).
- Raw IP addresses or user-agent strings — telemetry previews live on the parent sessions list, but the timeline drawer carries only the operator-safe summary + severity + event id.
- IdP secrets, raw SAML assertions, or callback payloads.

## 2. How the bracket is computed

Today the `SecurityEvent` table does not have a dedicated `sessionId` column (per the P1.1.0 audit). The timeline therefore uses **strategy A** from the audit:

> Events emitted for the session's `userId` between the session's `issuedAtUtc` and (`revokedAtUtc` ?? `lastSeenAtUtc` ?? `expiresAtUtc` ?? `now`), filtered to the bounded event-type allowlist.

This is **deterministic and Postgres-only**. It does not depend on Prisma JSON-path queries.

A migration to add a `SecurityEvent.sessionId` column would tighten the bracket; that's tracked as a deferred follow-up (not blocking P1.1 since the time-bracket method satisfies the operational use case — "what identity-security happened during this session?").

## 3. Bounded surface

- Maximum 200 events returned per timeline. The 201st acts as the truncation signal; the response carries `truncated: true` when this fires.
- Tenant gate: the route refuses sessions belonging to other workspaces. We return an **empty timeline** rather than a 404 — the parent route is already workspace-scoped, so this gate is belt-and-suspenders.

## 4. Operator-safe summaries

Every event type maps to a deterministic operator-readable summary via `humaniseIdentityEvent()`. Examples:

- `saml_login_succeeded` → "SAML login succeeded"
- `mfa_challenge_verified` → "MFA challenge verified"
- `session_quarantined` → "Session quarantined"
- `session_revoked_admin` → "Session revoked by admin"

The drawer renders the bounded event-type code (as a faint monospace label) alongside the summary so power users can correlate against the audit center.

## 5. Audit events

Viewing a timeline is itself audited:

- `identity_session_timeline_viewed` (INFO, captures `actorUserId`, `sessionId`, `eventCount`).

## 6. Metrics

- `identity_session_timeline_viewed_total`

## 7. Operating procedure

1. Open `/admin/identity/sessions`.
2. Find the session of interest (use the Show revoked / Show expired toggles if needed).
3. Click **View timeline** on the row.
4. The drawer opens on the right with:
   - The session metadata block (issued / expires / last seen / revoked + reason / SSO connection).
   - The event list, one vertical strip per event, sorted ascending by occurrence time.
5. Each event row shows severity (`INFO` / `WARNING` / `HIGH`), bounded event type, operator summary, and timestamp.
6. If truncated, the bottom of the drawer points to the Audit Center for the full history.

## 8. Honest scope

- We never expose page views or mouse trails. The product never built that telemetry; this is structural, not a deferred follow-up.
- The bracket method understates events when a security event records to the user but happens **outside** the session's lifecycle bracket (e.g. a `user_logged_out` from a different concurrent session). Use Audit Center for cross-session correlation.
- A future migration that introduces `SecurityEvent.sessionId` will tighten the bracket and remove this caveat. That's deferred — see §2.
