/**
 * INTERNAL-GRANT ROLLOUT — READ-ONLY operator checks for the release that ships
 * the internal plan grant (migrations 20281001000000..000700 + 20281002000000).
 * See docs/operations/internal-grant-production-rollout.md for the order.
 *
 *   pnpm --filter proovra-api ops:internal-grant-rollout readiness
 *   pnpm --filter proovra-api ops:internal-grant-rollout verify-schema
 *   pnpm --filter proovra-api ops:internal-grant-rollout admins
 *   pnpm --filter proovra-api ops:internal-grant-rollout snapshot --email=<email> | --user-id=<uuid> [--out=<file>]
 *   pnpm --filter proovra-api ops:internal-grant-rollout compare --before=<file> --after=<file>
 *        [--expect=grant-applied|none] [--idempotency-key=<key>] [--expiry-days=90]
 *
 * EVERY database read runs inside ONE transaction whose first statement is
 * `SET TRANSACTION READ ONLY`, so PostgreSQL itself refuses any write this tool
 * could attempt. `readiness` uses raw catalog/count queries only, because it
 * runs BEFORE the migrations — when the Prisma models already describe columns
 * the database does not have yet. Output is counts, names, ids and SHA-256
 * fingerprints: never a row's contents, an email, a credential or a provider id.
 *
 * Exit codes: 0 = PASS / READY, 3 = NOT READY / FAIL (with the reasons), 1 = error.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { prisma } from "../db.js";
import { resolvePersonalEffectivePlan } from "@proovra/shared-billing";
import { readActiveInternalPlanGrant } from "@proovra/shared-runtime";
import { normalizeGrantEmail, resolveInternalGrantSubject } from "../services/billing/internal-plan-grant.service.js";

/** The release, in apply order. Nothing outside this list may be pending. */
export const ROLLOUT_MIGRATIONS = Object.freeze([
  "20281001000000_derived_asset_generations",
  "20281001000100_acquisition_source_backfill_only",
  "20281001000200_case_evidence_link_pair_unique",
  "20281001000300_entitlement_one_active",
  "20281001000400_signing_key_identity_immutable",
  "20281001000500_capture_trust_events_append_only",
  "20281001000600_derived_asset_storage_version",
  "20281001000700_retention_backfill_direct_capture",
  "20281002000000_internal_plan_grants",
]);

export const BACKFILL_CHANNELS = Object.freeze([
  "PROOVRA_MOBILE_APP",
  "DIRECT_WEB_CAPTURE_EXTENSION",
  "DIRECT_SCREEN_CAPTURE_ANDROID",
  "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS",
  "DIRECT_SCREEN_CAPTURE_IOS",
]);

/** Exactly the WHERE of 20281001000700, so the count is the rows it will update. */
const BACKFILL_CANDIDATES_SQL = `
  SELECT e."acquisition_mode"::text AS mode, count(*)::int AS n
    FROM "evidence" AS e
    JOIN "workspace_governance_policies" AS p ON p."team_id" = e."team_id"
   WHERE p."default_retention_days" > 0
     AND e."retention_until_utc" IS NULL
     AND e."deleted_at" IS NULL
     AND e."acquisition_mode"::text IN (${BACKFILL_CHANNELS.map((c) => `'${c}'`).join(", ")})
   GROUP BY 1 ORDER BY 1`;

/**
 * Every SQL statement this tool can send. A test asserts none of them can
 * write; the READ ONLY transaction enforces it again at the database.
 */
