# Migration Deployment Plan — PHASE 12 POINT 6

**Nothing in this plan has been applied to production.** The agent inventoried,
classified, rehearsed and validated the migration set; the owner executes it.
The step-by-step command sequence lives in
[`docs/operations/point6-migration-runbook.md`](../operations/point6-migration-runbook.md).

The machine-readable authority is
[`docs/architecture/migration-inventory-p6.json`](./migration-inventory-p6.json)
(one record per migration directory, regenerated from disk by
`pnpm --filter proovra-api db:migration-inventory:write`). The authored
dispositions it merges are in `migration-inventory-p6.curation.json`. This
document is the human-readable projection of the same data and must not
disagree with it — `services/api/test/phase-12-point6-migration-closure.test.ts`
fails if a pending migration is missing from this file.

Supersedes the 2026-07-27 plan of the same name, and supersedes the MIGRATION
half of `schema-migration-classification.json` (its MODEL half is still
authoritative).

---

## 1. Inventory summary

| | count |
|---|---|
| migration directories on disk | **221** |
| classified | **221** (UnclassifiedMigrations = 0) |
| BASELINE | 1 |
| HISTORICAL_PRESERVE | 184 |
| EXPAND | 15 |
| REPAIR | 3 |
| BACKFILL | 12 |
| CONTRACT_DROP | 6 |
| CUTOVER (SQL) | 0 — cutover is a *runtime* step, not a migration |

Conservation, machine-checked on every run:

```text
FilesystemMigrations (221)
= ClassifiedMigrations (221)
= AppliedInProduction (0) + PendingInProduction (0) + ProductionSnapshotUnknown (221)
```

`ProductionSnapshotUnknown = 221` because **no production database was
contacted**. `P6_PRODUCTION_READONLY_DATABASE_URL` is not configured in this
environment, and the collector deliberately refuses to fall back to
`DATABASE_URL`, `DIRECT_URL` or `SHADOW_DATABASE_URL`. See §7.

---

## 2. Release A — prerequisites and Expand/Repair · `SAFE_TO_APPLY_NOW`

19 migrations. **No destructive statement. No pre-existing row is mutated.**
Every one is backward-compatible with the currently deployed build.

