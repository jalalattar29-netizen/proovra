/**
 * PHASE 12 — POINT 8 PART A, STEP A4: materialize a release artifact.
 *
 * WHY MATERIALIZE AT ALL
 * ---------------------------------------------------------------------------
 * Every migration check in this repository has run against the WORKING TREE,
 * where all 221 migration directories exist. What actually ships is a clean
 * checkout — `actions/checkout` then `COPY services/api/prisma` — which has
 * 204. That gap is how a tracked `DROP TABLE … CASCADE` came to ship without
 * the untracked guard whose RAISE is its only safety, and no amount of checking
 * the working tree could have found it.
 *
 * So this builds the artifact the way the pipeline does — `git archive` from a
 * commit, not a copy of the directory you happen to be sitting in — and lets
 * every downstream rehearsal run against THAT.
 *
 *   --view head       exactly what HEAD ships today
 *   --view proposed   HEAD plus the explicitly justified additions
 *   --view worktree   the dirty tree, provided only so the difference can be
 *                     measured; never a release candidate
 *
 * Usage:
 *   node scripts/release-materialize.mjs --view proposed --out <dir> [--json]
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const PRISMA_REL = "services/api/prisma";

/**
 * The additions this pass justifies. Every one is an untracked migration that
 * Point 6 classified and that A1 dispositioned; the reason is carried here so
 * the artifact is self-describing and a future reader does not have to guess
 * why a directory is in it.
 *
 * NOTE ON THE CONTRACT/DROP ENTRIES: they are in the ARTIFACT because a
 * destructive migration must never be separated from its guard. They are kept
 * out of a release by the WAVE selector at deploy time, not by being absent
 * from the image — absence is what caused the defect.
 */