export const READ_ONLY_SQL = Object.freeze({
  readOnly: `SET TRANSACTION READ ONLY`,
  migrationRows: `SELECT migration_name, (finished_at IS NOT NULL) AS finished, (rolled_back_at IS NOT NULL) AS rolled_back
                    FROM "_prisma_migrations" ORDER BY migration_name`,
  relations: `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')`,
  functions: `SELECT p.proname AS name, pg_get_functiondef(p.oid) AS def FROM pg_proc p
               JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = current_schema()
                 AND p.proname IN ('proovra_refuse_history_rewrite', 'evidence_acquisition_set_once', 'signing_keys_identity_immutable')`,
  enumLabels: `SELECT t.typname AS type, e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                WHERE t.typname IN ('PlanType', 'PlanGrantSource')`,
  columns: `SELECT table_name, column_name, data_type FROM information_schema.columns
             WHERE table_schema = current_schema()
               AND (table_name, column_name) IN (('evidence_part_derived_assets', 'generation_parameters'),
                                                 ('evidence_part_derived_assets', 'storage_version_id'),
                                                 ('evidence', 'signing_key_sha256'),
                                                 ('evidence', 'acquisition_mode'),
                                                 ('evidence', 'retention_until_utc'),
                                                 ('workspace_governance_policies', 'default_retention_days'))`,
  indexes: `SELECT indexname AS name, indexdef AS def FROM pg_indexes
             WHERE schemaname = current_schema()
               AND indexname IN ('case_evidence_links_case_id_evidence_id_key', 'entitlements_user_id_active_key',
                                 'plan_grants_idempotency_key_key', 'plan_grants_user_id_idx',
                                 'plan_grants_one_unrevoked_per_user_source')`,
  triggers: `SELECT t.tgname AS name, c.relname AS table_name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
              WHERE NOT t.tgisinternal
                AND t.tgname IN ('signing_keys_identity_immutable', 'signing_keys_no_delete',
                                 'capture_trust_event_records_append_only', 'evidence_acquisition_set_once_trg')`,
  constraints: `SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint
                 WHERE conname IN ('evidence_part_derived_assets_status_bounded', 'plan_grants_plan_team_only',
                                   'plan_grants_reason_present', 'plan_grants_revocation_complete',
                                   'plan_grants_expiry_after_grant')
                    OR (conrelid = to_regclass('plan_grants') AND contype = 'f')`,
  duplicateLinkPairs: `SELECT count(*)::int AS pairs, coalesce(sum(n), 0)::int AS link_rows FROM (
                         SELECT count(*) AS n FROM "case_evidence_links" GROUP BY "case_id", "evidence_id" HAVING count(*) > 1) d`,
  multiActiveEntitlements: `SELECT count(*)::int AS users, coalesce(sum(n), 0)::int AS active_rows FROM (
                              SELECT count(*) AS n FROM "entitlements" WHERE "active" = true GROUP BY "user_id" HAVING count(*) > 1) d`,
  duplicatePolicies: `SELECT count(*)::int AS teams FROM (
                        SELECT "team_id" FROM "workspace_governance_policies" GROUP BY 1 HAVING count(*) > 1) d`,
  derivedStatusOutsideCatalog: `SELECT count(*)::int AS n FROM "evidence_part_derived_assets"
                                 WHERE "status" NOT IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'UNSUPPORTED', 'SUPERSEDED')`,
  backfillCandidates: BACKFILL_CANDIDATES_SQL,
  rowEstimates: `SELECT c.relname AS name, greatest(c.reltuples, 0)::bigint AS estimate FROM pg_class c
                  JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = current_schema()
                    AND c.relname IN ('evidence', 'evidence_part_derived_assets', 'case_evidence_links', 'entitlements',
                                      'signing_keys', 'capture_trust_event_records', 'users')`,
  longTransactions: `SELECT count(*)::int AS n FROM pg_stat_activity
                      WHERE datname = current_database() AND pid <> pg_backend_pid()
                        AND xact_start IS NOT NULL AND xact_start < now() - interval '60 seconds'`,
  planGrantRows: `SELECT count(*)::int AS n FROM "plan_grants"`,
});

/** A statement that could change data or schema. Comments/strings are not parsed: every statement here is a literal. */
const WRITE_VERB = /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|VACUUM|REINDEX|CLUSTER|LOCK|COMMENT|SECURITY|REFRESH)\b/i;
export function isReadOnlyStatement(sql: string): boolean {
  if (/^\s*SET TRANSACTION READ ONLY\s*$/i.test(sql)) return true;
  return /^\s*SELECT\b/i.test(sql) && !WRITE_VERB.test(sql) && !sql.includes(";");
}