| migration | class | safe before code deploy |
|---|---|---|
| `20270920000000_account_closure_requests` | EXPAND | yes |
| `20270920100000_org_invite_workspace_assignments` | EXPAND | yes |
| `20270920200000_membership_grant_provenance` | EXPAND | yes |
| `20270921000000_organization_closure_requests` | EXPAND | yes |
| `20270922000000_workspace_closure_requests` | EXPAND | yes |
| `20270925000000_user_identity_mode` | EXPAND | yes |
| `20271001000000_org_security_policy_phase10` | EXPAND | yes |
| `20271002000000_managed_identity_ownership` | EXPAND | yes |
| `20271004000000_authenticated_session_org_context` | EXPAND | yes |
| `20271006000000_org_security_policy_lifecycle` | EXPAND | yes |
| `20271101000000_audit_tenant_columns` | EXPAND | yes |
| `20271102000000_uuid_id_default_repair` | REPAIR | yes |
| `20271106000000_legal_hold_canonical` | EXPAND | yes |
| `20271111000000_step_up_session_organization_binding` | EXPAND | yes |
| `20271112000000_point4_write_unblock_repair` | REPAIR | yes — **fixes a LIVE production write failure** |
| `20271113000000_point5_report_generation_authority` | EXPAND | yes |
| `20271114000000_point5_media_intelligence_kind_catalog` | REPAIR | yes |
| `20271119000000_search_document_embedding_after_extension` | EXPAND | yes — idempotent; a no-op wherever the objects already exist |
| `20271120000000_external_review_invitation_authority_expand` | EXPAND | yes — nullable/defaulted columns only; nothing reads them until the code deploys |
| `20271121000000_external_review_invitation_authority_backfill` | BACKFILL | yes — deterministic, re-runnable, touches no business-visible counter and invents no delivery outcome |
| `20271123000000_workspace_kind_authority_expand` | EXPAND | yes — a partial index and a column comment |
| `20271124000000_workspace_kind_authority_backfill` | BACKFILL | yes — classifies from structural authority only; conditioned on `workspace_kind IS NULL` |
| `20271126000000_org_membership_lifecycle_expand` | EXPAND | yes — nullable/defaulted lifecycle columns, attribution FKs and read indexes only |
| `20271127000000_org_membership_lifecycle_backfill` | BACKFILL | yes — states ACTIVE explicitly; invents no suspension, revocation or actor |
| `20271129000000_automation_runtime_durability_expand` | EXPAND | yes — widens two VARCHAR(20) status columns to (32), adds nullable/defaulted fence + ambiguity columns and partial indexes, and WIDENS two status CHECKs. Widening a CHECK or a VARCHAR can never invalidate an existing row |
| `20271130000000_automation_runtime_durability_backfill` | BACKFILL | yes — deterministic, re-runnable; leaves historical source-event ids NULL and historical RUNNING runs unresolved rather than inventing either |
| `20271215000000_search_index_reconciliation_kind` | EXPAND | yes — one `ALTER TYPE … ADD VALUE IF NOT EXISTS` on `GovernanceReconciliationKind`. Idempotent, additive, and unread by the deployed build until the Search reconciliation code ships |
| `20271216000000_evidence_integrity_incident_category` | EXPAND | yes — one `ALTER TYPE … ADD VALUE IF NOT EXISTS` on `IncidentCategory`. Idempotent and additive: no table, no column, no row rewritten, and unread by the deployed build until the Attention-Architecture Phase-3 integrity writer ships. Deliberately carries NO backfill — opening conditions for historically failed evidence would stamp `first_seen_at_utc` with the migration clock, and that column feeds age-based severity escalation, so a backfill would manufacture CRITICALs out of a schema change |
| `20271217000000_evidence_integrity_correlation` | EXPAND | yes — one nullable `VARCHAR(80)` column plus a partial index over its non-null rows. No constraint, no data change, no history rewrite. Carries NO backfill: historical failures have no recorded execution, and inferring one from reason/provider/time would manufacture the grouping the retracted TSA finding forbids |
| `20271218000000_bulk_assign_incidents` | EXPAND | yes — one `ALTER TYPE … ADD VALUE IF NOT EXISTS` on `BulkOperationalActionType`. Idempotent and additive: no table, no column, no constraint, no row rewritten, and unread by the deployed build until the Phase-B bulk-assignment route ships. Deliberately reclassifies NO historical run — a past sweep that assigned workflows assigned workflows, and relabelling it would rewrite the record of what an operator actually did |
| `20271219000000_incident_sla_history` | EXPAND | yes — two new tables plus indexes and foreign keys. No existing table, column or row is touched; unread by the deployed build until the Phase-B-closure SLA projection ships. Carries NO backfill: incidents existing at apply time report `UNTRACKED_LEGACY`, because stamping them with a policy that was never in force would invent a deadline and then invent whether it was missed |
| `20271220000000_evidence_lifecycle_trashed_state` | EXPAND | yes — one `ALTER TYPE … ADD VALUE IF NOT EXISTS` adding `TRASHED` to `EvidenceLifecycleState`, two nullable TIMESTAMPTZ columns (`destroyed_at_utc`, `destruction_claimed_at_utc`) and one guarded composite index. Idempotent and additive: no table, no constraint, no row rewritten, and inert until the lifecycle code ships — the deployed build never emits `TRASHED` and never reads either column. The index is wrapped in an `information_schema` DO guard because it names two columns this migration does not create |
| `20271220000001_evidence_lifecycle_state_backfill` | BACKFILL | yes — two UPDATEs converging `lifecycle_state` with the timestamps that were the de-facto product-state authority (`deleted_at` → TRASHED, then `archived_at` → ARCHIVED), both excluding rows already DESTROYED and already in the target state, so a second run is a no-op. Destruction is NEVER inferred: `deleted_at` maps to TRASHED and nothing else, because the purge worker set it ninety days BEFORE deleting anything and the two paths that emitted destruction certificates deleted no bytes at all — reading it as destruction would manufacture a tombstone for every recoverable record in every workspace's trash. Governance-internal postures (UNDER_REVIEW / ON_HOLD / RETENTION_LOCKED / PENDING_DESTRUCTION) are LEFT ALONE rather than reset to ACTIVE: no other column records them. Readiness: `node services/api/scripts/evidence-lifecycle-state-readiness.mjs` |
| `20271222000000_workspace_operations_reconciliation_kind` | EXPAND | yes — one `ALTER TYPE … ADD VALUE IF NOT EXISTS` on `GovernanceReconciliationKind`, adding `WORKSPACE_OPERATIONS`. Idempotent and additive: no table, no column, no constraint, no row rewritten, and unread by the deployed build until the scheduled Operations reconciler ships. MUST APPLY BEFORE THE CODE — the reverse order is a measured outage, not a theoretical one: `SEARCH_INDEX` shipped code-first once and every reconciler tick died on `invalid input value for enum` at its first workspace, silently, because the claim row could not be written. Kept as its OWN migration because PostgreSQL will not let a value added by `ADD VALUE` be USED in the transaction that adds it |
| `20271223000000_operational_incident_scope` | EXPAND | yes — the `IncidentScope` enum, `operational_incidents.scope NOT NULL DEFAULT 'WORKSPACE'`, a bounded reclassification of NULL-team rows to `LEGACY_UNSCOPED`, and one guarded index. Nothing dropped, no type narrowed, no row deleted, and the `ON DELETE SET NULL` foreign key left exactly as it is. Every statement guarded, so a partial apply can be re-run. Unread by the deployed build until the scope-discriminated reads ship, and an older build ignores the column entirely. The reclassification CLAIMS NOTHING AS PLATFORM: no writer in this codebase records a deliberate platform-wide incident, so deriving `PLATFORM` from a NULL would invent the intent the column exists to record |
| `20271224000000_operational_incident_naming_convergence` | REPAIR | yes, and it is the one that must apply BEFORE the API and Worker images — the writer is broken until it does, and it REMOVES NOTHING. Production carries BOTH column families on `operational_incidents` / `operational_incident_events`: the canonical snake_case columns migrations manage, and a legacy camelCase family named after Prisma FIELD names, produced when those fields carried no `@map`. `20260620200000_reviewer_ops_naming_drift_repair` documented that mechanism on other tables and deferred the cleanup ("a separate cleanup migration will drop them"); for these tables it was never written. Measured, not theorised: `safe_summary` is `VARCHAR(400) NOT NULL` with no default, so its legacy twin is too, and the real `recordIncident` fails **P2011 / 23502 `null value in column "safeSummary"`** at `create()` while the LOOKUP succeeds — which is why every read surface kept working and `/readyz` answered ok. This migration backfills canonical-from-legacy where canonical IS NULL, PROVES no row holds a legacy value its canonical column lacks, DROPS the legacy NOT NULLs (a relaxation, not a removal — this is what unblocks the writer), and rebuilds the unique/indexes/FK on the canonical columns. Idempotent: on any database that never drifted it does nothing except assert the canonical unique exists |
| `20271225000000_operational_incident_metric_snapshot` | EXPAND | yes — one nullable `jsonb` column, `operational_incidents.metric_snapshot`, added with `ADD COLUMN IF NOT EXISTS`. No default, no index, no constraint, no type change and no row rewritten. It exists because the number an aggregate condition is ABOUT lived in `title` — `Report backlog above threshold (26)` — and `recordIncident` never rewrote the title on re-observation, so 26 was written once and then frozen: a workspace that worked its backlog down to 22 kept reading 26 for the life of the condition. NO BACKFILL, deliberately: a metric is an OBSERVATION, and stamping historical rows with a count nobody measured would be the same fiction in a new column. Existing rows keep NULL, which decodes to "no metric" and renders exactly as they render today. Safe in both directions — an older build never selects the column, and a rolled-back build simply leaves it unread |
| `20271226000000_operational_incident_source_identity` | BACKFILL | yes — one nullable `VARCHAR(120)` `operational_incidents.source_id`, then one `UPDATE` per unambiguous legacy fingerprint prefix, each guarded by `source_id IS NULL` so re-running is a no-op. It exists because a condition's lifecycle — who may resolve it, which probe answers "is it still true", how it recovers, who it is for — was derived from `category` (fourteen values for thirty-five sources) and then from `fingerprint`, which covered the eleven shapes the discovery sweep writes and left **fifteen other production emitters in both hosts** falling through to an "unregistered" contract that was `OPERATOR_DECISION`. A condition the system could not identify was therefore the most closable kind there is. Every writer now passes a typed source id and this column persists it. **NO NOT NULL in this deployment** — that is a later one, after the backfill has been observed in production; new writes are enforced by the typed writer signature rather than by the database. NO INDEX: the only predicate reading the column is the tenant-surface exclusion of `PLATFORM_INTERNAL` sources, which filters a scan the existing `(scope, team_id, status)` index already selects. **NO HISTORY IS REWRITTEN**: `operational_incident_events` and `operational_incident_sla_cycles` are neither read nor written, and no status, resolution, note, actor or occurrence count changes. Rows matching no prefix stay NULL and fail closed at runtime to `NO_DIRECT_RESOLUTION`. Readiness: `node services/api/scripts/operations-source-identity-readiness.mjs` |
| `20271227000000_billing_commercial_correctness` | EXPAND | no — three additive changes, no backfill, no row rewritten. (1) `evidence_credit_ledger_entries`: the auditable evidence-credit wallet. `entitlements.credits` was a bare integer with no history, and the consume path read it, compared it in application memory, then decremented in a separate statement against the **global** prisma client from inside the evidence-completion transaction — so a rolled-back completion still burned the customer's credit, and a double-spend was undetectable after the fact. The table's UNIQUE `evidence_id` makes consumption idempotent per Evidence record and serialises two concurrent completions; a PARTIAL unique index on `(provider, provider_ref) WHERE entry_type='PURCHASE'` prevents double-crediting one payment. **Existing balances are untouched** and read as an opening balance, so no purchased credit is lost. (2) `subscriptions.cancel_at_period_end BOOLEAN NOT NULL DEFAULT false` + `canceled_at_utc`: the provider-confirmed cancellation lifecycle; the DEFAULT preserves every existing row's meaning exactly. (3) `enterprise_contracts.evidence_records_per_month` + `ai_operations_per_month`, nullable: contract-managed allowances, NULL meaning the contract is silent and the catalog default applies. **NO NOT NULL, no index on the new subscription columns, no constraint change.** The CREATE TABLE uses a Phase O-Final `information_schema` guard, not `CREATE TABLE IF NOT EXISTS`, so column evolution cannot be silently skipped. Apply BEFORE deploying API and Worker; until it runs, credit purchases remain unspendable past the free allowance (the pre-existing defect) and cancellation keeps its current immediate semantics. |
| `email_password_auth` | EXPAND | yes — proven byte-identical no-op twin |
| `20271228000000_billing_provider_state_ordering` | EXPAND | no — two nullable columns, no default, no backfill, no row rewritten: `subscriptions.provider_state_at_utc` and `workspace_storage_addons.provider_state_at_utc`. Provider reconciliation learns state by **polling**, and a poll that starts before a webhook lands can finish after it — so without an ordering signal a stale "still active" reply could resurrect a subscription the provider had already cancelled, and a stale "cancelled" could tear down one the customer had just renewed. `updated_at` cannot decide it: that records when **we** last wrote the row, not when the **provider's** state was true. These columns hold the provider's own authoritative timestamp for the state that produced the last write, and any observation older than it is discarded rather than applied. **No second ledger and no second state machine** — payment idempotency still comes from the existing `payments (provider, provider_payment_id)` unique constraint, and credit idempotency from the existing partial unique index on PURCHASE ledger rows. NULL is meaningful ("no provider time recorded yet") and the guard treats it as accept-and-record, so every existing row reconciles normally on its first pass instead of being frozen out. **NO NOT NULL, no index, no constraint change.** Apply BEFORE deploying API; until it runs the ordering guard degrades to accept-every-observation, which is the behaviour that existed before reconciliation rather than a regression. |
| `20271229000000_billing_dependent_cancellation_obligation` | EXPAND | no — one enum, nine columns and one partial index, no backfill, no row rewritten. A recurring Storage add-on is its **own** provider subscription, so cancelling PRO or TEAM cannot stop it atomically. A failed dependent call previously left **nothing** behind — the failure was an in-memory counter that died with the HTTP response — so the add-on kept renewing with no retry, no alert and no way to query for it. These columns make the **obligation** durable, extending the existing add-on authority rather than opening a parallel ledger. **NO BACKFILL:** every existing row defaults to `NONE`, which is exactly true (nobody asked for it to be cancelled), and inventing an obligation for a historical row would invent a customer intention. Legacy `ONE_TIME` add-ons never leave `NONE`. The index is **partial** over the four unresolved states, so it is proportional to outstanding work rather than to every add-on ever sold, and is registered in the raw-schema ownership manifest. **NO NOT NULL beyond two safe defaults, nothing dropped, renamed, retyped or narrowed.** Apply BEFORE deploying API and Worker; until it runs a failed dependent cancellation stays transient, which is the pre-existing behaviour rather than a regression. |
| `20271230000000_workspace_lifecycle_authority` | EXPAND | no — one nullable column and its index, no NOT NULL, nothing dropped, renamed, retyped or narrowed: `teams.closed_at_utc`. **WHY:** `executeWorkspaceClosure` revoked every membership, revoked API credentials, disabled webhooks and cleared switcher pointers, and left the `teams` row byte-for-byte indistinguishable from a live workspace — so every Platform Admin population query counted closed workspaces as live, and closure touches neither `billing_plan` nor `billing_status`, so a closed workspace on a paid plan kept reporting as an active paying customer. **WHY A COLUMN AND NOT A DERIVED PREDICATE:** deriving liveness from *has no COMPLETED `workspace_closure_requests` row* is provably wrong here — `reopenClosedWorkspace` deliberately leaves that row in place as history, so a derived predicate would mark every reopened workspace closed forever. Closure sets the column; reopen clears it. Billing state is **not** lifecycle state and is never substituted for it. **BACKFILL:** idempotent and evidence-based — a workspace is claimed closed only when its newest COMPLETED closure request is newer than its newest `workspace_reopened` `team_activities` row (or no such row exists), and it writes only where `closed_at_utc IS NULL`, so re-running changes nothing. Ambiguous history stays **LIVE**, the direction that over-reports rather than hiding a real tenant from its operator. Apply BEFORE deploying API and Worker: the column is additive and nullable, so code that does not yet know about it behaves exactly as it does today. |
| `20271231000000_billing_scheduled_plan_change` | EXPAND | no — two nullable columns on `subscriptions`, no default, no index, no constraint, no backfill and no row rewritten: `pending_plan` (PlanType) and `pending_plan_effective_at_utc` (TIMESTAMPTZ). FREE, PRO and TEAM are now three tiers of the **same Personal Workspace** rather than plans belonging to different subjects, so a customer can move in both directions — and moving **down** must take effect at period end, because they have already paid for the period they are in and a downgrade that removed capacity on request would take back something already bought. That creates a state the row could not express: the subscription is still TEAM, and it is going to be PRO on a known date. The existing `plan` column is the plan **in force**, and writing the future one into it would make enforcement, the usage meters and the plan card apply the downgrade immediately — the exact outcome period-end scheduling exists to prevent. Both columns are written **only after the provider accepts the schedule**, never as a local intention, and both are cleared by `upsertSubscription` when the provider reports the scheduled plan is in force or the subscription has ended — so there is **no second state machine**: the plan in force is still written by `syncPlanForSubscription`, the one handler the webhook and reconciliation both call. **NO BACKFILL:** NULL means "no change scheduled", which is what every existing row means today; synthesising a pending plan for a historical row would invent a customer decision nobody made. **NO NOT NULL, nothing dropped, renamed, retyped or narrowed, no enum value added.** Apply BEFORE deploying API; until it runs, a period-end downgrade cannot be recorded and the change route returns a provider error rather than a wrong answer, and no existing subscription changes. A rollback loses the **local** record of a schedule the provider still holds — the downgrade still lands and the webhook still applies it — so what is lost is a customer-facing promise, not a plan anyone is on. |
| `20280101000000_billing_payment_terminal_states` | EXPAND | no — two new values on the `PaymentStatus` enum (`CANCELED`, `EXPIRED`) and one nullable `TIMESTAMPTZ` column on `payments` with no default, no index, no constraint, no backfill and no row rewritten: `provider_state_at_utc`. **Why the enum values:** a payment could only be PENDING, SUCCEEDED, FAILED or REFUNDED, and a checkout the customer abandoned is none of those — no money was ever attempted, so FAILED says a charge was declined that never happened, and it is never coming, so PENDING is a lie that lasts for ever. The Billing page listed months-old rows reading "Pending" with no way to tell whether a charge was still on its way and no state such a row could reach. Both new values have **real writers** and both come only from a provider answer: EXPIRED when Stripe reports a Checkout Session expired — including one this product asked Stripe to expire — and CANCELED when a provider reports the transaction cancelled. Neither is ever written from a local intention; PayPal exposes no operation that cancels an unapproved order, so a PayPal row is refused rather than marked locally. **Why the column:** `provider_state_at_utc` is the ordering guard, named and shaped exactly like `subscriptions.provider_state_at_utc`, and read by the one shared transition every writer goes through — so an observation older than the state already recorded is discarded, a slow poll cannot overwrite a newer webhook, and a redelivered PENDING cannot move a settled payment backwards. **No backfill:** NULL means "no provider time recorded yet", which is what every existing row means today and which the guard reads as accept-and-record. Adding an enum value is permitted inside a transaction on PostgreSQL 12+ provided the new value is not used in the same transaction, and this migration uses neither. **Nothing dropped, renamed, retyped or narrowed; no payment row's status is changed.** Apply BEFORE deploying API; until it runs, a re-check that learns a payment expired cannot record it and the route answers PROVIDER_UNAVAILABLE rather than a wrong answer. A rollback before any row reaches the new values is indistinguishable from today; after one exists, the older image never writes it and no aggregate depends on it. |