export const PROPOSED_ADDITIONS = {
  // SECURITY CONTAINMENT (2026-09-04) — the persistent signer lifecycle.
  //
  // Retire and revoke previously wrote nothing: the read model recomputes the
  // active set from environment variables on every request, so a revoked signer
  // came back ACTIVE on the next page load and kept signing. This table is the
  // overlay that makes the two operations real, and the API and worker signing
  // boundaries read it before producing any signature.
  "20280110000000_signer_control_state":
    "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW. One new table plus a status CHECK and one index. No existing column altered, no row read or written, no other table touched. Empty means ACTIVE, so applying it ahead of the code is inert; deploying the code first would write to a table that does not exist.",
  // PHASE 2 (2026-09-04) — worker liveness lease + bounded heartbeat history.
  //
  // The heartbeat table is append-only with no retention: 1,440 rows per
  // worker per day, for ever. Liveness read the newest 200 of them and
  // deduplicated in memory, which drops instances out of a large fleet and
  // cannot express a clean shutdown at all — so a drained worker read exactly
  // like a crashed one.
  "20280115000000_worker_lease_and_heartbeat_retention":
    "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW. One new table and enum for current worker state, its index, and one GUARDED index on the existing heartbeat history for the retention sweep predicate. No existing column altered, no existing row read or written. An empty lease table reads as NOT_MEASURED, so applying it ahead of the code is inert; deploying the code first would leave the worker upserting into a table that does not exist.",
  "20270923500000_persona_profiles_removal_precondition":
    "REQUIRED_LATER_CONTRACT_MIGRATION — the guard for the tracked, unguarded 20270924000000 drop. Shipping the drop without it is the release-blocking defect.",
  "20271102000000_uuid_id_default_repair": "REQUIRED_RELEASE_MIGRATION — REPAIR, SAFE_TO_APPLY_NOW.",
  "20271103000000_case_evidence_link_canonical": "REQUIRED_RELEASE_MIGRATION — BACKFILL, self-gating on readiness.",
  "20271104000000_case_evidence_link_integrity": "REQUIRED_RELEASE_MIGRATION — BACKFILL, self-gating on readiness.",
  "20271105000000_evidence_case_id_removal": "REQUIRED_LATER_CONTRACT_MIGRATION — self-guarded CONTRACT_DROP.",
  "20271106000000_legal_hold_canonical": "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW.",
  "20271107000000_legal_hold_backfill": "REQUIRED_RELEASE_MIGRATION — BACKFILL, self-gating on readiness.",
  "20271108000000_legal_hold_legacy_removal": "REQUIRED_LATER_CONTRACT_MIGRATION — self-guarded CONTRACT_DROP.",
  "20271109000000_workspace_governance_policy_version": "REQUIRED_RELEASE_MIGRATION — BACKFILL, self-gating on readiness.",
  "20271110000000_exchange_download_authorization_semantics": "REQUIRED_RELEASE_MIGRATION — BACKFILL, self-gating on readiness.",
  "20271111000000_step_up_session_organization_binding": "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW.",
  "20271112000000_point4_write_unblock_repair":
    "REQUIRED_RELEASE_MIGRATION — REPAIR that unblocks live writes; prerequisite of 20271117000000.",
  "20271113000000_point5_report_generation_authority": "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW.",
  "20271114000000_point5_media_intelligence_kind_catalog": "REQUIRED_RELEASE_MIGRATION — REPAIR, SAFE_TO_APPLY_NOW.",
  "20271115000000_point5_atomic_sweep_claims": "REQUIRED_RELEASE_MIGRATION — BACKFILL, self-gating on readiness.",
  "20271117000000_point4_schema_authority_contract":
    "REQUIRED_LATER_CONTRACT_MIGRATION — CONTRACT_DROP; destroys through dynamic identifiers, each self-guarded by a RAISE.",
  "20271118000000_legal_hold_strict_scope_target": "REQUIRED_LATER_CONTRACT_MIGRATION — CONTRACT_DROP, self-guarded.",
  "20271119000000_search_document_embedding_after_extension":
    "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW. Creates the column and ANN index that 20260620100000 could never create, because its pgvector guard is evaluated a year before CREATE EXTENSION vector.",
  // PHASE 12 CORRECTIVE PASS §2/§3 (2026-08-06) — INV-001 + NEW-004.
  //
  // These three REPLACE `20271120000000_external_review_delivery_intent_
  // idempotency`, whose ledger entry claimed "EXPAND, SAFE_TO_APPLY_NOW" while
  // its first statement re-numbered every historical `attempt` value. That is a
  // rewrite of a business-visible counter, so both the classification and the
  // description were wrong. It was never committed and never applied outside a
  // disposable database, so replacing it rewrites no deployed history.
  "20271120000000_external_review_invitation_authority_expand":
    "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW. Adds external_review_grants.token_version and the delivery intent columns (content_version, resend_seq, intent_key). Nullable/defaulted columns only: no constraint, no index, no data change, no history rewrite. Fully information_schema-guarded.",
  "20271121000000_external_review_invitation_authority_backfill":
    "REQUIRED_RELEASE_MIGRATION — BACKFILL, deterministic and re-runnable. Assigns content_version=1 and a dense resend_seq rank per (team, grant) ordered by queued_at, then derives intent_key from the durable triple. `attempt` is NOT touched, no row is deleted, and no delivery outcome is invented.",
  "20271122000000_external_review_invitation_authority_contract":
    "REQUIRED_LATER_CONTRACT_MIGRATION — CONTRACT_DROP, self-guarded. Every destructive statement is preceded IN THIS SAME FILE by the readiness check that authorises it: orphan sidecars/deliveries, non-default values in the five duplicate lifecycle columns, missing intent keys, and conflicting logical intents each RAISE and abort. Then it enforces the intent uniqueness, binds the role assignment to its grant by FK, and drops the duplicate authority (grant_state, raw_token, token_hash, expires_at_utc, revoked_at_utc).",
  // PHASE 12 CORRECTIVE PASS §5.2 (2026-08-06) — ARCH-002.
  "20271123000000_workspace_kind_authority_expand":
    "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW. A partial index over rows with a NULL workspace_kind (so the contract migration's readiness query does not scan the table) and a COLUMN COMMENT recording the classification authority. No constraint, no data change.",
  "20271124000000_workspace_kind_authority_backfill":
    "REQUIRED_RELEASE_MIGRATION — BACKFILL, deterministic and re-runnable. Classifies every NULL workspace_kind from STRUCTURAL authority only: the personal-space ownership invariant, the CUSTOMER-organization provisioning relation, and account ownership inside a SYSTEM container. It never reads a plan, a subscription, a role name or a display name — inferring tenancy from a commercial fact is the defect ARCH-002 removes.",
  // PHASE 12 CORRECTIVE PASS §2 (2026-08-07) — ARCH-004.
  "20271126000000_org_membership_lifecycle_expand":
    "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW. Adds the OrganizationMembershipStatus enum and eleven nullable/defaulted lifecycle columns, the attribution FKs (SET NULL, so removing an administrator never erases what they did) and two status read indexes. Ordinary revocation was a physical DELETE, so the system could not say who removed a member or why, and there was no reversible pause at all.",
  "20271127000000_org_membership_lifecycle_backfill":
    "REQUIRED_RELEASE_MIGRATION — BACKFILL, deterministic and re-runnable. States ACTIVE explicitly and stamps the timeline from created_at. It invents NO suspension, NO revocation and NO actor: historically deleted memberships cannot be reconstructed, and this migration does not pretend otherwise.",
  "20271128000000_org_membership_lifecycle_contract":
    "REQUIRED_LATER_CONTRACT_MIGRATION — CONTRACT, self-guarded. NOT NULL status plus the status/timestamp CHECK and the generation check, behind four readiness counts that RAISE in this same file before the constraints they authorise.",
  // PHASE 12 CORRECTIVE PASS §2 CONTINUATION (2026-08-07) — ARCH-005.
  "20271129000000_automation_runtime_durability_expand":
    "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW. Ten nullable/defaulted fence columns on automation_runs (source event id, action idempotency key, lease, monotonic claim generation, attempt counter, retry schedule, failure/dead-letter timestamps, bounded failure code), the same lease/generation pair on automation_webhook_deliveries, two partial read indexes, and a WIDENED status CHECK admitting RETRY_SCHEDULED and DEAD_LETTERED. Widening can never invalidate an existing row. Automation had no fence at all: two workers could claim one run, a stalled worker could overwrite a newer attempt's terminal state, and an interrupted run stayed RUNNING forever.",
  "20271130000000_automation_runtime_durability_backfill":
    "REQUIRED_RELEASE_MIGRATION — BACKFILL, deterministic and re-runnable. States the counters explicitly, moves the failure timestamp into the column that now owns it, and derives action_idempotency_key from the run's own id. It INVENTS NOTHING: a historical run keeps a NULL source event id because none was ever produced, and a historical RUNNING run is left RUNNING with an expired lease for the reconciler rather than being assigned an outcome nobody observed. No row is deleted and no attempt counter is renumbered.",
  "20271131000000_automation_runtime_durability_contract":
    "REQUIRED_LATER_CONTRACT_MIGRATION — CONTRACT, self-guarded. Six readiness counts RAISE in this same file before the constraints they authorise: missing action key, null/negative fence, duplicate (team, rule, source event), terminal run holding a live lease, dead-lettered-and-SUCCEEDED, and the delivery-side fence. Then NOT NULLs, the non-negative fence CHECK, the contradiction CHECK, and the partial unique index that makes a replayed source event collapse to one run. The only DROP is the expand migration's own readiness helper index.",
  "20271125000000_workspace_kind_authority_contract":
    "REQUIRED_LATER_CONTRACT_MIGRATION — CONTRACT, self-guarded. Makes teams.workspace_kind NOT NULL, adds the PERSONAL/is_personal equivalence CHECK and the one-Personal-Space-per-identity unique index. Five readiness conditions are checked in this same file, before the constraints they authorise, and each RAISEs; two were observed refusing (a Personal Space under a CUSTOMER Organization, a duplicate Personal Space) with the database left intact.",
  // PHASE 13 (NEW-058) — the FIRST migration in the `WAIT_FOR_RUNTIME_CUTOVER`
  // wave, which the runbook has always defined (Release C) and never had an
  // occupant for. It is NOT `SAFE_TO_APPLY_NOW`, and that is the whole point of
  // its wave: see the reason below.
  "20271201000000_new058_verified_contact_factors":
    "REQUIRED_RELEASE_MIGRATION — EXPAND, RUNTIME-CUTOVER-BOUND (release wave WAIT_FOR_RUNTIME_CUTOVER, Release C). Adds SMS/WHATSAPP to MfaFactorKind, six sealed destination columns plus verified_at_utc and generation to mfa_factors, and factor_id/factor_generation to step_up_challenges; every ADD is IF NOT EXISTS, nothing is dropped or renamed, and destructiveStatements is empty. It widens the four TOTP secret columns to nullable and restores the invariant AT THE CONTRACT in the same file via mfa_factors_kind_payload_chk, so a TOTP row still cannot exist without its sealed secret and a contact row cannot exist without its sealed destination, hash and mask. The one UPDATE is bounded and records rather than invents: it copies COALESCE(enrolled_at, created_at) into verified_at_utc for rows ALREADY ACTIVE, and a TOTP factor reaches ACTIVE only by completing its enrolment round-trip. NO destination is backfilled — a number once typed into a step-up request body was never proven to belong to the account — so every existing user is left UNENROLLED and every step-up-gated mutation fails closed with STEP_UP_ENROLLMENT_REQUIRED until they enrol. WHY IT MAY NOT SHIP IN WAVE A/B: mfa_factors_active_is_verified_chk requires verified_at_utc on any ACTIVE row, and the CURRENTLY DEPLOYED build does not stamp it (HEAD services/api/src/services/security/mfa.service.ts contains no reference to the column; the new build stamps it at activation under NEW-072). Applying this ahead of the API image would therefore make the next TOTP activation against the old code violate the constraint. It must land WITH the Release C cutover, and the new build depends on it, so it cannot be deferred past that deploy either.",
  // ATTENTION ARCHITECTURE PHASE 3 (2026-08-22) — per-Evidence integrity
  // conditions. The first migration this program authors.
  "20271216000000_evidence_integrity_incident_category":
    "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW. One `ALTER TYPE \"IncidentCategory\" ADD VALUE IF NOT EXISTS 'EVIDENCE_INTEGRITY'`. It creates no table, changes no column type, adds no constraint or index, and rewrites no row; destructiveStatements is empty. A build that never emits the new label behaves identically, so it is safe to apply BEFORE the code that uses it and needs no runtime cutover. It deliberately carries NO backfill: opening conditions for evidence that is already FAILED would stamp first_seen_at_utc with the migration's own clock, and that column feeds the age-based severity escalation, so a backfill would manufacture a wave of CRITICALs out of a schema change. It also performs NO grouping — historical correlation without positive correlation evidence is precisely the retracted TSA-grouping finding this phase undoes.",
  // ATTENTION ARCHITECTURE CLOSURE PASS (2026-08-22) — correlation producer.
  "20271217000000_evidence_integrity_correlation":
    "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW. Adds the nullable evidence.integrity_correlation_id column and a partial index over its non-null rows. It records the identity of a deliberate multi-record execution, which is the one positive TSA/OTS correlator the current pipelines can honestly produce — ordinary work is one BullMQ job per Evidence, so normal failures are independent and the column stays NULL. Purely additive: no table, no type change, no constraint, no row rewritten, destructiveStatements empty. NO BACKFILL, deliberately: historical failures have no recorded execution and deriving one from reason, provider, workspace or timestamp would manufacture the grouping the retracted TSA finding forbids. A build that never reads the column behaves identically, so it needs no runtime cutover.",
  // PHASE B §8 (2026-08-23) — bulk incident assignment.
  "20271218000000_bulk_assign_incidents":
    "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW. One `ALTER TYPE \"BulkOperationalActionType\" ADD VALUE IF NOT EXISTS 'BULK_ASSIGN_INCIDENTS'`. It creates no table, changes no column type, adds no constraint or index, and rewrites no row; destructiveStatements is empty. A build that never emits the new label behaves identically, so it is safe to apply BEFORE the code that uses it and needs no runtime cutover — while the reverse order would make the new route fail on an enum the database does not know. It carries NO backfill and reclassifies NO historical run: a past sweep that assigned workflows assigned workflows, and relabelling it would rewrite the record of what an operator actually did. A separate value rather than reusing BULK_ASSIGN_WORKFLOWS because the runner derives its TARGET TABLE from the action type, and reusing the workflow value would make every item in a condition sweep claim to have mutated an OperationalWorkflow row that was never touched. The value carries no new authority: it maps to `operations.assign`, the same permission a single row's assignment requires, and fans out to the same `assignIncident` service.",
  // WORKSPACE-SCOPE CONVERGENCE (2026-08-24) — scheduled Operations discovery.
  "20271222000000_workspace_operations_reconciliation_kind":
    "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW. One `ALTER TYPE \"GovernanceReconciliationKind\" ADD VALUE IF NOT EXISTS 'WORKSPACE_OPERATIONS'`. It creates no table, changes no column type, adds no constraint or index, and rewrites no row; destructiveStatements is empty. A build that never selects the new label behaves identically, so it is safe to apply BEFORE the code that uses it — while the REVERSE order is a measured outage, not a theoretical one: SEARCH_INDEX shipped code-before-migration once and every reconciler tick died on `invalid input value for enum` at its first workspace, silently, for as long as the incompatibility lasted, because the claim row could not be written and 'no run has ever been recorded' is indistinguishable from 'never visited'. It is deliberately its OWN migration: PostgreSQL will not let a value added by ADD VALUE be USED in the transaction that adds it, so the addition must commit before the migration that writes it. It carries NO backfill — there is no historical Operations run to record, and inventing one would give every workspace a fabricated freshness it never had.",
  // WORKSPACE-SCOPE CONVERGENCE (2026-08-24) — incident scope discriminator.
  "20271223000000_operational_incident_scope":
    "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW. Creates the IncidentScope enum, adds operational_incidents.scope NOT NULL DEFAULT 'WORKSPACE', reclassifies the NULL-team rows to LEGACY_UNSCOPED, and adds one guarded index. Nothing is dropped, no type narrowed, no row deleted, and the ON DELETE SET NULL foreign key is left exactly as it is — proving the retention and deletion requirements that would justify changing it is separate work, and a destructive FK change made on the way past is how incident history disappears. Every statement is guarded so a partial apply can be re-run. It is safe to apply BEFORE the code: an older build ignores the column and keeps its previous behaviour, and the new predicate is additive. THE BACKFILL DELIBERATELY CLAIMS NOTHING AS PLATFORM: no writer in this codebase records a deliberate platform-wide incident — the only producer of a NULL team id is security-event.service.ts, whose `input.teamId ?? null` is an account-tier event — so deriving PLATFORM from a NULL would invent the exact intent the column exists to record. Every existing NULL row becomes LEGACY_UNSCOPED: retained in full, invisible to tenant AND platform surfaces, and available for deliberate reclassification by id. The UPDATE is bounded by `team_id IS NULL AND scope <> 'LEGACY_UNSCOPED'` and is a pure function of data still present, so re-applying reproduces the identical classification. The index guard names EVERY column it touches, because an index over three columns fails if any one is absent and the safety gate treats a partial guard as no guard.",
  // PHASE B CLOSURE (2026-08-24) — historical incident SLA.
  "20271219000000_incident_sla_history":
    "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW. Creates workspace_sla_policy_versions and operational_incident_sla_cycles with their indexes and foreign keys. Nothing existing is altered, dropped or rewritten and destructiveStatements is empty, so it is safe to apply BEFORE the code that reads it — while the reverse order would make the new SLA projection query relations the database does not have. NO BACKFILL, deliberately: incidents that exist at apply time have no cycle and report UNTRACKED_LEGACY, because stamping them with a policy that was not in force would invent a deadline and then invent whether it was missed. It replaces a derivation that was MEASURED to flip an open condition from ON_TRACK to BREACHED when a workspace tightened its policy, and to erase a real breach when it loosened one.",
  // OPERATIONS SOURCE TOTALITY (2026-08-26) — declared source identity.
  "20271226000000_operational_incident_source_identity":
    "REQUIRED_RELEASE_MIGRATION — BACKFILL, SAFE_TO_APPLY_NOW, deterministic and re-runnable. One nullable VARCHAR(120) `operational_incidents.source_id` plus one UPDATE per unambiguous legacy fingerprint prefix, each guarded by `source_id IS NULL`. Lifecycle authority was derived from category (fourteen values for thirty-five sources), then from fingerprint — which covered the eleven shapes the discovery sweep writes and left fifteen production emitters, in both hosts, resolving to an 'unregistered' contract that was OPERATOR_DECISION: a condition the system could not identify was the most closable kind there is. No index, no constraint, and deliberately NO NOT NULL in this deployment — that is a later one, after the backfill has been observed in production, and new writes are already enforced by the typed writer signature. NO HISTORY IS REWRITTEN: events and SLA cycles are neither read nor written, and no status, resolution, note, actor or occurrence count changes. Rows matching no prefix stay NULL and fail closed at runtime. Readiness: `node services/api/scripts/operations-source-identity-readiness.mjs`, which asks the SAME registry the runtime resolver asks rather than restating the prefix table.",
  // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the evidence-credit wallet,
  // the cancellation lifecycle, and contract-managed allowances.
  "20271227000000_billing_commercial_correctness":
    "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW, no backfill. Three additions. (1) `evidence_credit_ledger_entries`, the auditable evidence-credit wallet: `entitlements.credits` was a bare integer with no history, and the consume path read it, compared it in application memory, then decremented in a separate statement against the GLOBAL prisma client from INSIDE the evidence-completion transaction — so a completion that rolled back still burned the customer's credit, and neither a double-spend nor a lost credit was detectable afterwards. The new table's UNIQUE `evidence_id` makes consumption idempotent per Evidence record and is the serialization point for two concurrent completions; a PARTIAL unique index on `(provider, provider_ref) WHERE entry_type='PURCHASE'` is the database-level backstop against double-crediting one payment. Existing `entitlements.credits` balances are UNTOUCHED and are read by the application as an opening balance, so no customer loses a purchased credit. (2) `subscriptions.cancel_at_period_end BOOLEAN NOT NULL DEFAULT false` and `canceled_at_utc`: the provider-confirmed cancellation lifecycle. The DEFAULT means every existing row keeps its exact current meaning — nothing becomes 'cancelling' as a side effect of applying this. (3) `enterprise_contracts.evidence_records_per_month` and `ai_operations_per_month`, both nullable: contract-managed operational allowances, where NULL means the contract is silent and the canonical ENTERPRISE catalog default applies. Safe to apply BEFORE the code — an older build never selects any of it — and safe after a rollback, because a build without the readers leaves the ledger unwritten and the two flags unread. The CREATE TABLE is wrapped in a Phase O-Final `information_schema.tables` guard rather than `CREATE TABLE IF NOT EXISTS`, so a later column addition to the same table can never be silently skipped. NOTHING is dropped, renamed, retyped or narrowed; no historical payment, entitlement or subscription row is rewritten; and no Stripe or PayPal identifier and no evidence, custody, signature, TSA or OTS data is touched.",
  // BILLING DEPENDENT-CANCELLATION CONVERGENCE (2026-08-27) — the durable
  // obligation to stop a recurring Storage add-on.
  "20271229000000_billing_dependent_cancellation_obligation":
    "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW, no backfill. BILLING DEPENDENT-CANCELLATION CONVERGENCE — expand-only, no backfill, no row rewritten: one new enum (DependentCancellationState) and nine columns on workspace_storage_addons, plus one PARTIAL index over the unresolved states. A recurring Storage add-on is its OWN provider subscription, so when a customer cancels PRO or TEAM the add-on must be stopped by a SEPARATE remote call that cannot be atomic with the first. Until now a failed dependent call left NOTHING behind — the failure lived in an in-memory counter that died with the HTTP response — so the add-on kept renewing, no retry existed, no alert existed, and no query could find it: a single provider blip charged a customer indefinitely for storage they had cancelled. These columns make the OBLIGATION durable, and they extend the existing add-on authority rather than opening a parallel ledger because the obligation is a property of the add-on itself. NO BACKFILL, deliberately: every existing row defaults to NONE with attempt count 0, which is exactly true — nobody has asked for it to be cancelled — and synthesising an obligation for a historical row would invent a customer intention that was never expressed. A legacy ONE_TIME add-on is not a provider subscription and never leaves NONE. The partial index is scoped to the four unresolved states so it stays proportional to outstanding work rather than to every add-on ever sold, and it is registered in docs/architecture/raw-schema-ownership.json because Prisma cannot declare an index predicate. Nothing is dropped, renamed, retyped or narrowed; no Stripe or PayPal identifier is stored; no evidence, custody, signature, TSA or OTS data is touched.",
  // ADM-004 (2026-08-27) — THE WORKSPACE LIFECYCLE AUTHORITY.
  "20271230000000_workspace_lifecycle_authority":
    "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW, with an idempotent evidence-based backfill in the same file. ONE nullable TIMESTAMPTZ column and its plain index: `teams.closed_at_utc`. WHY: `executeWorkspaceClosure` revoked every membership, revoked API credentials, disabled webhooks and cleared switcher pointers, and left the `teams` row byte-for-byte indistinguishable from a live workspace — so every Platform Admin population query counted closed workspaces as live. Closure touches neither `billing_plan` nor `billing_status` either, so a closed workspace on a paid plan kept reporting as an active paying customer, and billing state could never have served as a liveness proxy. WHY A COLUMN AND NOT A DERIVED PREDICATE: deriving liveness from 'has no COMPLETED workspace_closure_requests row' is provably wrong against this codebase — `reopenClosedWorkspace` deliberately leaves that row in place as history, so a derived predicate would mark every reopened workspace closed forever. Closure sets the column, reopen clears it, and both writes are inside the transaction that changes access, so a workspace can never be dark to its members while still counting as live. THE BACKFILL reads the system's own recorded history and nothing else: a workspace is claimed closed only when its newest COMPLETED closure request is newer than its newest `workspace_reopened` `team_activities` row (or no such row exists), and it writes only where `closed_at_utc IS NULL`, so re-running it changes nothing. Ambiguous history stays LIVE — the direction that over-reports rather than hiding a real tenant from its operator. NOTHING is dropped, renamed, retyped or narrowed; no NOT NULL is added; no evidence, custody, signature, TSA or OTS data is touched. Safe to apply BEFORE the code — an older image never reads or writes the column — and safe after a rollback for the same reason.",
  // BILLING RECONCILIATION (2026-08-27) — the provider-state ordering field.
  "20271228000000_billing_provider_state_ordering":
    "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW, no backfill. Two nullable TIMESTAMPTZ columns with no default: `subscriptions.provider_state_at_utc` and `workspace_storage_addons.provider_state_at_utc`. Provider reconciliation learns state by POLLING, and a poll that starts before a webhook lands can finish after it — so with no ordering signal a stale 'still active' reply could resurrect a subscription the provider had already cancelled, and a stale 'cancelled' could tear down one the customer had just renewed. `updated_at` cannot decide it: that records when WE last wrote the row, not when the PROVIDER's state was true. These columns hold the provider's own authoritative timestamp for the state that produced the last write, and an observation older than it is discarded rather than applied. It creates NO second ledger and NO second state machine — payment idempotency still comes from the existing `payments (provider, provider_payment_id)` unique constraint, and credit idempotency from the existing partial unique index on PURCHASE ledger rows. NULL is meaningful ('no provider time recorded yet') and the guard reads it as accept-and-record, so every existing row reconciles normally on its first pass rather than being frozen out. NOTHING is dropped, renamed, retyped or narrowed; no historical payment, subscription or add-on row is rewritten; no index and no constraint is added; and no Stripe or PayPal identifier and no evidence, custody, signature, TSA or OTS data is touched. Safe to apply BEFORE the code — an older image never reads or writes the columns — and safe after a rollback for the same reason, so a rolling deployment in either order holds.",
  // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the scheduled plan
  // change, for the period-end downgrade.
  "20271231000000_billing_scheduled_plan_change":
    "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW, no backfill. Two nullable columns on `subscriptions` with no default, no index and no constraint: `pending_plan` (PlanType) and `pending_plan_effective_at_utc` (TIMESTAMPTZ); destructiveStatements is empty and no row is rewritten. FREE, PRO and TEAM are now three tiers of the SAME Personal Workspace rather than plans belonging to different subjects, so a customer can move in both directions — and moving DOWN must take effect at PERIOD END, because they have already paid for the period they are in and a downgrade that removed capacity on request would take back something already bought. That creates a state the row could not express: the subscription is still TEAM, and it is going to be PRO on a known date. The existing `plan` column is the plan IN FORCE, and writing the future one into it would make enforcement, the usage meters and the plan card all apply the downgrade immediately — the exact outcome period-end scheduling exists to prevent. Both columns are written ONLY after the provider ACCEPTS the schedule, never as a local intention, and both are cleared by `upsertSubscription` when the provider reports the scheduled plan is in force or the subscription has ended. It opens NO second ledger and NO second state machine: the plan in force is still written by `syncPlanForSubscription`, the one handler the webhook and reconciliation both call. NO BACKFILL, deliberately: NULL means 'no change scheduled', which is what every existing row means today, and synthesising a pending plan for a historical row would invent a customer decision nobody made. Safe to apply BEFORE the code — an older image never selects either column — and safe after a rollback, where the loss is the LOCAL record of a schedule the provider still holds: the downgrade still lands and the webhook still applies it, so what is lost is the customer-facing promise, not a plan anyone is on. NOTHING is dropped, renamed, retyped or narrowed; no enum value is added; no historical payment, subscription or entitlement row is rewritten; no Stripe or PayPal identifier is stored; and no evidence, custody, signature, TSA or OTS data is touched.",
  // BILLING SURFACE CORRECTION (2026-08-29) — somewhere for an unsettled
  // payment to end, and an ordering guard so a settled one cannot be undone.
  "20280101000000_billing_payment_terminal_states":
    "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW, no backfill. Two new values on the `PaymentStatus` enum (`CANCELED`, `EXPIRED`) and one nullable TIMESTAMPTZ column with no default, no index and no constraint: `payments.provider_state_at_utc`; destructiveStatements is empty and no row is rewritten. WHY THE ENUM VALUES: a payment could only be PENDING, SUCCEEDED, FAILED or REFUNDED, and a checkout the customer abandoned is none of those — no money was ever attempted, so FAILED says a charge was declined that never happened, and it is never coming, so PENDING is a lie that lasts for ever. The Billing page listed months-old rows reading 'Pending' with no way for a customer to tell whether a charge was still on its way, no way to ask the provider, and no state such a row could reach. Both new values have REAL writers and both come only from a provider answer: EXPIRED when Stripe reports a Checkout Session expired — including one this product asked Stripe to expire through `POST /checkout/sessions/:id/expire` — and CANCELED when a provider reports the transaction cancelled. Neither is ever written from a local intention: PayPal exposes no operation that cancels an unapproved order, so a PayPal row is refused rather than marked locally. WHY THE COLUMN: `provider_state_at_utc` is the ordering guard, named and shaped exactly like `subscriptions.provider_state_at_utc`, and read by the one shared transition (`decidePaymentTransition`) that the webhook, the reconciliation sweep and the per-row re-check all go through — so an observation older than the state already recorded is discarded rather than applied, a slow poll cannot overwrite a newer webhook, and a redelivered PENDING cannot move a settled payment backwards. NO BACKFILL, deliberately: NULL means 'no provider time recorded yet', which is what every existing row means today and which the guard reads as accept-and-record, so every historical payment reconciles normally on its first pass; synthesising a timestamp would invent a provider fact. Adding an enum value is permitted inside a transaction on PostgreSQL 12+ provided the new value is not USED in the same transaction, and this migration uses neither. Safe to apply BEFORE the code — an older image never writes either value and never selects the column — and safe after a rollback for the same reason. NOTHING is dropped, renamed, retyped or narrowed; no payment row's status is changed; no Stripe or PayPal identifier is stored; and no evidence, custody, signature, TSA or OTS data is touched.",
  // BILLING SURFACE CORRECTION (2026-08-29) — somewhere honest for a checkout
  // the customer walked away from, on a provider that cannot be asked to stop.
  "20280102000000_billing_payment_abandoned":
    "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW, no backfill. ONE new value on the `PaymentStatus` enum, `ABANDONED`; destructiveStatements is empty and no row is rewritten. PayPal exposes no operation that cancels an unapproved order — such an order lapses at PayPal's own pace, and the v2 Orders API has no cancel for it (its `void` applies to an AUTHORIZED payment, which this product never creates: it captures directly). So a customer looking at a PayPal approval attempt from March had exactly one honest action, `Re-check`, which kept returning the same answer, and the row stayed PENDING indefinitely. The dishonest alternative was a `Cancel payment` button claiming PayPal had stopped something it had not. ABANDONED is the CUSTOMER's own act, recorded as theirs: they are telling us they are not going to finish this checkout. It has a real writer — `abandonPendingPayment` — which RECONCILES FIRST and writes it only when the provider confirms the transaction is still open with nothing captured and nothing authorized; where the provider knows better, the provider's answer is what gets written, and where the provider cannot be reached NOTHING is written, because \"we could not check\" is not \"you have abandoned it\". It asserts nothing about the provider: no completed charge is reversed, because none was ever made. The shared transition treats it as terminal for the customer's purposes — no later PENDING, FAILED, CANCELED or EXPIRED reopens it — while still letting a proven SUCCEEDED through, because money that actually moved is a fact and this is a statement of intent. NO BACKFILL, deliberately: an existing PENDING row stays PENDING until a customer decides or a provider answers. Safe to apply BEFORE the code — an older image never writes the value — and safe after a rollback, where the value is simply never produced again. NOTHING is dropped, renamed, retyped or narrowed; no payment row's status is changed; no Stripe or PayPal identifier is stored; and no evidence, custody, signature, TSA or OTS data is touched.",
  // ADM-013 PHASE 4 (2026-09-01) — the platform half of incident identity.
  "20280104000000_operational_incident_platform_uniqueness":
    "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW, no backfill. ONE partial unique index and nothing else: `operational_incidents_platform_fingerprint_uk ON operational_incidents (fingerprint) WHERE team_id IS NULL`; destructiveStatements is empty, no column is added, altered or dropped, and no row is read, written or deleted. WHY: `@@unique([teamId, fingerprint])` reads as 'one row per condition per workspace, and one row per platform condition' and delivers only the first. A standard PostgreSQL unique index treats NULL as distinct from NULL, so (NULL,'x') and (NULL,'x') are two different keys — measured against a fully-migrated PostgreSQL 16 before this was written, and both rows insert with no error. Every PLATFORM-scope and LEGACY_UNSCOPED incident has been un-deduplicated since the column became nullable, and recordIncident's read-then-create had nothing underneath it: two evaluators observing one global condition in the same moment wrote two rows and nothing ever merged them. Those siblings are what a reader counts as separate faults. WHY IT CARRIES NO DELETE: a unique index cannot be created over existing duplicates, so a database holding them must CONVERGE first, and convergence merges and then deletes rows. That is irreversible, and full-migration-audit.mjs classifies DELETE_FROM in a post-baseline migration as CRITICAL with no guarded form — correctly, because a release should not quietly merge production records while nobody is watching. The two halves are split by AUDIENCE: this migration is safe unattended, and services/api/scripts/incident-convergence.mjs merges duplicates after a reviewed dry-run and an explicit operator decision. That script DISCOVERS every referencing column from the catalog and REFUSES to run on one it has no reviewed disposition for — its first draft knew about three relations and the catalog returned twelve, so causality links, causality chains, correlations, operational workflows, governance notifications, governance export snapshots and immutable storage checks would have been silently orphaned. BEHAVIOUR ON A DIRTY DATABASE: it RAISES, naming the duplicate group count, the excess row count and the exact commands, with the remediation in DETAIL and HINT. It does NOT skip — a silent skip leaves the invariant unenforced on precisely the database that needed it while the deploy goes green, and nobody finds out until two rows appear again. REHEARSED against live PostgreSQL 16: applies on a clean database; refuses on one seeded with 2 duplicate groups / 3 excess rows; and after --apply plus `prisma migrate resolve --rolled-back`, re-deploys cleanly with the index present. Convergence preserved earliest first-seen, latest last-seen, the summed occurrence count, the worst severity by RANK (CRITICAL — the lexical MAX returns HIGH, which the rehearsal caught), OPEN status from a sibling, every timeline event plus one merged event naming the folded ids, and three SLA cycles renumbered rather than dropped to fit UNIQUE(incident_id, cycle_number). Eight live-PostgreSQL concurrency cases prove two simultaneous platform evaluations produce exactly one row with both observations counted, ten produce one row counting all ten, workspace fingerprints stay isolated, and a resolved condition reopens rather than duplicating. Safe to apply BEFORE the code: the index enforces an invariant the writer already assumes, and the writer's P2002 recovery is already live and is a no-op until the index exists. Safe after a rollback: dropping the index returns the table to the un-deduplicated state it has been in all along. Idempotent — CREATE UNIQUE INDEX IF NOT EXISTS, and a no-op when the operator script created the index first. NOTHING is dropped, renamed, retyped or narrowed, and no evidence, custody, signature, TSA or OTS data is touched.",
  // OPERATIONS LIFECYCLE CLOSURE (2026-08-26) — the current aggregate value.
  "20271225000000_operational_incident_metric_snapshot":
    "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW. One `ADD COLUMN IF NOT EXISTS operational_incidents.metric_snapshot JSONB`, nullable, with no default, no index and no constraint; destructiveStatements is empty and no row is rewritten. It exists because the number an aggregate condition is ABOUT lived in `title` — 'Report backlog above threshold (26)' — and recordIncident never rewrote the title on re-observation, so 26 was written once and then frozen: a workspace that worked its backlog down to 22 kept reading 26 for as long as the condition existed, and a severity computed from that number could not be recalculated either. Safe to apply BEFORE the code, because an older build never selects the column, and safe AFTER a rollback, because a build without the reader simply leaves it unread. NO BACKFILL, deliberately: a metric is an OBSERVATION, and stamping historical rows with a count nobody measured would be the same fiction the title carried, moved into a new column. Existing rows keep NULL, which the strict decoder reads as 'no metric' and which renders exactly as those rows render today. Json rather than eight columns because it is written and read as ONE snapshot, always together, and never filtered or sorted on in SQL — the type safety lives in `decodeConditionMetric`, which is the single place that can be wrong.",
};

