# SCIM Drift Detection & Reconciliation (Phase P1.1)

**Audience:** enterprise IT admins who own the SCIM ↔ workspace relationship.

**Canonical paths:**

- `/admin/identity/scim` → **Drift detection** tab — preview + execute drift reconciliation.
- `/admin/identity/scim` → **Sync replay** tab — replay transient sync failures.

---

## 1. What problem this solves

Even when SCIM provisioning is operationally healthy, the workspace state and the IdP source of truth can diverge. The drift engine surfaces five categories of divergence and gives operators a step-up-gated way to reconcile them — without ever silently mutating data.

| Drift category | Meaning |
| --- | --- |
| `ORPHAN_LOCAL_MEMBERSHIP` | A workspace member has no active `ExternalIdentityMapping`. The user exists in PROOVRA but the IdP claims of provenance. |
| `UNLINKED_IDENTITY_ACTIVE_USER` | A user has only `unlinkedAtUtc`-bearing identity mappings but is still seen actively. |
| `STALE_TOKEN` | A SCIM provisioning token is `ACTIVE` but has not been used for `STALE_TOKEN_UNUSED_DAYS` (default 14). |
| `ORPHAN_SCIM_GROUP` | A `ScimGroup` row exists with zero linked members for `STALE_GROUP_DAYS` (default 30). |
| `DUPLICATE_EXTERNAL_SUBJECT` | Two or more rows share `(provider, externalSubjectId)` — the most dangerous category. |

The full preview is capped at 200 items per scan; truncation is surfaced explicitly in the UI.

## 2. Honest scope

- Detection is **read-only and local**. No IdP API calls. We do not pull user lists from Okta / Azure AD / Google; we only compare PROOVRA's own state against what SCIM has already pushed.
- The most destructive action is `SUSPEND_MEMBERSHIP`, which **demotes the member to VIEWER** — it never deletes the user, never removes audit history, and is reversible by an OWNER.
- Tokens flagged `ARCHIVE_TOKEN` are **revoked**, not deleted; the row remains for audit.
- `MANUAL_RESOLUTION` rows (e.g. duplicate external subjects) require an OWNER to read the audit center and decide which row is canonical — the engine refuses to guess.

## 3. Operating procedure

### Run a drift scan

1. Open `/admin/identity/scim`.
2. Click the **Drift detection** tab. The scan runs automatically.
3. Review the summary card: drift count by category, by risk level, and the destructive subset.

The preview is held in an in-process cache with a 5-minute TTL. After 5 minutes you must re-scan; the execute endpoint rejects stale preview ids with `stale_preview`.

### Execute reconciliation

1. Tick the rows you want to act on. Rows with `proposedAction: REVIEW_ONLY` are not selectable (intentional — they need human decision).
2. Click **Reconcile selected**.
3. The browser confirms the count.
4. The backend gates on step-up purpose `SCIM_RECONCILIATION_EXECUTE`. The step-up modal appears; complete the challenge.
5. The result panel reports `appliedCount`, `skippedCount`, and the per-row outcome (APPLIED / SKIPPED / FAILED).
6. The drift cache is invalidated; a fresh scan is triggered.

### Failure-mode handling

- **Stale preview**: the cache TTL elapsed. Re-scan and reselect.
- **Cross-workspace preview reuse**: rejected as `preview_not_found` (the workspace id is never leaked).
- **No items selected**: rejected as `no_items_selected`.
- **Row-level FAILED outcome**: an individual reconcile step raised an exception. The audit event chain still records the attempt. Inspect the audit center.

## 4. Sync replay

The Sync replay tab lists recent SCIM-side failure events:

- `scim_invalid_token` — terminal. Not replayable. Issue a new token.
- `scim_user_create_failed` / `scim_user_deactivate_failed` — transient. Replayable.
- `scim_group_membership_reconcile_failed` — transient. Replayable.

Clicking **Replay** does NOT push data to the IdP. The IdP retries on its own schedule; the replay action emits a `scim_sync_replayed` audit event so the operator-facing queue stays accurate.

## 5. Audit events

Every reconciliation operation emits at least one audit event. The bounded set:

- `scim_drift_scan_completed` (per scan)
- `scim_reconciliation_executed` (per execute call, severity WARNING)
- `scim_reconciliation_token_archived`
- `scim_reconciliation_membership_suspended`
- `scim_reconciliation_group_archived`
- `scim_sync_replayed`

All carry `actorUserId` and the affected resource ids in `details`.

## 6. Metrics

The bounded metric registry emits:

- `scim_drift_scan_started_total`
- `scim_drift_detected_total`
- `scim_reconciliation_executed_total`
- `scim_reconciliation_applied_total`
- `scim_sync_replay_total`

## 7. Limitations

- Single-instance preview cache. Multi-API-instance deployments need the shared-presence Redis adapter path (see `docs/operations/shared-presence-deployment.md`); without it, an operator must execute the reconcile from the same instance that issued the preview.
- The engine does not call the IdP's source of truth. If your IdP has drifted *away from* PROOVRA (e.g. you deleted a user in Okta and SCIM didn't push the deprovision), drift detection cannot tell — it only sees PROOVRA-side state. The mitigation is the standard SCIM dry-run procedure on the IdP side.