> **PHASE 12 CORRECTIVE PASS §2/§3/§5.2 (2026-08-06).**
> `20271120000000_external_review_delivery_intent_idempotency` was REPLACED. It
> was classified EXPAND / "rewrites no history" while its first statement
> re-numbered every historical `attempt` value; renumbering a business-visible
> counter is a rewrite. It had never been committed and never applied outside a
> disposable database, so the replacement rewrites no deployed history. The two
> CONTRACT migrations that complete the work —
> `20271122000000_external_review_invitation_authority_contract` and
> `20271125000000_workspace_kind_authority_contract` — are Release D, listed in
> the contract table below.

> **PHASE 12 CORRECTIVE PASS §1/§2 CONTINUATION (ARCH-005, 2026-08-07).**
> The Automation runtime had a schema, an API and a UI and NO runtime: its
> dispatcher had zero production callers and its delivery path was an
> in-process `setImmediate`. `20271129000000` adds the durability the feature
> never had — a lease, a monotonic claim fence, an attempt counter, a retry
> schedule, a dead-letter, and the AMBIGUITY pair.
>
> Two things in it deserve a deployment note. First, it WIDENS
> `automation_runs.status` and `automation_webhook_deliveries.status` from
> VARCHAR(20) to VARCHAR(32): `DEAD_LETTERED_UNKNOWN` is 21 characters, and at
> (20) the widened CHECK accepted a value the COLUMN then refused — a rejection
> that surfaces as a write matching no rows, which is indistinguishable from
> ordinary fence contention, so a reconciler would revisit the same row forever
> without ever terminating it. Second, it is EXPAND despite touching a CHECK
> and a column type, because both changes are WIDENINGS: every value that was
> legal before is legal after, no row is rewritten, and no reader changes
> behaviour until the code deploys.
>
> `20271130000000` is a genuine BACKFILL and is scheduled as one — it is not
> folded into the expand, because it writes to every existing row. It invents
> nothing: a historical run keeps a NULL source event id, and a historical
> RUNNING run is left RUNNING with an expired lease for the reconciler rather
> than being assigned an outcome nobody observed.
>
> `20271131000000` is CONTRACT and is in Release D only, behind six readiness
> counts that RAISE in the same file.