/**
 * REBASELINED (2026-08-06, corrective pass 3 §1.1).
 *
 * This map is a LEDGER, not a snapshot. It records every addition this
 * programme has justified, and entries are NEVER removed when they land: the
 * justification is still the reason the migration belongs in the artifact.
 *
 * The landed/proposed split is DERIVED at evaluation time by
 * `buildViews`/`partitionAdditions` from HEAD and the worktree:
 *
 *     LANDED    = ledger ∩ HEAD          (baseline; the eighteen Point-8 entries)
 *     PROPOSED  = ledger ∩ (disk \ HEAD) (what a release would still add)
 *
 * so committing a migration moves it between the two with no edit here, and the
 * "release landed partially" failure the previous pass reported as unfixable
 * without a commit cannot recur — that check was measuring the staleness of a
 * hand-maintained snapshot, not a property of the migrations.
 */

/** Nothing is excluded. Recorded explicitly so conservation is provable. */
export const PROPOSED_EXCLUSIONS = {};

function git(...args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
}

/** Extract `services/api/prisma` from a commit exactly as the pipeline would. */
function materializeHead(out) {
  mkdirSync(out, { recursive: true });
  const tar = join(out, "_head.tar");
  // `-c core.autocrlf=false` — NOT cosmetic.
  //
  // This machine has `core.autocrlf=true` and the repository had no
  // `.gitattributes`, so `git archive` rewrote every migration's LF to CRLF:
  // 21 CR bytes injected into a file whose canonical blob has none. Prisma
  // records `_prisma_migrations.checksum` over the RAW BYTES of the file it
  // applied, so a CRLF artifact and the LF artifact CI produces on Linux carry
  // different checksums for the same commit — and deploying one against a
  // database migrated from the other fails with "migration was modified after
  // it was applied".
  //
  // Pinning it here makes the materialization reproduce the canonical blob
  // byte-for-byte on any machine. `.gitattributes` fixes the same class for
  // ordinary checkouts.
  execFileSync("git", ["-c", "core.autocrlf=false", "archive", "--format=tar", "-o", tar, "HEAD", PRISMA_REL], {
    cwd: REPO,
    maxBuffer: 512 * 1024 * 1024,
  });
  // GNU tar reads a leading `C:` as a remote host spec ("Cannot connect to C"),
  // so the archive is named relatively from inside the output directory rather
  // than passed as an absolute Windows path.
  execFileSync("tar", ["-xf", "_head.tar"], { cwd: out });
  rmSync(tar, { force: true });
}