type Raw = <T = unknown>(sql: string, ...params: unknown[]) => Promise<T[]>;
type Check = { name: string; ok: boolean; detail: string };

/** One READ ONLY transaction; every statement is checked before it is sent. */
async function readOnly<T>(fn: (q: Raw, tx: typeof prisma) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      const q: Raw = async (sql, ...params) => {
        if (!isReadOnlyStatement(sql)) throw new Error("refusing a statement that is not a plain SELECT");
        return (await tx.$queryRawUnsafe(sql, ...params)) as never;
      };
      await tx.$executeRawUnsafe(READ_ONLY_SQL.readOnly);
      return fn(q, tx as unknown as typeof prisma);
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
}

function migrationsOnDisk(): string[] {
  const dir = resolve(process.cwd(), "prisma", "migrations");
  if (!existsSync(dir)) throw new Error(`no prisma/migrations under ${process.cwd()} — run from services/api`);
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(resolve(dir, d.name, "migration.sql")))
    .map((d) => d.name)
    .sort();
}

type MigrationRow = { migration_name: string; finished: boolean; rolled_back: boolean };

/** Pure: what is pending, and is the pending set exactly (a suffix of) this release? */
export function evaluateMigrationState(onDisk: string[], rows: MigrationRow[], phase: "pre" | "post"): Check[] {
  const applied = new Map<string, number>();
  let failed = 0;
  for (const r of rows) {
    if (r.finished && !r.rolled_back) applied.set(r.migration_name, (applied.get(r.migration_name) ?? 0) + 1);
    if (!r.finished && !r.rolled_back) failed += 1;
  }
  const pending = onDisk.filter((m) => !applied.has(m));
  const unrelated = pending.filter((m) => !ROLLOUT_MIGRATIONS.includes(m));
  const unknownApplied = [...applied.keys()].filter((m) => !onDisk.includes(m));
  const checks: Check[] = [
    { name: "no failed or in-progress migration rows", ok: failed === 0, detail: `${failed} row(s) unfinished and not rolled back` },
    {
      name: "the image's migration directory knows every applied migration",
      ok: unknownApplied.length === 0,
      detail: unknownApplied.length ? `applied but not in this image: ${unknownApplied.join(", ")}` : "all applied migrations are present",
    },
    {
      name: "no pending migration outside this release",
      ok: unrelated.length === 0,
      detail: unrelated.length ? `UNRELATED pending: ${unrelated.join(", ")}` : "none",
    },
  ];
  for (const m of ROLLOUT_MIGRATIONS) {
    if (!onDisk.includes(m)) checks.push({ name: `${m} is in this image`, ok: false, detail: "missing from prisma/migrations" });
  }
  if (phase === "pre") {
    checks.push({
      name: "this release is still pending (in order, nothing after it applied)",
      ok: pending.length > 0 && pending.every((m) => ROLLOUT_MIGRATIONS.includes(m)),
      detail: `pending: ${pending.length ? pending.join(", ") : "none — already applied"}`,
    });
  } else {
    for (const m of ROLLOUT_MIGRATIONS) {
      const n = applied.get(m) ?? 0;
      checks.push({ name: `${m} recorded exactly once`, ok: n === 1, detail: `${n} finished row(s)` });
    }
    checks.push({ name: "nothing pending", ok: pending.length === 0, detail: pending.length ? pending.join(", ") : "none" });
  }
  return checks;
}

const first = <T>(rows: T[]): T => rows[0] as T;