Prerequisites: a restorable backup/checkpoint; `CREATE EXTENSION IF NOT EXISTS
vector`; PostgreSQL ≥ 13 for `gen_random_uuid()` — the uuid repair RAISEs rather
than skipping if it is unavailable.

**PHASE 12 POINT 8 — pgvector is now a hard Release-A prerequisite, not a
"before the embedding chain is exercised" one.**
`20271119000000_search_document_embedding_after_extension` RAISEs if the
extension is absent. That is deliberate. The migration it repairs,
`20260620100000_phase24_31_consolidated_drift_patches`, creates
`evidence_search_documents.embedding` and its IVFFLAT index inside
`IF has_pgvector … ELSE RAISE NOTICE 'skipped'`, and `CREATE EXTENSION vector`
is not issued until `20270701000000_phase15_semantic_search` — a year later in
lexical order. On every database built from this chain the guard is false when
evaluated, both objects are silently skipped, and the datamodel goes on
declaring a column that does not exist. It was found by applying the release
artifact to an empty PostgreSQL 16 + pgvector and running
`db:raw-schema-verify`, and it survived a year of CI because the
reproducibility job ran on `postgres:16-alpine`, where the extension install
fails silently and every extension-conditional check is vacuous. Silence is
what hid it, so the repair fails loudly instead.