export function materialize({ view, out }) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  if (view === "worktree") {
    cpSync(resolve(REPO, PRISMA_REL), join(out, PRISMA_REL), { recursive: true });
  } else {
    materializeHead(out);
    if (view === "proposed") {
      for (const name of Object.keys(PROPOSED_ADDITIONS)) {
        const src = resolve(REPO, PRISMA_REL, "migrations", name);
        if (!existsSync(src)) throw new Error(`proposed addition missing from worktree: ${name}`);
        cpSync(src, join(out, PRISMA_REL, "migrations", name), { recursive: true });
      }
      for (const name of Object.keys(PROPOSED_EXCLUSIONS)) {
        rmSync(join(out, PRISMA_REL, "migrations", name), { recursive: true, force: true });
      }
    }
  }

  const migRoot = join(out, PRISMA_REL, "migrations");
  const migrations = existsSync(migRoot)
    ? readdirSync(migRoot)
        .filter((d) => statSync(join(migRoot, d)).isDirectory() && existsSync(join(migRoot, d, "migration.sql")))
        .sort()
    : [];

  // Raw-byte checksums — the basis `_prisma_migrations.checksum` uses, so the
  // artifact's identity is comparable with what a database records.
  const checksums = Object.fromEntries(
    migrations.map((n) => [n, createHash("sha256").update(readFileSync(join(migRoot, n, "migration.sql"))).digest("hex")]),
  );

  const manifest = {
    view,
    gitCommit: git("rev-parse", "HEAD").trim(),
    migrationCount: migrations.length,
    migrations,
    checksums,
    artifactDigest: createHash("sha256")
      .update(migrations.map((n) => `${n}:${checksums[n]}`).join("\n"))
      .digest("hex"),
  };
  writeFileSync(join(out, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const arg = (n, d) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : d;
  };
  const m = materialize({ view: arg("--view", "proposed"), out: resolve(arg("--out", "")) });
  if (argv.includes("--json")) console.log(JSON.stringify(m, null, 2));
  else console.log(`${m.view}: ${m.migrationCount} migrations, artifactDigest ${m.artifactDigest.slice(0, 16)}…`);
}