async function readiness(): Promise<{ ok: boolean; report: unknown }> {
  return readOnly(async (q) => {
    const rows = await q<MigrationRow>(READ_ONLY_SQL.migrationRows);
    const checks = evaluateMigrationState(migrationsOnDisk(), rows, "pre");
    const relations = new Set((await q<{ name: string }>(READ_ONLY_SQL.relations)).map((r) => r.name));
    for (const t of [
      "evidence",
      "evidence_part_derived_assets",
      "case_evidence_links",
      "entitlements",
      "signing_keys",
      "capture_trust_event_records",
      "workspace_governance_policies",
      "users",
    ]) {
      checks.push({ name: `table ${t} exists`, ok: relations.has(t), detail: relations.has(t) ? "present" : "MISSING" });
    }
    const grantsApplied = rows.some((r) => r.migration_name === "20281002000000_internal_plan_grants" && r.finished);
    checks.push({
      name: "plan_grants matches its migration state",
      ok: relations.has("plan_grants") === grantsApplied,
      detail: `table ${relations.has("plan_grants") ? "present" : "absent"}, migration ${grantsApplied ? "applied" : "pending"}`,
    });
    const fns = new Set((await q<{ name: string }>(READ_ONLY_SQL.functions)).map((r) => r.name));
    checks.push({
      name: "proovra_refuse_history_rewrite() exists (000400/000500 bind triggers to it)",
      ok: fns.has("proovra_refuse_history_rewrite"),
      detail: fns.has("proovra_refuse_history_rewrite") ? "present" : "MISSING",
    });
    const labels = await q<{ type: string; label: string }>(READ_ONLY_SQL.enumLabels);
    checks.push({
      name: 'enum "PlanType" has TEAM',
      ok: labels.some((l) => l.type === "PlanType" && l.label === "TEAM"),
      detail: "required by plan_grants_plan_team_only",
    });
    const cols = await q<{ table_name: string; column_name: string }>(READ_ONLY_SQL.columns);
    for (const [t, c] of [
      ["evidence", "acquisition_mode"],
      ["evidence", "retention_until_utc"],
      ["workspace_governance_policies", "default_retention_days"],
    ]) {
      const ok = cols.some((r) => r.table_name === t && r.column_name === c);
      checks.push({ name: `column ${t}.${c} exists (read by 000700)`, ok, detail: ok ? "present" : "MISSING" });
    }

    const dupLinks = first(await q<{ pairs: number; link_rows: number }>(READ_ONLY_SQL.duplicateLinkPairs));
    checks.push({
      name: "000200: zero duplicate (case, evidence) link pairs",
      ok: dupLinks.pairs === 0,
      detail: `${dupLinks.pairs} pair(s) over ${dupLinks.link_rows} row(s) — the migration REFUSES if > 0; an operator resolves them, nothing is deleted automatically`,
    });
    const multi = first(await q<{ users: number; active_rows: number }>(READ_ONLY_SQL.multiActiveEntitlements));
    checks.push({
      name: "000300: zero users with more than one active entitlement",
      ok: multi.users === 0,
      detail: `${multi.users} user(s) over ${multi.active_rows} active row(s) — the migration REFUSES if > 0; credits must be reconciled by an operator`,
    });
    const status = first(await q<{ n: number }>(READ_ONLY_SQL.derivedStatusOutsideCatalog));
    checks.push({
      name: "000000: every derived-asset status is inside the widened catalog",
      ok: status.n === 0,
      detail: `${status.n} row(s) outside — ADD CONSTRAINT would fail`,
    });
    const dupPolicies = first(await q<{ teams: number }>(READ_ONLY_SQL.duplicatePolicies));
    checks.push({
      name: "000700: one governance policy per team (the backfill join is unambiguous)",
      ok: dupPolicies.teams === 0,
      detail: `${dupPolicies.teams} team(s) with more than one policy row`,
    });
    const candidates = await q<{ mode: string; n: number }>(READ_ONLY_SQL.backfillCandidates);
    const longTx = first(await q<{ n: number }>(READ_ONLY_SQL.longTransactions));
    const estimates = await q<{ name: string; estimate: bigint }>(READ_ONLY_SQL.rowEstimates);
    const ok = checks.every((c) => c.ok);
    return {
      ok,
      report: {
        verdict: ok ? "READY" : "NOT READY",
        checks,
        backfill000700: {
          expectedRowsUpdated: candidates.reduce((s, r) => s + r.n, 0),
          byChannel: Object.fromEntries(candidates.map((r) => [r.mode, r.n])),
        },
        lockPlanning: {
          transactionsOlderThan60s: longTx.n,
          rowEstimates: Object.fromEntries(estimates.map((r) => [r.name, Number(r.estimate)])),
        },
      },
    };
  });
}