Stop conditions: any `FAILED` row in `_prisma_migrations`; the uuid repair
raising `incompatible id default`; `20271005000000`'s consistency probe raising
on conflicting duplicate policies (that one is Release B).

### Why `20271112000000_point4_write_unblock_repair` is in Release A

Three `create()` paths fail outright on any database carrying the full
migration history — `crossOrgReviewGrant`, `delegatedAdminGrant` and
`redactionPolicyAssignment` — because a catch-up migration added a second
physical column beside each `@map`-ed original, three of them `NOT NULL` with
no default, and Prisma never sends them. The original fix was a column DROP,
which cannot ship in the first wave. Point 6 split it: Release A relaxes the
`NOT NULL` (non-destructive, unblocks the writes immediately), Release D drops
the columns.

---

## 3. Release B — Backfill and readiness · `WAIT_FOR_BACKFILL_READINESS`

12 migrations. Each mutates rows; none drops anything.

| migration | readiness command | blocking categories |
|---|---|---|
| `20270920000000_workspace_kind_discriminator` | `db:check-org-consistency` | `workspace_kind`/`org_kind` NULL |
| `20270920250000_membership_grant_legacy_backfill` | `check-org-consistency.mjs --membership-grants` | membership with no grant row |
| `20270920300000_enterprise_contract_state` | `db:check-org-consistency` | `contract_state` NULL |
| `20270923000000_notification_schedule_timezone_inherit` | `not-null-readiness.mjs` | unresolved schedule timezone |
| `20271003000000_managed_identity_ownership_backfill` | `check-org-consistency.mjs --managed-identity` | zero-owner, multi-owner |
| `20271005000000_org_security_policy_org_scoped` | `db:check-org-consistency` | conflicting duplicate policies |
| `20271103000000_case_evidence_link_canonical` | `backfill-case-evidence-links.mjs --check` | see Case–Evidence set below |
| `20271104000000_case_evidence_link_integrity` | `backfill-case-evidence-links.mjs --check` | orphan link → Case / → Evidence |
| `20271107000000_legal_hold_backfill` | `legal-hold-convergence-report.mjs` | see Legal-Hold set below |
| `20271109000000_workspace_governance_policy_version` | `not-null-readiness.mjs` | `version IS NULL` |
| `20271110000000_exchange_download_authorization_semantics` | `not-null-readiness.mjs` | rows asserting a confirmed download from an authorisation timestamp |
| `20271115000000_point5_atomic_sweep_claims` | `point5-vector-readiness.mjs --sweep-claims` | duplicate RUNNING run / non-terminal execution / active review / in-flight transition |

**Case–Evidence blocking set** (all must be 0 before Release D):
`missingLinks`, `conflictingLinks` (advisory), `orphanCasePointers`,
`crossWorkspaceLinks`, `duplicateLinks`, `orphanLinks`, plus "legacy pointer not
represented canonically" and "unexpected source residue" — the check reports
`dropReady: true` only when every blocking count is zero.

**Legal-Hold blocking set** (all must be 0 before Release D):
`crossWorkspace`, `orgBindingMismatch`, `unconvertedSourceRows`,
`duplicateSourceMapping`, `unresolvedActiveHolds`, `releaseStateMismatch`,
`invalidTarget`. `EVIDENCE_WITH_CASE_TAG` additionally gates
`20271118000000` only.

**`20271110000000` is the one migration that is NOT safe before code
deployment.** The previous build still writes `downloaded_at_utc` at
authorisation time, so between Release B and the Release-C cutover it can
re-conflate the two columns. The migration is idempotent — re-run it after
cutover to re-separate them.

**Release B must not contain a CONTRACT/DROP migration.** Enforced by the
inventory gate.

---

## 4. Release C — Runtime cutover · `WAIT_FOR_RUNTIME_CUTOVER`

**One migration: `20271201000000_new058_verified_contact_factors`.**

PHASE 13 (NEW-058), account-bound step-up. This wave was defined from the start
and carried nothing until now, so Release C used to be a code-only cutover.
Shape: `EXPAND` — it adds `SMS`/`WHATSAPP` to `MfaFactorKind`, six sealed
destination columns plus `verified_at_utc` and `generation` to `mfa_factors`,
and `factor_id`/`factor_generation` to `step_up_challenges`. Every `ADD` is
`IF NOT EXISTS`; **nothing is dropped or renamed** and the inventory records
zero destructive statements. It widens the four TOTP secret columns to nullable
and restores the invariant in the same file with
`mfa_factors_kind_payload_chk`.

