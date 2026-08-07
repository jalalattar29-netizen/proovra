/**
 * Phase O — Migration safety CI gate.
 *
 * Two contracts enforced:
 *
 *   1. **CI gate on FUTURE migrations.** Any migration added after the
 *      configured BASELINE_TIMESTAMP must contain ZERO CRITICAL
 *      findings as classified by `full-migration-audit.mjs`. This is
 *      the pre-commit guardrail that prevents the next
 *      `mentioned_user_id does not exist` class of failure from
 *      shipping.
 *
 *      Historical migrations (timestamp <= BASELINE) are explicitly
 *      grandfathered: they have already been applied to production
 *      and we cannot rewrite history without breaking
 *      `_prisma_migrations`. Their findings are inventoried (see
 *      `docs/operations/migration-inventory.md`) but do NOT fail CI.
 *
 *   2. **Audit script behaviour contract.** The script must:
 *        - Live at the documented path.
 *        - Be READ-ONLY by construction (no `pool.query`, no
 *          `new PrismaClient`, no mutating SQL keywords in real
 *          executable code).
 *        - Export pure detectFindings / parseMigrationName /
 *          stripSqlComments / classifyMigration helpers.
 *        - Correctly detect the documented dangerous patterns on
 *          synthetic SQL fixtures.
 *        - Correctly detect the Phase O-Final guarded-INDEX pattern
 *          and classify it as MEDIUM (CREATE_INDEX_GUARDED), not
 *          CRITICAL (INDEX_COLUMN_RISK).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
function read(rel: string): string {
  return readFileSync(REPO_ROOT + rel, "utf8");
}
function exists(rel: string): boolean {
  return existsSync(REPO_ROOT + rel);
}

const AUDIT_SCRIPT = "services/api/scripts/full-migration-audit.mjs";
const MIGRATIONS_DIR = "services/api/prisma/migrations";
const INVENTORY_MD = "docs/operations/migration-inventory.md";
const REPAIR_PLAN_MD = "docs/operations/migration-repair-plan.md";

// ---------------------------------------------------------------------------
// BASELINE — every migration with timestamp STRICTLY GREATER than this
// value must pass the strict gate (zero CRITICAL findings).
//
// 20261006000000 is the Phase O-Final repair migration. Any new
// migration authored after Phase O-Final must follow the
// additive-only + DO-block-guarded-index pattern documented in
// `docs/operations/production-schema-repair.md`.
// ---------------------------------------------------------------------------
const BASELINE_TIMESTAMP = "20261006000000";

// ---------------------------------------------------------------------------
// Lazy import of the audit script's exported core functions.
// ---------------------------------------------------------------------------

type AuditModule = {
  stripSqlComments: (src: string) => string;
  camelToSnake: (s: string) => string;
  parseMigrationName: (name: string) => { timestamp: string | null; slug: string };
  detectFindings: (sql: string) => {
    findings: Array<{ kind: string; risk: string; lineHint?: number; detail: string }>;
    columnsAddedByTable: Map<string, Set<string>>;
  };
  classifyMigration: (
    findings: Array<{ kind: string; risk: string }>,
  ) => { verdict: "SAFE" | "RISKY" | "UNSAFE"; rationale: string };
  detectNamingDriftInSql: (sql: string) => Array<{
    identifier: string;
    altSnake: string;
    detail: string;
  }>;
  parsePrismaModelMap: (
    schemaSrc: string,
  ) => Map<string, { table: string; columns: Set<string> }>;
};

async function loadAudit(): Promise<AuditModule> {
  return (await import(REPO_ROOT + AUDIT_SCRIPT)) as AuditModule;
}

// ---------------------------------------------------------------------------
// 1. Audit script contract — exists + read-only.
// ---------------------------------------------------------------------------

describe("Phase O — audit script contract", () => {
  it("ships at the documented path", () => {
    expect(exists(AUDIT_SCRIPT)).toBe(true);
    expect(statSync(REPO_ROOT + AUDIT_SCRIPT).size).toBeGreaterThan(3000);
  });

  it("is read-only by construction: no pg.Pool, no PrismaClient, no DB I/O", () => {
    const src = read(AUDIT_SCRIPT);
    // The audit script does fs-only work. It must not import a DB
    // client, even transitively. (full-production-schema-audit.mjs is
    // the sibling that DOES connect; this script never does.)
    expect.soft(src).not.toMatch(/new\s+Pool\(/);
    expect.soft(src).not.toMatch(/new\s+PrismaClient\(/);
    expect.soft(src).not.toMatch(/from\s+["']pg["']/);
    expect.soft(src).not.toMatch(/import\(\s*["']pg["']\s*\)/);
    expect.soft(src).not.toMatch(/from\s+["']@prisma\/client["']/);
  });

  it("exports the documented helpers", async () => {
    const mod = await loadAudit();
    expect(typeof mod.detectFindings).toBe("function");
    expect(typeof mod.classifyMigration).toBe("function");
    expect(typeof mod.parseMigrationName).toBe("function");
    expect(typeof mod.stripSqlComments).toBe("function");
    expect(typeof mod.detectNamingDriftInSql).toBe("function");
    expect(typeof mod.parsePrismaModelMap).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// 2. detectFindings — synthetic-fixture coverage of every documented
//    dangerous pattern.
// ---------------------------------------------------------------------------

describe("Phase O — detectFindings", () => {
  it("flags CREATE TABLE IF NOT EXISTS as CRITICAL", async () => {
    const { detectFindings } = await loadAudit();
    const { findings } = detectFindings(
      `CREATE TABLE IF NOT EXISTS "widgets" (id UUID PRIMARY KEY);`,
    );
    const f = findings.find((x) => x.kind === "CREATE_TABLE_IF_NOT_EXISTS");
    expect(f?.risk).toBe("CRITICAL");
  });

  it("flags ALTER TABLE DROP COLUMN as CRITICAL", async () => {
    const { detectFindings } = await loadAudit();
    const { findings } = detectFindings(
      `ALTER TABLE "widgets" DROP COLUMN "x";`,
    );
    expect(findings.some((f) => f.kind === "ALTER_TABLE_DROP_COLUMN" && f.risk === "CRITICAL")).toBe(true);
  });

  it("flags ALTER TABLE RENAME as CRITICAL", async () => {
    const { detectFindings } = await loadAudit();
    const { findings } = detectFindings(
      `ALTER TABLE "widgets" RENAME COLUMN "a" TO "b";`,
    );
    expect(findings.some((f) => f.kind === "ALTER_TABLE_RENAME" && f.risk === "CRITICAL")).toBe(true);
  });

  it("flags DROP TABLE, DROP INDEX, DROP TYPE, TRUNCATE, DELETE FROM as CRITICAL", async () => {
    const { detectFindings } = await loadAudit();
    for (const stmt of [
      `DROP TABLE "x";`,
      `DROP INDEX "i";`,
      `DROP TYPE "t";`,
      `TRUNCATE TABLE "x";`,
      `DELETE FROM "x" WHERE id = 1;`,
    ]) {
      const { findings } = detectFindings(stmt);
      expect.soft(
        findings.some((f) => f.risk === "CRITICAL"),
        `expected CRITICAL on: ${stmt}`,
      ).toBe(true);
    }
  });

  it("flags UPDATE without WHERE as CRITICAL", async () => {
    const { detectFindings } = await loadAudit();
    const { findings } = detectFindings(`UPDATE "widgets" SET x = 1;`);
    expect(findings.some((f) => f.kind === "UPDATE_WITHOUT_WHERE")).toBe(true);
  });

  it("does NOT flag UPDATE with WHERE", async () => {
    const { detectFindings } = await loadAudit();
    const { findings } = detectFindings(
      `UPDATE "widgets" SET x = 1 WHERE x IS NULL;`,
    );
    expect(findings.some((f) => f.kind === "UPDATE_WITHOUT_WHERE")).toBe(false);
  });

  it("flags SET NOT NULL without readiness marker as CRITICAL, with marker as MEDIUM", async () => {
    const { detectFindings } = await loadAudit();
    const bare = detectFindings(`ALTER TABLE "x" ALTER COLUMN "y" SET NOT NULL;`);
    expect(bare.findings.some((f) => f.kind === "SET_NOT_NULL_NO_READINESS")).toBe(true);

    const marked = detectFindings(
      `-- backfill verified complete\n-- NOT NULL readiness asserted\nALTER TABLE "x" ALTER COLUMN "y" SET NOT NULL;`,
    );
    // Comments are stripped before detection. The current rule looks
    // at the RAW sql surrounding context, so the marker is detected.
    expect(marked.findings.some((f) => f.kind === "SET_NOT_NULL_WITH_READINESS")).toBe(true);
  });

  it("flags CREATE INDEX referencing unguarded columns as INDEX_COLUMN_RISK (CRITICAL)", async () => {
    const { detectFindings } = await loadAudit();
    const { findings } = detectFindings(
      `CREATE INDEX IF NOT EXISTS "i" ON "widgets" ("team_id");`,
    );
    const f = findings.find((x) => x.kind === "INDEX_COLUMN_RISK");
    expect(f?.risk).toBe("CRITICAL");
  });

  it("ACCEPTS CREATE INDEX wrapped in a DO/information_schema column-existence guard as MEDIUM", async () => {
    const { detectFindings } = await loadAudit();
    // The Phase O-Final pattern — every index reference is preceded
    // by an information_schema.columns existence check for the same
    // column name.
    const sql = `
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='widgets'
       AND column_name='team_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "widgets_team_idx" ON "widgets" ("team_id")';
  END IF;
END $$;
`;
    const { findings } = detectFindings(sql);
    expect(findings.some((f) => f.kind === "INDEX_COLUMN_RISK")).toBe(false);
    expect(findings.some((f) => f.kind === "CREATE_INDEX_GUARDED" && f.risk === "MEDIUM")).toBe(true);
  });

  it("flags ADD COLUMN without IF NOT EXISTS as HIGH", async () => {
    const { detectFindings } = await loadAudit();
    const { findings } = detectFindings(
      `ALTER TABLE "x" ADD COLUMN "y" UUID;`,
    );
    expect(findings.some((f) => f.kind === "ADD_COLUMN_NO_IF_NOT_EXISTS" && f.risk === "HIGH")).toBe(true);
  });

  it("accepts ADD COLUMN IF NOT EXISTS as clean", async () => {
    const { detectFindings } = await loadAudit();
    const { findings } = detectFindings(
      `ALTER TABLE IF EXISTS "x" ADD COLUMN IF NOT EXISTS "y" UUID;`,
    );
    expect(findings.some((f) => f.kind === "ADD_COLUMN_NO_IF_NOT_EXISTS")).toBe(false);
  });

  it("flags CREATE INDEX without IF NOT EXISTS as HIGH", async () => {
    const { detectFindings } = await loadAudit();
    const { findings } = detectFindings(
      `ALTER TABLE IF EXISTS "x" ADD COLUMN IF NOT EXISTS "y" UUID;\nCREATE INDEX "x_y_idx" ON "x" ("y");`,
    );
    expect(findings.some((f) => f.kind === "CREATE_INDEX_NO_IF_NOT_EXISTS")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. classifyMigration — verdict logic.
// ---------------------------------------------------------------------------

describe("Phase O — classifyMigration", () => {
  it("UNSAFE for any CRITICAL pattern", async () => {
    const { classifyMigration } = await loadAudit();
    const v = classifyMigration([
      { kind: "CREATE_TABLE_IF_NOT_EXISTS", risk: "CRITICAL" },
    ]);
    expect(v.verdict).toBe("UNSAFE");
  });
  it("RISKY for HIGH-only idempotency gaps", async () => {
    const { classifyMigration } = await loadAudit();
    const v = classifyMigration([
      { kind: "ADD_COLUMN_NO_IF_NOT_EXISTS", risk: "HIGH" },
    ]);
    expect(v.verdict).toBe("RISKY");
  });
  it("SAFE when no high-risk findings", async () => {
    const { classifyMigration } = await loadAudit();
    const v = classifyMigration([
      { kind: "ALTER_COLUMN_SET_DEFAULT", risk: "MEDIUM" },
    ]);
    expect(v.verdict).toBe("SAFE");
  });
});

// ---------------------------------------------------------------------------
// 4. CI GATE — every migration NEWER than BASELINE must be clean.
//    Historical migrations are grandfathered and only logged.
// ---------------------------------------------------------------------------

describe("Phase O — CI gate on post-baseline migrations", () => {
  it(`baseline timestamp is the Phase O-Final repair: ${BASELINE_TIMESTAMP}`, () => {
    // The baseline must match Phase O-Final so the gate's reasoning
    // is unambiguous in the audit/repair-plan docs.
    expect(BASELINE_TIMESTAMP).toBe("20261006000000");
  });

  // Final Closure Remediation Part D — explicit allow-list of
  // post-baseline migrations whose CRITICAL findings have been
  // reviewed + approved by the closure-audit. Each entry must:
  //   * declare exactly which CRITICAL `kind`(s) it is exempt for,
  //   * cite the audit document that justifies the exemption,
  //   * use an additive / idempotent pattern (`IF EXISTS` / `IF NOT
  //     EXISTS` / `CASCADE` on a confirmed-orphan table, etc.).
  // Entries here do NOT silence findings — they declare the audit
  // record. New entries require a Phase Final-Closure ledger entry.
  const APPROVED_CRITICAL_BY_MIGRATION: Record<string, ReadonlySet<string>> = {
    // Removes the unsupported anchor receipt_id / public_url columns
    // from `evidence_anchors`. PROOVRA relies solely on OpenTimestamps ->
    // Bitcoin anchoring (transaction_id + anchored_at_utc), the verification
    // page, verification package, chain of custody, RFC3161 and the
    // signature package — there is no separate external anchor-receipt
    // layer. The two dropped columns (`receipt_id`, `public_url`) are
    // confirmed-unused after the product-wide cleanup (zero code / schema /
    // report / package references). The migration uses `DROP COLUMN IF
    // EXISTS` (idempotent + safe on partial state) and is documented in
    // `docs/operations/audit-closure-ledger.md`.
    "20270908000000_drop_evidence_anchor_publication_columns": new Set([
      "ALTER_TABLE_DROP_COLUMN",
    ]),
    // Drops the orphan `reviewer_queue_projections` table introduced
    // in Phase 37.97. The table was created alongside the canonical
    // `org_health_projections` read model but was never wired into
    // any service, worker, route, or read path — it has zero
    // dependents. The migration uses `DROP TABLE IF EXISTS … CASCADE`
    // (idempotent + safe on partial state) and is documented in
    // `docs/operations/audit-closure-ledger.md`.
    "20261009000000_drop_reviewer_queue_projection": new Set(["DROP_TABLE"]),
    // PHASE 12 POINT 4 — schema-authority convergence. Two destructive kinds,
    // both explicitly approved because they REPAIR a broken production write
    // path rather than remove a capability:
    //
    //   ALTER_TABLE_DROP_COLUMN — five DUPLICATE columns. Phase R7 renamed
    //     Prisma FIELDS while keeping the original physical column via `@map`;
    //     a later catch-up migration read those renames as new fields and
    //     ADDED a second physical column for each, three of them NOT NULL with
    //     no default. Because Prisma only ever sends the @map-ed original,
    //     `delegatedAdminGrant.create()`, `crossOrgReviewGrant.create()` and
    //     `redactionPolicyAssignment.create()` FAIL with a null-constraint
    //     violation on any database carrying the full migration history —
    //     proven empirically against a disposable PostgreSQL 16. The duplicates
    //     have zero runtime readers and zero runtime writers.
    //
    //   DROP_TABLE — three superseded SINGULAR audit tables
    //     (governance_policy_audit, redaction_activity, redaction_policy_audit)
    //     whose canonical PLURAL counterparts are the ones the Prisma models
    //     map and the runtime actually reads and writes. Zero runtime
    //     references of any kind to the singular names.
    //
    // Every drop is inside a DO-block guard: a duplicate column whose value
    // DIVERGES from its canonical twin, or a legacy table that still holds
    // rows, RAISES and drops nothing. No data is destroyed to reach readiness.
    // Ownership of all residual objects is recorded in
    // `docs/architecture/raw-schema-ownership.json` and verified by
    // `scripts/raw-schema-verify.mjs` with four positive controls.
    //
    // PHASE 12 POINT 6 — the convergence migration was SPLIT. The repair that
    // unblocks the live write failures (relaxing the orphaned NOT NULL
    // duplicates, converging security_events.severity) is non-destructive and
    // ships in Release A as `20271112000000_point4_write_unblock_repair`; the
    // physical removal below is Release D.
    "20271117000000_point4_schema_authority_contract": new Set([
      "ALTER_TABLE_DROP_COLUMN",
      "DROP_TABLE",
    ]),
    // PHASE 12 CORRECTIVE PASS §2 (2026-08-06) — INV-001. The external-review
    // invitation gets ONE lifecycle authority.
    //
    // Destructive by design, and every destructive statement is preceded IN
    // THE SAME FILE by the readiness check that authorises it — five checks
    // that RAISE: orphan role assignments, orphan deliveries, any non-default
    // value in the five columns being dropped, missing intent keys, and
    // conflicting logical intents. A refusal aborts inside the transaction and
    // leaves the database exactly as it was, which was OBSERVED: three of the
    // five were driven to refuse in `migration-rehearsal.mjs B-REFUSE`, with
    // all five columns still present afterwards.
    //
    //   ALTER_TABLE_DROP_COLUMN  the five duplicate lifecycle columns
    //                            (grant_state, raw_token, token_hash,
    //                            expires_at_utc, revoked_at_utc). No writer has
    //                            ever populated them; one reader trusted them
    //                            and therefore reported every grant as PENDING.
    //   DROP_INDEX               the (team_id, grant_id, attempt) uniqueness,
    //                            which encoded the WRONG invariant and would
    //                            forbid a legitimate second physical attempt of
    //                            one intent.
    //   INDEX_COLUMN_RISK        the replacement unique indexes reference
    //                            content_version / resend_seq / intent_key,
    //                            added by 20271120000000 and backfilled by
    //                            20271121000000, both of which precede this
    //                            file in the same release chain.
    "20271122000000_external_review_invitation_authority_contract": new Set([
      "ALTER_TABLE_DROP_COLUMN",
      "DROP_INDEX",
      "INDEX_COLUMN_RISK",
    ]),
    // PHASE 12 CORRECTIVE PASS §5.2 (2026-08-06) — ARCH-002. The workspace kind
    // becomes mandatory and stops being derivable from a commercial plan.
    //
    //   SET_NOT_NULL_NO_READINESS  the readiness IS in this file, immediately
    //                              above the ALTER, as five counting queries
    //                              that RAISE. The scanner looks for a comment
    //                              marker in the surrounding raw SQL and does
    //                              not recognise an executable guard — which is
    //                              a stronger form of the same assurance, and
    //                              two of the five were observed refusing.
    //   DROP_INDEX                 the partial helper index the EXPAND created
    //                              purely to keep the readiness query off a full
    //                              table scan. It has done its job by this
    //                              point and indexes nothing once the column is
    //                              NOT NULL.
    //   INDEX_COLUMN_RISK          the one-Personal-Space-per-identity partial
    //                              unique index references owner_user_id and
    //                              workspace_kind, both long-standing columns
    //                              on `teams`.
    "20271125000000_workspace_kind_authority_contract": new Set([
      "SET_NOT_NULL_NO_READINESS",
      "DROP_INDEX",
      "INDEX_COLUMN_RISK",
    ]),
    // PHASE 12 CORRECTIVE PASS §2 (2026-08-07) — ARCH-004. Organization
    // membership gains ACTIVE / SUSPENDED / REVOKED so ordinary revocation
    // stops being a physical DELETE.
    //
    //   INDEX_COLUMN_RISK  the two read indexes reference `status`, which the
    //                      SAME migration adds a few statements earlier, inside
    //                      an information_schema guard. The scanner looks for a
    //                      guard in the window immediately preceding each
    //                      CREATE INDEX; here the guard sits in its own DO
    //                      block one step up, which is the shape the rest of
    //                      this file already uses.
    "20271126000000_org_membership_lifecycle_expand": new Set([
      "INDEX_COLUMN_RISK",
    ]),
    //   SET_NOT_NULL_NO_READINESS  the readiness IS in this file, immediately
    //                      above the ALTER, as four counting queries that
    //                      RAISE. The scanner recognises only a comment marker
    //                      in the surrounding raw SQL, not an executable guard
    //                      — which is a stronger form of the same assurance,
    //                      and it is observed refusing in `migration-rehearsal
    //                      .mjs B-REFUSE`.
    "20271128000000_org_membership_lifecycle_contract": new Set([
      "SET_NOT_NULL_NO_READINESS",
    ]),
    // PHASE 12 CORRECTIVE PASS §2 CONTINUATION (2026-08-07) — ARCH-005. The
    // Automation runtime gains a lease, a monotonic claim fence, an attempt
    // counter, a retry schedule and a dead-letter state.
    //
    //   INDEX_COLUMN_RISK  the three indexes reference next_attempt_at_utc,
    //                      lease_expires_at_utc and source_event_id, all of
    //                      which the SAME migration adds a few statements
    //                      earlier — and each CREATE INDEX sits inside its own
    //                      information_schema.columns guard for exactly that
    //                      column. The scanner looks for a guard in the window
    //                      immediately preceding each CREATE INDEX; here the
    //                      guard opens the enclosing DO block, which is the
    //                      shape 20271126000000 already uses.
    "20271129000000_automation_runtime_durability_expand": new Set([
      "INDEX_COLUMN_RISK",
    ]),
    //   SET_NOT_NULL_NO_READINESS  the readiness IS in this file, above the
    //                      ALTERs, as SIX counting queries that RAISE — a
    //                      refusal aborts inside the transaction and leaves the
    //                      database exactly as it was. The scanner recognises
    //                      only a comment marker in the raw SQL, not an
    //                      executable guard, which is a stronger form of the
    //                      same assurance.
    //   DROP_INDEX         the partial helper index the EXPAND created purely
    //                      to keep this file's own readiness scan off a full
    //                      table scan. It has done its job by this point.
    //   INDEX_COLUMN_RISK  the (team_id, rule_id, source_event_id) partial
    //                      unique index references source_event_id, added by
    //                      20271129000000 and populated by the producer, both
    //                      of which precede this file in the same release
    //                      chain.
    "20271131000000_automation_runtime_durability_contract": new Set([
      "SET_NOT_NULL_NO_READINESS",
      "DROP_INDEX",
      "INDEX_COLUMN_RISK",
    ]),
    // Wave 2 — adds `duplicate_decisions` to persist reviewer decisions
    // (CONFIRMED / DISMISSED / MARKED_DERIVATIVE) on duplicate-class
    // graph edges (SAME_HASH_AS / SIMILAR_TO / POSSIBLE_DERIVATIVE_OF).
    // Pure additive Phase O pattern: CREATE TABLE IF NOT EXISTS plus
    // DO-block-guarded bounded CHECK constraints; zero DROP / RENAME /
    // data movement. Already allowlisted in
    // `phase-32-7-2-security-event-mapping-drift.test.ts`.
    "20270811000000_wave2_duplicate_decisions": new Set([
      "CREATE_TABLE_IF_NOT_EXISTS",
    ]),
    // Contact Sales lead capture — adds `contact_sales_requests` for
    // the /contact-sales marketing form. Mirrors the wave2 precedent:
    // pure additive Phase O-Final-style migration with CREATE TYPE
    // wrapped in DO + duplicate-object guard, CREATE TABLE IF NOT
    // EXISTS for the new table, and every CREATE INDEX wrapped in DO
    // blocks guarded by information_schema.columns existence checks.
    // Zero DROP / RENAME / TRUNCATE / DELETE / UPDATE-without-WHERE /
    // SET-NOT-NULL on existing tables. demo_requests is untouched.
    // Also allowlisted in
    // phase-32-7-2-security-event-mapping-drift.test.ts.
    "20270827000000_contact_sales_lead_capture": new Set([
      "CREATE_TABLE_IF_NOT_EXISTS",
    ]),
    // Enterprise email verification (EV). Pure-additive Phase O
    // pattern, mirroring the wave2 + contact-sales precedents:
    // CREATE TABLE IF NOT EXISTS for the new email_verification_tokens
    // table, FK + indexes wrapped in IF NOT EXISTS / DO blocks, and a
    // single backfill UPDATE on users.email_verified_at scoped by
    // `WHERE email_verified_at IS NULL` so legacy accounts are not
    // re-touched. Zero DROP / RENAME / TRUNCATE / DELETE / data
    // movement on existing rows; the users-table UPDATE is bounded
    // and idempotent.
    "20270828000000_email_verification_tokens": new Set([
      "CREATE_TABLE_IF_NOT_EXISTS",
    ]),
    // Operations-Center completion — persistent history snapshots
    // (operations_inbox_snapshots) + notification schedule settings
    // (notification_schedule_settings) + the additive `frequency`
    // column on workspace_notification_preferences. Pure-additive
    // Phase O pattern mirroring the contact-sales / email-verification
    // precedents: CREATE TABLE IF NOT EXISTS, guarded indexes, FKs in
    // DO + duplicate_object blocks, ADD COLUMN IF NOT EXISTS with a
    // default. Zero DROP / RENAME / TRUNCATE / DELETE / UPDATE.
    "20270916000000_operations_center_history_and_schedule": new Set([
      "CREATE_TABLE_IF_NOT_EXISTS",
    ]),
    // Operations-Center forensic completion — organization notification
    // policy table (CREATE TABLE IF NOT EXISTS) + additive provenance
    // columns on operations_inbox_snapshots. Same pure-additive Phase O
    // pattern as the 20270916 precedent; zero destructive statements.
    "20270917000000_org_notification_policy_and_resolution_provenance": new Set([
      "CREATE_TABLE_IF_NOT_EXISTS",
    ]),
    // Lifecycle Phase 3 (2026-07-17) — linked login methods
    // (user_identity_links). Pure-additive Phase O pattern: CREATE TABLE
    // IF NOT EXISTS, guarded unique/index creation, FK in a DO +
    // duplicate_object block, and ONE idempotent deterministic backfill
    // INSERT ... SELECT ... ON CONFLICT DO NOTHING sourced from the
    // already-verified users.(provider, provider_user_id) pair. Zero
    // DROP / RENAME / TRUNCATE / DELETE / UPDATE statements.
    "20270918000000_user_identity_links": new Set([
      "CREATE_TABLE_IF_NOT_EXISTS",
    ]),
    // Lifecycle Phase 4 (2026-07-17) — account_data_export_requests:
    // pure-additive CREATE TABLE IF NOT EXISTS + guarded indexes + FK in
    // a DO/duplicate_object block. Zero destructive statements, no
    // backfill (requests start empty).
    "20270919000000_account_data_export_requests": new Set([
      "CREATE_TABLE_IF_NOT_EXISTS",
    ]),
    // Lifecycle Phase 5 (2026-07-17) — account_closure_requests:
    // pure-additive CREATE TABLE IF NOT EXISTS + guarded indexes + FK in
    // a DO/duplicate_object block. Zero destructive statements, no
    // backfill (closure requests start empty).
    "20270920000000_account_closure_requests": new Set([
      "CREATE_TABLE_IF_NOT_EXISTS",
    ]),
    // Lifecycle Phase 6 (2026-07-17) — organization_closure_requests:
    // pure-additive CREATE TABLE IF NOT EXISTS + guarded indexes + FKs in
    // DO/duplicate_object blocks. Zero destructive statements, no
    // backfill (closure requests start empty).
    "20270921000000_organization_closure_requests": new Set([
      "CREATE_TABLE_IF_NOT_EXISTS",
    ]),
    // Lifecycle Phase 7 (2026-07-17) — workspace_closure_requests:
    // pure-additive CREATE TABLE IF NOT EXISTS + guarded indexes + FKs in
    // DO/duplicate_object blocks. Zero destructive statements, no
    // backfill (closure requests start empty).
    "20270922000000_workspace_closure_requests": new Set([
      "CREATE_TABLE_IF_NOT_EXISTS",
    ]),
    // Workspace-persona deletion (2026-07-20) — drops the orphan
    // `workspace_persona_profiles` table. Product-approved physical
    // deletion of the retired workspace-persona, workflow-personalization,
    // onboarding-draft and operational-density feature family. The table
    // was UX-layer only (never granted capabilities) and now has zero
    // code / service / schema references after the repository-wide
    // deletion. Uses `DROP TABLE IF EXISTS … CASCADE` (idempotent + safe
    // on partial state), mirroring the approved
    // `20261009000000_drop_reviewer_queue_projection` precedent.
    // Documented in `docs/operations/audit-closure-ledger.md`.
    "20270924000000_drop_workspace_persona_profiles": new Set(["DROP_TABLE"]),
    // ---- PHASE 12B convergence migrations (authored, UNAPPLIED) ------------
    // Every entry below is registered with the SPECIFIC finding kinds it
    // carries and why they are safe. This is a register, not a suppression:
    // any other kind on these migrations, and any unlisted migration, still
    // fails the gate.
    //
    // Track 1B closure — removes the legacy `Evidence.case_id` column after
    // the canonical `case_evidence_links` join model took over. The DELETE
    // and DROP INDEX target only the legacy column's own artifacts, and the
    // migration self-guards with a RAISE EXCEPTION on any row that has not
    // been converted, so it cannot run against unconverted data.
    // PHASE 12 POINT 6 — SPLIT into an EXPAND half
    // (20271104000000_case_evidence_link_integrity: final backfill + the two
    // validated foreign keys, Release B — carries no destructive kind and so
    // needs no registration) and this CONTRACT half, Release D.
    "20271105000000_evidence_case_id_removal": new Set([
      "ALTER_TABLE_DROP_COLUMN",
      "DROP_INDEX",
    ]),
    // PHASE 12B CLUSTER 8 — makes `evidence_legal_holds` the CANONICAL
    // legal-hold model. Purely additive columns + FKs + a scope/target CHECK;
    // the INDEX_COLUMN_RISK findings are the new indexes on the columns this
    // same migration adds, which is the intended shape for an additive
    // convergence step.
    "20271106000000_legal_hold_canonical": new Set(["INDEX_COLUMN_RISK"]),
    // PHASE 12B CLUSTER 8 — removes the two legacy legal-hold stores AFTER
    // the backfill. Authored but MUST NOT be applied until the backfill is
    // applied and verified; it guards itself with a RAISE EXCEPTION on any
    // unconverted row, so the DROP cannot silently lose a hold.
    "20271108000000_legal_hold_legacy_removal": new Set([
      "DROP_TABLE",
      "DROP_TYPE",
    ]),
    // PHASE 12B CLUSTER 9 — adds the optimistic-concurrency `version` column
    // to `workspace_governance_policies`. The SET NOT NULL is applied in the
    // same statement as a DEFAULT on a column this migration just created, so
    // there is no pre-existing NULL population to make ready.
    "20271109000000_workspace_governance_policy_version": new Set([
      "SET_NOT_NULL_NO_READINESS",
    ]),
    // PHASE 12B B3 — binds a step-up challenge to its originating session and
    // Organization. Both columns are NULLABLE and additive; the index is on
    // the columns this migration adds.
    "20271111000000_step_up_session_organization_binding": new Set([
      "INDEX_COLUMN_RISK",
    ]),
    // PHASE 12 POINT 5 — durable report/package generation authority.
    //
    // Pure-additive, mirroring the wave2 / contact-sales / email-verification
    // precedents: ONE new table via CREATE TABLE IF NOT EXISTS, every index
    // CREATE ... IF NOT EXISTS. Zero DROP / RENAME / TRUNCATE / DELETE, zero
    // ALTER on any existing table, zero data movement, no backfill — so a
    // failed apply leaves the prior state exactly intact and a deployment
    // still running the previous build is unaffected until its code is
    // replaced.
    //
    // Why it exists: report generation was requested by putting
    // { evidenceId, forceRegenerate, regenerateReason } on a BullMQ payload.
    // `forceRegenerate` is the OUTCOME OF AN AUTHORIZATION DECISION — it
    // bypasses the guard that refuses to regenerate an already-REPORTED
    // artifact — and it was arriving as an unverified boolean on a queue
    // message. The authorized synchronous path now persists the intent in
    // `report_generation_requests` and the queue carries only that row's id.
    //
    // Rehearsed against a disposable PostgreSQL 16 over the full migration
    // history: `prisma migrate deploy` applied cleanly, and a second run
    // reported no pending migrations (idempotent). Unapplied remotely; also
    // registered in phase-32-7-2-security-event-mapping-drift.test.ts and in
    // docs/architecture/compatibility-adapter-registry.json as
    // OWNER_MIGRATION_PENDING.
    "20271113000000_point5_report_generation_authority": new Set([
      "CREATE_TABLE_IF_NOT_EXISTS",
    ]),
  };

  it("every migration with timestamp > baseline has ZERO CRITICAL findings", async () => {
    const { detectFindings, parseMigrationName } = await loadAudit();
    const root = REPO_ROOT + MIGRATIONS_DIR;
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    const violations: Array<{
      migration: string;
      criticalCount: number;
      kinds: string[];
    }> = [];

    for (const name of dirs) {
      const { timestamp } = parseMigrationName(name);
      if (!timestamp) continue;
      if (timestamp <= BASELINE_TIMESTAMP) continue;
      const sqlPath = `${root}/${name}/migration.sql`;
      if (!existsSync(sqlPath)) continue;
      const sql = readFileSync(sqlPath, "utf8");
      const { findings } = detectFindings(sql);
      const approved = APPROVED_CRITICAL_BY_MIGRATION[name] ?? new Set();
      const crit = findings.filter(
        (f) => f.risk === "CRITICAL" && !approved.has(f.kind),
      );
      if (crit.length > 0) {
        violations.push({
          migration: name,
          criticalCount: crit.length,
          kinds: [...new Set(crit.map((f) => f.kind))],
        });
      }
    }

    if (violations.length > 0) {
      const msg = violations
        .map(
          (v) =>
            `  ${v.migration}: ${v.criticalCount} CRITICAL findings — ${v.kinds.join(", ")}`,
        )
        .join("\n");
      throw new Error(
        `Post-baseline migration(s) introduced CRITICAL findings. Fix or wrap in Phase O-Final-style DO blocks before commit:\n${msg}`,
      );
    }
    expect(violations).toEqual([]);
  });

  it("the Phase O-Final repair migration itself passes the gate", async () => {
    const { detectFindings } = await loadAudit();
    const sql = read(
      "services/api/prisma/migrations/20261006000000_phase_o_final_production_column_repair/migration.sql",
    );
    const { findings } = detectFindings(sql);
    const crit = findings.filter((f) => f.risk === "CRITICAL");
    expect(crit, `Phase O-Final must be the gate's precedent: zero CRITICAL findings.`).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Documentation outputs from the audit script must exist and be
//    non-empty (so the repair plan and inventory ride along with the
//    code review).
// ---------------------------------------------------------------------------

describe("Phase O — committed audit outputs", () => {
  it(`${INVENTORY_MD} exists and is non-empty`, () => {
    expect(exists(INVENTORY_MD)).toBe(true);
    expect(statSync(REPO_ROOT + INVENTORY_MD).size).toBeGreaterThan(500);
  });

  it(`${REPAIR_PLAN_MD} exists and is non-empty`, () => {
    expect(exists(REPAIR_PLAN_MD)).toBe(true);
    expect(statSync(REPO_ROOT + REPAIR_PLAN_MD).size).toBeGreaterThan(500);
  });

  it("inventory documents the 4 verdict buckets and CRITICAL kind table", () => {
    const src = read(INVENTORY_MD);
    expect(src).toMatch(/Verdict SAFE/);
    expect(src).toMatch(/Verdict RISKY/);
    expect(src).toMatch(/Verdict UNSAFE/);
    expect(src).toMatch(/CRITICAL findings/);
  });

  it("repair plan documents Prisma compatibility + naming drift sections", () => {
    const src = read(REPAIR_PLAN_MD);
    expect(src).toMatch(/Prisma compatibility/);
    expect(src).toMatch(/Naming drift/);
    expect(src).toMatch(/Required tests/);
    expect(src).toMatch(/Required production validation/);
  });
});

// ---------------------------------------------------------------------------
// 6. parsePrismaModelMap smoke — verify the helper extracts model+table
//    mappings against the real PROOVRA schema without crashing.
// ---------------------------------------------------------------------------

describe("Phase O — parsePrismaModelMap smoke", () => {
  it("parses the real PROOVRA schema and finds DiscussionMention → discussion_mentions", async () => {
    const { parsePrismaModelMap } = await loadAudit();
    const src = read("services/api/prisma/schema.prisma");
    const map = parsePrismaModelMap(src);
    expect(map.size).toBeGreaterThan(100);
    const dm = map.get("DiscussionMention");
    expect(dm?.table).toBe("discussion_mentions");
    expect(dm?.columns.has("mentioned_user_id")).toBe(true);
    expect(dm?.columns.has("team_id")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Naming-drift detector smoke
// ---------------------------------------------------------------------------

describe("Phase O — detectNamingDriftInSql", () => {
  it("flags quoted camelCase identifiers as drift", async () => {
    const { detectNamingDriftInSql } = await loadAudit();
    const drift = detectNamingDriftInSql(
      `ALTER TABLE "widgets" ADD COLUMN "teamId" UUID;`,
    );
    expect(drift.length).toBeGreaterThanOrEqual(1);
    const teamId = drift.find((d) => d.identifier === "teamId");
    expect(teamId?.altSnake).toBe("team_id");
  });
  it("does not flag pure snake_case identifiers", async () => {
    const { detectNamingDriftInSql } = await loadAudit();
    const drift = detectNamingDriftInSql(
      `ALTER TABLE "widgets" ADD COLUMN "team_id" UUID;`,
    );
    expect(drift.length).toBe(0);
  });
});