async function verifySchema(): Promise<{ ok: boolean; report: unknown }> {
  return readOnly(async (q) => {
    const checks = evaluateMigrationState(migrationsOnDisk(), await q<MigrationRow>(READ_ONLY_SQL.migrationRows), "post");
    const cols = await q<{ table_name: string; column_name: string; data_type: string }>(READ_ONLY_SQL.columns);
    for (const [t, c, type] of [
      ["evidence_part_derived_assets", "generation_parameters", "jsonb"],
      ["evidence_part_derived_assets", "storage_version_id", "character varying"],
      ["evidence", "signing_key_sha256", "character varying"],
    ]) {
      const hit = cols.find((r) => r.table_name === t && r.column_name === c);
      checks.push({ name: `column ${t}.${c} (${type})`, ok: hit?.data_type === type, detail: hit ? hit.data_type : "MISSING" });
    }
    const idx = new Map((await q<{ name: string; def: string }>(READ_ONLY_SQL.indexes)).map((r) => [r.name, r.def]));
    const idxExpect: Array<[string, RegExp]> = [
      ["case_evidence_links_case_id_evidence_id_key", /UNIQUE INDEX .*\(case_id, evidence_id\)/],
      ["entitlements_user_id_active_key", /UNIQUE INDEX .*\(user_id\) WHERE \(?active = true\)?/],
      ["plan_grants_idempotency_key_key", /UNIQUE INDEX .*\(idempotency_key\)/],
      ["plan_grants_user_id_idx", /INDEX .*\(user_id\)/],
      ["plan_grants_one_unrevoked_per_user_source", /UNIQUE INDEX .*\(user_id, source\) WHERE \(?revoked_at_utc IS NULL\)?/],
    ];
    for (const [name, re] of idxExpect) {
      const def = idx.get(name) ?? "";
      checks.push({ name: `index ${name}`, ok: re.test(def), detail: def || "MISSING" });
    }
    const trg = new Set((await q<{ name: string; table_name: string }>(READ_ONLY_SQL.triggers)).map((r) => `${r.table_name}.${r.name}`));
    for (const t of [
      "signing_keys.signing_keys_identity_immutable",
      "signing_keys.signing_keys_no_delete",
      "capture_trust_event_records.capture_trust_event_records_append_only",
      "evidence.evidence_acquisition_set_once_trg",
    ]) {
      checks.push({ name: `trigger ${t}`, ok: trg.has(t), detail: trg.has(t) ? "present" : "MISSING" });
    }
    const fns = new Map((await q<{ name: string; def: string }>(READ_ONLY_SQL.functions)).map((r) => [r.name, r.def]));
    checks.push({
      name: "evidence_acquisition_set_once() refuses a late non-BACKFILL source (000100)",
      ok: /NOT LIKE 'BACKFILL\\\\?_%'/.test(fns.get("evidence_acquisition_set_once") ?? ""),
      detail: fns.has("evidence_acquisition_set_once") ? "function body checked" : "MISSING",
    });
    const cons = await q<{ name: string; def: string }>(READ_ONLY_SQL.constraints);
    const con = (n: string) => cons.find((c) => c.name === n)?.def ?? "";
    checks.push({
      name: "evidence_part_derived_assets_status_bounded admits SUPERSEDED (000000)",
      ok: con("evidence_part_derived_assets_status_bounded").includes("SUPERSEDED"),
      detail: con("evidence_part_derived_assets_status_bounded") || "MISSING",
    });
    for (const n of ["plan_grants_plan_team_only", "plan_grants_reason_present", "plan_grants_revocation_complete", "plan_grants_expiry_after_grant"]) {
      checks.push({ name: `constraint ${n}`, ok: con(n) !== "", detail: con(n) || "MISSING" });
    }
    checks.push({
      name: "plan_grants.user_id references users ON DELETE CASCADE",
      ok: cons.some((c) => /FOREIGN KEY \(user_id\) REFERENCES "?users"?\(id\).*ON DELETE CASCADE/.test(c.def)),
      detail: "foreign key",
    });
    const labels = await q<{ type: string; label: string }>(READ_ONLY_SQL.enumLabels);
    const grantLabels = labels.filter((l) => l.type === "PlanGrantSource").map((l) => l.label);
    checks.push({
      name: 'enum "PlanGrantSource" = {INTERNAL_TEST}',
      ok: grantLabels.length === 1 && grantLabels[0] === "INTERNAL_TEST",
      detail: grantLabels.join(", ") || "MISSING",
    });
    const remaining = (await q<{ n: number }>(READ_ONLY_SQL.backfillCandidates)).reduce((s, r) => s + r.n, 0);
    checks.push({ name: "000700 left no candidate row", ok: remaining === 0, detail: `${remaining} remaining` });
    const grants = first(await q<{ n: number }>(READ_ONLY_SQL.planGrantRows));
    const ok = checks.every((c) => c.ok);
    return { ok, report: { verdict: ok ? "PASS" : "FAIL", checks, planGrantRows: grants.n } };
  });
}