The single `UPDATE` is bounded and records rather than invents: it copies
`COALESCE(enrolled_at, created_at)` into `verified_at_utc` for rows that are
**already** `ACTIVE`, and a TOTP factor only reaches `ACTIVE` by completing its
enrolment round-trip. `created_at` is `NOT NULL`, so every such row is stamped
and `mfa_factors_active_is_verified_chk` cannot fail on pre-existing data.
**No destination is backfilled** — a number once typed into a step-up request
body was never proven to belong to the account — so every existing user is left
unenrolled and every step-up-gated mutation fails closed with
`STEP_UP_ENROLLMENT_REQUIRED` until they enrol.

**Why it belongs in C and not in Release A.** It is the one wave whose meaning
is "not safe ahead of its image". `mfa_factors_active_is_verified_chk` requires
`verified_at_utc` on any `ACTIVE` row, and the currently deployed build never
writes that column (`services/api/src/services/security/mfa.service.ts` at HEAD
contains no reference to it; the new build stamps it at activation under
NEW-072). Applying this before the API deploy would make the next TOTP
activation on the old code violate the constraint. The new build also *requires*
the migration, so it cannot be deferred past the cutover either: it lands with
the deploy, migration → API → worker.

**Rollback boundary.** Application images only. The schema is forward-only:
redeploying the previous build restores service except for TOTP activation,
which stays blocked while the constraint exists. Do **not** drop the constraint
or the columns to unblock an old build — roll forward instead.

Operator steps and the post-deploy verification queries are in
`docs/operations/point6-migration-runbook.md` §C.0 and §C.2.

Then deploy the API, worker and web build that reads and writes the canonical
schema:

* every case↔evidence association resolves through `CaseEvidenceLink`
  (`Evidence.caseId` has **zero** runtime readers and writers — the scalar is
  gone from `schema.prisma` and the resurrection guard in
  `services/api/test/phase-12b-case-evidence-authority.test.ts` keeps it gone);
* every legal-hold read and write goes through `evidence_legal_holds`
  (`prisma.evidenceLegalHold`); the legacy stores have zero Prisma delegates
  and zero raw-SQL readers outside
  `scripts/legal-hold-convergence-report.mjs`, which is the readiness tool and
  must keep reading them until Release D;
* the canonical placement command writes `case_id = NULL` for `scope = EVIDENCE`.

Startup order: **API first, then worker.** Both tolerate the expanded
pre-contract schema (proven — see §6). Queues drain against the same schema in
both directions, so no queue pause is required.

Health checks: the API's own startup validator must log
`runtime.schema_validation.healthy`.

Rollback: redeploy the previous build. Every Release-A/B migration is additive,
defaulted or idempotent, so the previous build keeps working; nothing needs to
be un-migrated. **One exception, stated rather than glossed:** once
`20271201000000_new058_verified_contact_factors` has been applied, a rolled-back
build can still read and serve everything, but a TOTP *activation* on that build
is refused by `mfa_factors_active_is_verified_chk` because the old code does not
stamp `verified_at_utc`. That is a degraded enrolment path, not data loss, and
the fix is to roll forward.

---

## 5. Observation window · `WAIT_FOR_OBSERVATION_WINDOW`

Minimum evidence before Release D:

1. `backfill-case-evidence-links.mjs --check` → `dropReady: true`, every
   blocking count 0, on two runs at least 24h apart.
2. `legal-hold-convergence-report.mjs` → `BLOCKING total: 0`, and
   `protectedEvidenceCount` **not lower** than the pre-backfill run.
3. Zero application errors referencing `case_id` on `evidence`, or either
   legacy hold store.
4. `pnpm --filter proovra-api db:raw-schema-verify` → OK, 0 unregistered
   divergences.
5. `runtime.schema_validation.healthy` sustained across the window.

---

## 6. Release D — Contract/Drop · `CONTRACT_DROP_LATER`

10 migrations. **These files must not be present in the deployment artifact for
Release A, B or C** — every one of them RAISEs when its readiness is not zero,
and a raise inside `prisma migrate deploy` leaves a FAILED row that blocks all
subsequent migrations. Stage them into the artifact only for Release D.

