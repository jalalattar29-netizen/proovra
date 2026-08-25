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