// ----------------------------------------------------------------------------
// subject snapshot — what an activation may and may not change
// ----------------------------------------------------------------------------
function canonical(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof (v as { toFixed?: unknown }).toFixed === "function" && typeof (v as { d?: unknown }).d !== "undefined") {
      return String(value); // Prisma Decimal
    }
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  }
  return value;
}

/** Count + SHA-256 over the rows' full canonical content: any change to any column changes it. */
export function fingerprint(rows: unknown[]): { count: number; sha256: string } {
  const sorted = rows.map((r) => JSON.stringify(canonical(r))).sort();
  return { count: rows.length, sha256: createHash("sha256").update(sorted.join("\n")).digest("hex") };
}

const ROW_CAP = 20_000;
async function rowsOf(model: { findMany: (a: unknown) => Promise<unknown[]> }, where: unknown): Promise<unknown[]> {
  const rows = await model.findMany({ where, take: ROW_CAP + 1 });
  if (rows.length > ROW_CAP) throw new Error(`more than ${ROW_CAP} rows — refusing a partial fingerprint`);
  return rows;
}

export type SubjectSnapshot = {
  takenAtUtc: string;
  userId: string;
  personalTeamId: string | null;
  providerPlan: string | null;
  activeEntitlements: number;
  effective: { plan: string; source: string };
  activeGrant: null | {
    id: string;
    plan: string;
    source: string;
    grantedAtUtc: string;
    expiresAtUtc: string | null;
    idempotencyKey: string;
  };
  subjectGrants: number;
  subjectAppliedEvents: number;
  globalPlanGrants: number;
  globalAppliedEvents: number;
  fingerprints: Record<string, { count: number; sha256: string }>;
};