| migration | removes | removal condition |
|---|---|---|
| `20270923500000_persona_profiles_removal_precondition` | nothing (guard only) | always runs; RAISEs if any FK or view still depends on `workspace_persona_profiles` |
| `20270924000000_drop_workspace_persona_profiles` | `workspace_persona_profiles` | zero runtime readers (feature deleted 2026-07-20) + the preceding guard passing |
| `20271105000000_evidence_case_id_removal` | `evidence.case_id` | 5 in-database counts at zero + both `case_evidence_links` FKs VALIDATED |
| `20271108000000_legal_hold_legacy_removal` | `case_legal_holds`, `legal_holds`, `CaseLegalHoldStatus` | 6 in-database counts at zero + canonical columns + idempotency index present |
| `20271117000000_point4_schema_authority_contract` | 5 duplicate columns, 3 superseded singular audit tables | zero divergent non-null duplicates, zero rows in the singular tables |
| `20271118000000_legal_hold_strict_scope_target` | nothing (tightens a CHECK) | `EVIDENCE_WITH_CASE_TAG = 0` |
| `20271122000000_external_review_invitation_authority_contract` | 5 duplicate lifecycle columns on `external_reviewer_role_assignments` (`grant_state`, `raw_token`, `token_hash`, `expires_at_utc`, `revoked_at_utc`) | every one still holding its creation value + zero orphan role assignments/deliveries + zero missing intent keys + zero conflicting logical intents. All checks are IN THE MIGRATION and RAISE; two of them observed refusing in `migration-rehearsal.mjs B-REFUSE`. |
| `20271125000000_workspace_kind_authority_contract` | nothing (adds NOT NULL, a CHECK and a partial unique index; drops the expand's helper index) | zero NULL `workspace_kind` + zero PERSONAL under a CUSTOMER Organization + zero ORGANIZATION without one + zero OWNED under one + zero duplicate Personal Spaces. All checks are IN THE MIGRATION and RAISE; two observed refusing in `migration-rehearsal.mjs B-REFUSE`. |
| `20271128000000_org_membership_lifecycle_contract` | nothing (adds NOT NULL status, the status/timestamp CHECK and the generation check) | zero memberships without a status + zero status/timestamp contradictions + zero rows both suspended and revoked + zero duplicate ACTIVE memberships. All checks are IN THE MIGRATION and RAISE. |
| `20271131000000_automation_runtime_durability_contract` | the expand migration's own readiness helper index (nothing holding data) | six counts, all IN THE MIGRATION and all RAISE: zero runs without an action idempotency key + zero null/negative fences + zero duplicate (team, rule, source_event_id) groups + zero terminal runs holding a live lease + zero rows both dead-lettered and SUCCEEDED + zero null/negative delivery fences. Then NOT NULLs, the non-negative fence CHECK, the dead-lettered/SUCCEEDED contradiction CHECK, and the partial unique index that collapses a replayed source event onto one run. |

Adapter removal condition: `docs/architecture/compatibility-adapter-registry.json`
entries bound to `20271105000000_evidence_case_id_removal` and
`20271117000000_point4_schema_authority_contract` become inert once those
migrations are applied and may then be deleted.

Failure stop conditions: any RAISE aborts the release. The correct response is
to resolve the named rows and re-run — **never** `prisma migrate resolve` to
skip a contract migration, and never weaken a guard to make it pass.

---

## 7. Production state — the one open blocker

```text
AWAITING_OWNER_PRODUCTION_MIGRATION_SNAPSHOT
```

No production database was read. To close it:

```bash
P6_PRODUCTION_READONLY_DATABASE_URL="postgresql://<readonly-user>:<pw>@<host>/<db>?sslmode=require" node services/api/scripts/p6-production-migration-snapshot.mjs --out p6-production-snapshot.json
```

then

```bash
node services/api/scripts/migration-production-reconcile.mjs p6-production-snapshot.json --write
```

The reconciler dispositions all twelve required divergence classes and exits
non-zero unless `AppliedMigrationChecksumConflicts`,
`RenamedAppliedMigrationConflicts`, `ProductionOnlyMigrationUnknowns`,
`FailedOrIncompleteProductionMigrations` and `MigrationInventoryDuplicates` are
all zero. The whole collector → snapshot → reconcile path was executed against a
live PostgreSQL 16 in the rehearsal and returned all-zero with conservation
holding.

**Line-ending hazard, recorded because it is a real P3006 source:** Prisma
stores `sha256` over the *raw* `migration.sql` bytes (proven — 221/221 rows
matched the raw digest, 0 matched the LF-normalised one). This repository has no
`.gitattributes` and `core.autocrlf=true` locally, so a Windows checkout and a
Linux checkout produce different digests for identical SQL. Deploy from a
consistent (Linux/LF) checkout. The reconciler accepts either basis so it never
reports a phantom conflict.

---

## 8. Rehearsal evidence

**Empty PostgreSQL 16.14 + pgvector 0.8.6** — full chain from an empty
database: **221 applied / 0 failed / 0 rolled back**. Final schema is the
post-contract shape (`evidence.case_id`, `case_legal_holds`, `legal_holds`,
`workspace_persona_profiles`, the 5 duplicate columns and the 3 singular audit
tables all absent; 276 tables). `prisma validate` + `generate` clean;
`db:raw-schema-verify` → **864 registered objects verified, 0 unregistered
divergences, 0 objects proposed for removal**; second `migrate deploy` →
"No pending migrations" with a byte-identical `_prisma_migrations` fingerprint.

**pgvector** — with the extension: all 7 readiness checks pass. On a plain
`postgres:16` server without it: exit **20**, `vector_extension_missing`. Fails
closed.

**Production-like history rehearsal** — second disposable PostgreSQL 16:
185-migration historical baseline, then synthetic production-like fixtures
(canonical-only, legacy-only, agreeing, conflicting, orphan, cross-workspace,
duplicate, personal-workspace, active/released/historical holds, audit
V1/V2/V3, explicit UUIDs, step-up rows, exchange download history, Point-5
duplicate authority rows), then the exact release sequence:

* **Release A** — 18 applied, **zero row-count change** on every authority;
  relaxed scope/target CHECK installed; `gen_random_uuid()` defaults added with
  every pre-existing id byte-identical; audit tenant columns nullable with **5
  unresolved scopes preserved and 0 scopes guessed**.
* **Release B** — links 6 → 9 (only resolvable pointers converted, **0 orphan
  links created**), conflicting association preserved as *two* links (nothing
  discarded), personal-workspace link written with `team_id NULL`, canonical
  holds 2 → 12, cross-workspace holds **refused** and left in place, unknown
  legacy state mapped to ACTIVE (never RELEASED), orphan preserved as
  `historical=true` and failing closed, exchange authorisation timestamps moved
  with **0 confirmed downloads fabricated**, all 4 Point-5 duplicate classes
  resolved forward with **nothing deleted** and 4 partial unique indexes built.
* **Resumability** — 2 converted hold rows deleted, backfill re-run: exactly
  those 2 restored plus 3 newly-resolvable ones, **0 duplicate mappings**.
* **Negative scenarios** — contract before backfill: refused (both);
  contract with unresolved conflicts: refused with the exact counts;
  strict-CHECK tightening with a tag still present: refused, tag preserved;
  after each refusal the before/after count fingerprint was **identical**
  (`ContractFailureDataLoss = 0`).
* **Release C** — the API's own startup validator on the pre-contract expanded
  schema: `runtime.schema_validation.healthy`, 111 targets checked, canonical
  reads working.
* **Release D** — all 6 applied after legitimate operator resolution; final
  shape post-contract; **audit hash chain byte-identical before and after**;
  every canonical row preserved (12 holds, 7 links, 9 evidence, 5 audit rows,
  2 device rows with unchanged ids).
* **Post-contract** — API validator `healthy` with identical canonical reads;
  worker boots and reads every canonical authority; second `migrate deploy` →
  no pending migrations, no state mutation.

### Defects the rehearsal found and fixed

1. **`20271106000000_legal_hold_canonical` would have broken legal-hold
   placement in production.** It measured the table and installed the STRICT
   `EVIDENCE ⇒ case_id IS NULL` CHECK whenever it happened to find zero tagged
   rows — but it runs *before* the cutover, and the deployed build passes
   `caseId` straight into an EVIDENCE-scoped create. Proven by counterfactual on
   a clean Release-A database: the shipped relaxed CHECK accepts that write; the
   strict form rejects it. The tightening moved to `20271118000000` (Release D).
2. **`20271103000000_case_evidence_link_canonical` manufactured orphan links.**
   Its backfill had no `JOIN cases`, so a legacy pointer at a deleted Case became
   a canonical link row pointing at nothing — and the very next migration, which
   adds the real foreign key, then refused *forever*. One dangling pointer
   blocked Release B outright in the rehearsal. Fixed with the join; the
   dangling pointer now surfaces as `orphan_case_pointer` in the Release-D guard.
3. **`20271117000000`'s divergence guard was permanently self-blocking.** It
   tested `duplicate IS DISTINCT FROM canonical`, which counts every healthy row
   (duplicate NULL, canonical populated) as divergence — including every row
   written after the Release-A repair. Now NULL-tolerant.
4. **`20271108000000` produced an unbounded error on a partially-removed
   database.** Each per-store probe is now conditional on that store existing.
5. **`20270924000000_drop_workspace_persona_profiles` had an unguarded
   `DROP ... CASCADE`.** Its bytes are frozen (tracked in git), so the guard was
   added as the preceding migration `20270923500000`, which refuses when any FK
   or view still depends on the table.
6. **`20271104000000_evidence_case_id_removal` mixed a BACKFILL, an FK
   expansion and a CONTRACT drop in one file**, forcing either late foreign keys
   or an early column drop. Split into `20271104000000_case_evidence_link_integrity`
   (Release B) and `20271105000000_evidence_case_id_removal` (Release D).

### Observations recorded, not "fixed"

* `case_legal_holds.case_id` carries `ON DELETE CASCADE`, so deleting a Case
  silently destroys its preservation controls, and an orphaned case-scoped hold
  is structurally impossible. The canonical model corrects this with
  `ON DELETE RESTRICT`.
* `case_legal_holds` has no FK on `placed_by_user_id`, so a hold whose placing
  user is gone IS representable; the backfill leaves it in place rather than
  attributing it to someone else, and it shows up as unconverted source rows.

---

## 9. Workspace-scope / Operations release — the ordered deploy, and the rollback

Added 2026-08-25, when the two migrations above shipped alongside the code that
reads them.

### The order, and what enforces it

1. apply `20271222000000_workspace_operations_reconciliation_kind`;
2. **let that migration's transaction commit** — PostgreSQL refuses to let a
   value added by `ALTER TYPE … ADD VALUE` be USED in the transaction that adds
   it, which is the whole reason it is a migration of its own;
3. apply `20271223000000_operational_incident_scope`;
4. apply `20271224000000_operational_incident_naming_convergence` — not
   optional and not deferrable: until it runs, `recordIncident` fails
   P2011/23502 on every category, so the workspace records no operational
   conditions at all while every read surface looks healthy. It removes
   nothing, so it is safe to apply to the CURRENTLY deployed image;
5. **only then** deploy API and Worker;
6. deploy Web afterward.

The legacy columns are deliberately NOT dropped in this release, and no
migration in this tree drops them. The drop is held back on
`chore/operations-contract-drop-later` until the above is live and healthy.
That is not a documented preference an operator could forget: `prisma migrate
deploy` applies every pending migration in one pass, so the only way to make
the ordinary command safe is for the removal not to be in the tree. Nothing
needs it to have happened for Operations to work — once their NOT NULLs are
relaxed the legacy columns are inert, read by no image and written by no
writer.

Steps 4 and 5 used to be enforced by nothing. `db:preflight` checked the
DATABASE_URL's shape, the migration files' contents and whether those files
matched the schema — all properties of the REPOSITORY. A deploy that shipped
the code first passed every one of them and then answered its first Operations
request with `column "scope" does not exist`.

`Check 4 — runtime schema requirements` now asks the connected database. The
requirements are declared in
`services/api/scripts/runtime-schema-requirements.mjs`: the
`WORKSPACE_OPERATIONS` enum value, the `IncidentScope` type, the
`operational_incidents.scope` column and the
`operational_incidents_scope_team_status_idx` index, each carrying the
migration that supplies it. A missing object is a FAIL naming the object, why
the runtime needs it and which migration provides it; a catalog that cannot be
read is also a FAIL, because "the check errored" is not "the object is there".
A skip — non-local host, no override — is a WARN and never a PASS.

The probes are read-only `pg_catalog` / `information_schema` reads and no
driver message is ever forwarded into the operator-facing reason.

### Rollback is CODE-FIRST and leaves the schema expanded

Both migrations are expand-only: an added enum value, an added type, an added
column with a default, an added index. Nothing is dropped, no type narrowed, no
row deleted, and the `ON DELETE SET NULL` foreign key on
`operational_incidents.team_id` is untouched.

That is what makes the rollback simple: **revert API, Worker and Web to the
previous build and leave the database as it is.** An older process runs
unharmed against the expanded schema — it never selects `WORKSPACE_OPERATIONS`
and never reads `scope`.

Specifically, do **NOT**, as part of a normal rollback:

* drop `operational_incidents.scope`. It is the only record of which incidents
  were classified deliberately, and the classification is not recoverable from
  `team_id` once a human has re-scoped a `LEGACY_UNSCOPED` row.
* remove a PostgreSQL enum value. `ALTER TYPE … DROP VALUE` does not exist, and
  the workarounds rewrite the type in place across every column that uses it.
* drop `operational_incidents_scope_team_status_idx` on its own. It costs one
  index and removing it only makes the older readers slower.

The backward steps are recorded in `20271223000000`'s own header for a genuine
emergency — a schema-level recovery decision, taken deliberately, not a rollback
step anyone runs on the way past.