async function snapshot(subject: { email?: string | null; userId?: string | null }): Promise<SubjectSnapshot> {
  return readOnly(async (_q, tx) => {
    const { userId } = await resolveInternalGrantSubject(
      { email: subject.email ? normalizeGrantEmail(subject.email) : null, userId: subject.userId ?? null },
      tx,
    );
    const now = new Date();
    const entitlements = await rowsOf(tx.entitlement as never, { userId });
    const active = (entitlements as Array<{ active: boolean; plan: string; createdAt: Date }>)
      .filter((e) => e.active)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const providerPlan = active[0]?.plan ?? null;
    const grant = await readActiveInternalPlanGrant(tx as never, userId, now);
    const effective = resolvePersonalEffectivePlan({
      providerPlan: (providerPlan ?? "FREE") as never,
      internalGrantPlan: (grant?.plan ?? null) as never,
    });
    const activeRow = grant
      ? await tx.planGrant.findUnique({ where: { id: grant.id } })
      : null;
    const ownedTeams = (await rowsOf(tx.team as never, { ownerUserId: userId })) as Array<{ id: string; isPersonal: boolean }>;
    const ownedTeamIds = ownedTeams.map((t) => t.id);
    const subjectGrantIds = (await tx.planGrant.findMany({ where: { userId }, select: { id: true } })).map((g) => g.id);
    const applied = { action: "billing.internal_grant.applied", resourceType: "plan_grant" };
    const evidence = await rowsOf(tx.evidence as never, { ownerUserId: userId });
    const evidenceIds = (evidence as Array<{ id: string }>).map((e) => e.id);
    return {
      takenAtUtc: now.toISOString(),
      userId,
      personalTeamId: ownedTeams.find((t) => t.isPersonal)?.id ?? null,
      providerPlan,
      activeEntitlements: active.length,
      effective: { plan: effective.plan, source: effective.source },
      activeGrant: activeRow
        ? {
            id: activeRow.id,
            plan: activeRow.plan,
            source: activeRow.source,
            grantedAtUtc: activeRow.grantedAtUtc.toISOString(),
            expiresAtUtc: activeRow.expiresAtUtc?.toISOString() ?? null,
            idempotencyKey: activeRow.idempotencyKey,
          }
        : null,
      subjectGrants: subjectGrantIds.length,
      subjectAppliedEvents: subjectGrantIds.length
        ? await tx.adminAuditLog.count({ where: { ...applied, resourceId: { in: subjectGrantIds } } })
        : 0,
      globalPlanGrants: await tx.planGrant.count(),
      globalAppliedEvents: await tx.adminAuditLog.count({ where: applied }),
      fingerprints: {
        entitlements: fingerprint(entitlements),
        subscriptions: fingerprint(await rowsOf(tx.subscription as never, { userId })),
        payments: fingerprint(await rowsOf(tx.payment as never, { userId })),
        billingCheckoutAttempts: fingerprint(await rowsOf(tx.billingCheckoutAttempt as never, { userId })),
        evidenceCreditLedger: fingerprint(await rowsOf(tx.evidenceCreditLedgerEntry as never, { userId })),
        memberships: fingerprint(await rowsOf(tx.teamMember as never, { userId })),
        ownedTeams: fingerprint(ownedTeams),
        storageAddons: fingerprint(await rowsOf(tx.workspaceStorageAddon as never, { ownerUserId: userId })),
        workspaceUsage: fingerprint(await rowsOf(tx.entitlementUsage as never, { teamId: { in: ownedTeamIds } })),
        evidence: fingerprint(evidence),
        reports: fingerprint(await rowsOf(tx.report as never, { evidenceId: { in: evidenceIds } })),
        verificationPackages: fingerprint(await rowsOf(tx.verificationPackage as never, { evidenceId: { in: evidenceIds } })),
      },
    };
  });
}

/**
 * Pure. `grant-applied`: the activation changed exactly one grant row and one
 * applied event, and nothing else of the subject. `none`: nothing changed at all
 * (the idempotent replay).
 */
export function compareSnapshots(
  before: SubjectSnapshot,
  after: SubjectSnapshot,
  expect: "grant-applied" | "none",
  opts: { idempotencyKey?: string | null; expiryDays?: number } = {},
): Check[] {
  const checks: Check[] = [];
  const eq = (name: string, a: unknown, b: unknown) =>
    checks.push({ name, ok: JSON.stringify(a) === JSON.stringify(b), detail: `${JSON.stringify(a)} → ${JSON.stringify(b)}` });
  eq("same user", before.userId, after.userId);
  eq("same personal workspace", before.personalTeamId, after.personalTeamId);
  eq("provider plan unchanged", before.providerPlan, after.providerPlan);
  eq("active entitlement count unchanged", before.activeEntitlements, after.activeEntitlements);
  for (const k of Object.keys(before.fingerprints)) {
    eq(`${k} unchanged (count + content SHA-256)`, before.fingerprints[k], after.fingerprints[k]);
  }
  const delta = expect === "grant-applied" ? 1 : 0;
  eq(`subject grants +${delta}`, before.subjectGrants + delta, after.subjectGrants);
  eq(`subject applied events +${delta}`, before.subjectAppliedEvents + delta, after.subjectAppliedEvents);
  eq(`all grants +${delta}`, before.globalPlanGrants + delta, after.globalPlanGrants);
  eq(`all applied events +${delta}`, before.globalAppliedEvents + delta, after.globalAppliedEvents);
  if (expect === "none") {
    eq("active grant unchanged", before.activeGrant, after.activeGrant);
    eq("effective plan unchanged", before.effective, after.effective);
    return checks;
  }
  checks.push({ name: "no active grant before", ok: before.activeGrant === null, detail: JSON.stringify(before.activeGrant) });
  const g = after.activeGrant;
  checks.push({ name: "one active grant after", ok: g !== null, detail: g ? g.id : "none" });
  if (g) {
    eq("grant plan TEAM", g.plan, "TEAM");
    eq("grant source INTERNAL_TEST", g.source, "INTERNAL_TEST");
    if (opts.idempotencyKey) eq("grant idempotency key", g.idempotencyKey, opts.idempotencyKey);
    const days = opts.expiryDays ?? 90;
    const span = g.expiresAtUtc ? Date.parse(g.expiresAtUtc) - Date.parse(g.grantedAtUtc) : NaN;
    const want = days * 86_400_000;
    checks.push({
      name: `expiry = activation + ${days} days (± 10 minutes of operator latency)`,
      ok: Math.abs(span - want) <= 10 * 60_000,
      detail: `${g.grantedAtUtc} → ${g.expiresAtUtc}`,
    });
  }
  eq("effective plan TEAM / INTERNAL_GRANT", after.effective, { plan: "TEAM", source: "INTERNAL_GRANT" });
  return checks;
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------
function arg(name: string): string | null {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function print(report: unknown): void {
  console.log(JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? Number(v) : v), 2));
}

async function main(): Promise<number> {
  const command = process.argv[2];
  if (command === "readiness" || command === "verify-schema") {
    const { ok, report } = command === "readiness" ? await readiness() : await verifySchema();
    print(report);
    return ok ? 0 : 3;
  }
  if (command === "admins") {
    // The live Platform Admins by DATABASE ROLE (ids only). The operator names
    // ONE of them as --actor-user-id; this tool never picks.
    const ids = await readOnly(async (_q, tx) =>
      (await tx.user.findMany({ where: { platformRole: "admin" }, select: { id: true }, orderBy: { id: "asc" } })).map((u) => u.id),
    );
    print({ platformAdminsByDatabaseRole: ids, count: ids.length });
    return 0;
  }
  if (command === "snapshot") {
    const snap = await snapshot({ email: arg("email"), userId: arg("user-id") });
    const out = arg("out");
    if (out) writeFileSync(out, `${JSON.stringify(snap, null, 2)}\n`);
    print(snap);
    return 0;
  }
  if (command === "compare") {
    const read = (f: string | null) => {
      if (!f) throw new Error("--before and --after are required");
      return JSON.parse(readFileSync(f, "utf8")) as SubjectSnapshot;
    };
    const expect = (arg("expect") ?? "grant-applied") as "grant-applied" | "none";
    if (expect !== "grant-applied" && expect !== "none") throw new Error("--expect must be grant-applied or none");
    const checks = compareSnapshots(read(arg("before")), read(arg("after")), expect, {
      idempotencyKey: arg("idempotency-key"),
      expiryDays: arg("expiry-days") ? Number(arg("expiry-days")) : 90,
    });
    const ok = checks.every((c) => c.ok);
    print({ verdict: ok ? "PASS" : "FAIL", expect, checks });
    return ok ? 0 : 3;
  }
  throw new Error("command must be one of: readiness, verify-schema, admins, snapshot, compare");
}

const invokedDirectly = /internal-grant-rollout\.(ts|js)$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error("internal-grant-rollout failed:", err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
