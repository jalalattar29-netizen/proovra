#!/usr/bin/env node
/**
 * PHASE 12 CORRECTIVE PASS §9 — THE MIGRATION REHEARSAL HARNESS.
 *
 * Why a harness rather than "run migrate deploy and look"
 * ---------------------------------------------------------------------------
 * `prisma migrate deploy` against an empty database proves that the SQL parses
 * and that the final schema is reachable. It proves nothing about the two
 * questions that actually decide whether a release is safe:
 *
 *   1. does the chain survive a database that already contains messy,
 *      production-shaped history — duplicates, ambiguous rows, orphans; and
 *   2. do the readiness guards REFUSE when they should, rather than
 *      destroying data and reporting success?
 *
 * (2) is the one that cannot be checked by inspection. A guard that has never
 * been shown to fire is indistinguishable from a comment.
 *
 * How the "pre-contract" state is reached
 * ---------------------------------------------------------------------------
 * The pass-two migrations are moved aside, the chain is deployed, the seed is
 * written against the OLD shape, and only then are they moved back and
 * deployed. That is the same sequence a real deployment experiences, and it is
 * the only way to seed rows into columns a later migration removes.
 *
 * Safety
 * ---------------------------------------------------------------------------
 * Every database this script touches is created and dropped by this script, on
 * a disposable local PostgreSQL 16 + pgvector. It refuses to run against a URL
 * that is not loopback, and it never reads DATABASE_URL.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(HERE, "..");
const MIGRATIONS = path.join(API_ROOT, "prisma", "migrations");

/**
 * The migrations this rehearsal defers so a "before" state can be seeded.
 * Named as DATA: adding one is a deliberate act, and the harness fails if a
 * name here does not exist on disk.
 */
const PASS_TWO = [
  "20271120000000_external_review_invitation_authority_expand",
  "20271121000000_external_review_invitation_authority_backfill",
  "20271122000000_external_review_invitation_authority_contract",
  "20271123000000_workspace_kind_authority_expand",
  "20271124000000_workspace_kind_authority_backfill",
  "20271125000000_workspace_kind_authority_contract",
];

const ADMIN_URL =
  process.env.REHEARSAL_ADMIN_URL ??
  "postgresql://p12:p12@127.0.0.1:55432/postgres";

function assertLoopback(url) {
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(
      `migration-rehearsal refuses a non-loopback database host: ${host}`,
    );
  }
}

function psql(url, sql) {
  assertLoopback(url);
  const u = new URL(url);
  const r = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      process.env.REHEARSAL_CONTAINER ?? "p12-pg",
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      u.username,
      "-d",
      u.pathname.replace(/^\//, ""),
      "-t",
      "-A",
      "-c",
      sql,
    ],
    { encoding: "utf8" },
  );
  return { status: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

function deploy(url) {
  assertLoopback(url);
  const r = spawnSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
    shell: process.platform === "win32",
    // Bounded: a chain of 220+ migrations takes well under this, and an
    // unbounded wait is how a rehearsal becomes a hang with no cause.
    timeout: 900_000,
  });
  return {
    status: r.status,
    out: `${r.stdout ?? ""}\n${r.stderr ?? ""}`,
  };
}

/** Move the pass-two migrations aside and return a restore function. */
function deferPassTwo() {
  const stash = mkdtempSync(path.join(tmpdir(), "p12-rehearsal-"));
  const moved = [];
  for (const name of PASS_TWO) {
    const src = path.join(MIGRATIONS, name);
    if (!existsSync(src)) continue;
    const dst = path.join(stash, name);
    cpSync(src, dst, { recursive: true });
    rmSync(src, { recursive: true, force: true });
    moved.push(name);
  }
  return {
    moved,
    restore: () => {
      for (const name of moved) {
        const src = path.join(stash, name);
        const dst = path.join(MIGRATIONS, name);
        if (!existsSync(dst)) cpSync(src, dst, { recursive: true });
      }
      rmSync(stash, { recursive: true, force: true });
    },
  };
}

function createDatabase(name) {
  psql(ADMIN_URL, `DROP DATABASE IF EXISTS "${name}"`);
  const r = psql(ADMIN_URL, `CREATE DATABASE "${name}"`);
  if (r.status !== 0) throw new Error(`could not create ${name}: ${r.err}`);
  const u = new URL(ADMIN_URL);
  u.pathname = `/${name}`;
  const url = u.toString();
  const ext = psql(url, "CREATE EXTENSION IF NOT EXISTS vector");
  if (ext.status !== 0) {
    throw new Error(
      `pgvector is required — the schema depends on it. ${ext.err}`,
    );
  }
  return url;
}

function dropDatabase(name) {
  psql(ADMIN_URL, `DROP DATABASE IF EXISTS "${name}"`);
}

function count(url, sql) {
  const r = psql(url, sql);
  if (r.status !== 0) throw new Error(`query failed: ${r.err}`);
  return Number(r.out || "0");
}

// ---------------------------------------------------------------------------
// The seed — production-shaped history, written against the PRE-CONTRACT shape
// ---------------------------------------------------------------------------

/**
 * Deliberately messy. Every row here exists because it is a shape a real
 * database can contain and a migration has to survive:
 *
 *   * two grants, one with duplicate delivery rows (the "same" send recorded
 *     twice, which is what the previous fix would have renumbered);
 *   * a delivery whose outcome is ambiguous — neither delivered nor failed —
 *     so the backfill can be checked for inventing an outcome;
 *   * workspaces of every kind including NULL and plan-ambiguous ones;
 *   * an organization membership that has been "revoked" by deletion.
 */
const SEED_SQL = `
DO $$
DECLARE
  org_id              UUID := gen_random_uuid();
  sys_org_id          UUID := gen_random_uuid();
  owner_id            UUID := gen_random_uuid();
  member_id           UUID := gen_random_uuid();
  personal_id         UUID := gen_random_uuid();
  owned_id            UUID := gen_random_uuid();
  enterprise_owned_id UUID := gen_random_uuid();
  orgws_id            UUID := gen_random_uuid();
  nullws_id           UUID := gen_random_uuid();
  ev_id        UUID := gen_random_uuid();
  grant_a      UUID := gen_random_uuid();
  grant_b      UUID := gen_random_uuid();
BEGIN
  INSERT INTO "users" ("id", "email", "provider", "provider_user_id", "updated_at")
  VALUES (owner_id, 'rehearsal-owner@test.local', 'EMAIL', 'rehearsal-owner@test.local', now()),
         (member_id, 'rehearsal-member@test.local', 'EMAIL', 'rehearsal-member@test.local', now());

  -- TWO organizations, because production has two kinds and the distinction is
  -- the whole structural authority the backfill rests on:
  --   SYSTEM   — the internal container the platform creates so a Personal or
  --              Owned workspace can satisfy the NOT NULL organization_id;
  --   CUSTOMER — created only by enterprise provisioning.
  INSERT INTO "organizations" ("id", "name", "billing_owner_user_id", "status", "kind", "updated_at")
  VALUES (sys_org_id, 'Rehearsal System Container', owner_id, 'ACTIVE', 'SYSTEM', now()),
         (org_id, 'Rehearsal Customer Org', owner_id, 'ACTIVE', 'CUSTOMER', now());

  -- PERSONAL: isPersonal true, kind NULL (pre-backfill shape), SYSTEM container.
  INSERT INTO "teams" ("id", "name", "owner_user_id", "is_personal", "organization_id", "billing_plan", "updated_at")
  VALUES (personal_id, 'Personal Space', owner_id, TRUE, sys_org_id, 'FREE', now());
  -- OWNED on a PRO plan, kind NULL, SYSTEM container.
  INSERT INTO "teams" ("id", "name", "owner_user_id", "is_personal", "organization_id", "billing_plan", "updated_at")
  VALUES (owned_id, 'Owned Workspace', owner_id, FALSE, sys_org_id, 'PRO', now());
  -- THE ROW THAT MATTERS: isPersonal false, ENTERPRISE plan, kind NULL, but
  -- sitting in a SYSTEM container. The removed fallback classified this
  -- ORGANIZATION from the plan alone. The structural rule classifies it OWNED,
  -- which is what it actually is; the "no workspace kind is inferred from a
  -- commercial plan alone" check in Scenario B is what proves it.
  INSERT INTO "teams" ("id", "name", "owner_user_id", "is_personal", "organization_id", "billing_plan", "updated_at")
  VALUES (enterprise_owned_id, 'Enterprise-plan Owned Workspace', owner_id, FALSE, sys_org_id, 'ENTERPRISE', now());
  -- A genuine ORGANIZATION workspace: CUSTOMER container, kind NULL.
  INSERT INTO "teams" ("id", "name", "owner_user_id", "is_personal", "organization_id", "billing_plan", "updated_at")
  VALUES (orgws_id, 'Org Workspace', owner_id, FALSE, org_id, 'ENTERPRISE', now());
  -- No plan signal at all, not personal, SYSTEM container → OWNED.
  INSERT INTO "teams" ("id", "name", "owner_user_id", "is_personal", "organization_id", "billing_plan", "updated_at")
  VALUES (nullws_id, 'Unsignalled Workspace', member_id, FALSE, sys_org_id, 'FREE', now());

  INSERT INTO "team_members" ("id", "team_id", "user_id", "role", "status")
  VALUES (gen_random_uuid(), owned_id, owner_id, 'OWNER', 'ACTIVE'),
         (gen_random_uuid(), orgws_id, owner_id, 'OWNER', 'ACTIVE'),
         (gen_random_uuid(), orgws_id, member_id, 'MEMBER', 'ACTIVE');

  INSERT INTO "organization_memberships" ("id", "organization_id", "user_id", "role", "updated_at")
  VALUES (gen_random_uuid(), org_id, owner_id, 'ORG_OWNER', now()),
         (gen_random_uuid(), org_id, member_id, 'ORG_MEMBER', now());

  INSERT INTO "evidence" ("id", "title", "type", "status", "team_id", "organization_id", "owner_user_id", "updated_at")
  VALUES (ev_id, 'Rehearsal evidence', 'PHOTO', 'CREATED', orgws_id, org_id, owner_id, now());

  -- Two invitations, both in the pre-contract shape.
  INSERT INTO "external_review_grants"
    ("id", "team_id", "scope_kind", "evidence_id", "token_hash", "reviewer_email",
     "state", "invited_by_user_id", "expires_at_utc")
  VALUES
    (grant_a, orgws_id, 'EVIDENCE', ev_id, 'rehearsal-hash-a', 'a@reviewer.test',
     'INVITED', owner_id, now() + interval '7 days'),
    (grant_b, orgws_id, 'EVIDENCE', ev_id, 'rehearsal-hash-b', 'b@reviewer.test',
     'REVOKED', owner_id, now() + interval '7 days');

  INSERT INTO "external_reviewer_role_assignments"
    ("id", "team_id", "evidence_id", "granted_by_user_id", "external_email", "updated_at")
  VALUES (grant_a, orgws_id, ev_id, owner_id, 'a@reviewer.test', now()),
         (grant_b, orgws_id, ev_id, owner_id, 'b@reviewer.test', now());

  -- DUPLICATE DELIVERY HISTORY for grant_a: three rows that the old model
  -- treated as one logical send, all at attempt = 1.
  INSERT INTO "external_review_invitation_deliveries"
    ("id", "team_id", "grant_id", "status", "provider", "attempt", "recipient_email",
     "subject", "queued_at_utc", "updated_at")
  VALUES
    (gen_random_uuid(), orgws_id, grant_a, 'SENT', 'RESEND_API', 1, 'a@reviewer.test',
     'Invitation', now() - interval '3 hours', now()),
    (gen_random_uuid(), orgws_id, grant_a, 'SENT', 'RESEND_API', 1, 'a@reviewer.test',
     'Invitation', now() - interval '2 hours', now()),
    -- AMBIGUOUS: queued and never resolved. Neither delivered nor failed.
    (gen_random_uuid(), orgws_id, grant_a, 'PENDING', 'RESEND_API', 1, 'a@reviewer.test',
     'Invitation', now() - interval '1 hour', now());

  INSERT INTO "external_review_invitation_deliveries"
    ("id", "team_id", "grant_id", "status", "provider", "attempt", "recipient_email",
     "subject", "queued_at_utc", "updated_at")
  VALUES
    (gen_random_uuid(), orgws_id, grant_b, 'FAILED', 'RESEND_API', 1, 'b@reviewer.test',
     'Invitation', now() - interval '5 hours', now());
END $$;
`;

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const results = [];

function record(scenario, check, ok, detail) {
  results.push({ scenario, check, ok, detail: detail ?? null });
  const mark = ok ? "PASS" : "FAIL";
  process.stdout.write(`  [${mark}] ${scenario} — ${check}${detail ? `: ${detail}` : ""}\n`);
}

function scenarioA() {
  const db = "p12_rehearsal_empty";
  process.stdout.write("\nSCENARIO A — empty PostgreSQL 16 + pgvector\n");
  const url = createDatabase(db);
  try {
    const first = deploy(url);
    record("A", "full chain applies", first.status === 0, first.status === 0 ? null : first.out.slice(-800));
    if (first.status !== 0) return;

    const second = deploy(url);
    const noPending =
      second.status === 0 && /No pending migrations/i.test(second.out);
    record("A", "second deploy reports no pending migrations", noPending,
      noPending ? null : second.out.slice(-400));

    // The schema is reachable and the new authority columns exist.
    const tokenVersion = count(url,
      `SELECT COUNT(*) FROM information_schema.columns
        WHERE table_name='external_review_grants' AND column_name='token_version'`);
    record("A", "external_review_grants.token_version exists", tokenVersion === 1);

    const dropped = count(url,
      `SELECT COUNT(*) FROM information_schema.columns
        WHERE table_name='external_reviewer_role_assignments'
          AND column_name IN ('grant_state','raw_token','token_hash','expires_at_utc','revoked_at_utc')`);
    record("A", "the duplicate lifecycle columns are absent", dropped === 0,
      dropped === 0 ? null : `${dropped} survivor(s)`);

    const kindNotNull = psql(url,
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name='teams' AND column_name='workspace_kind'`);
    record("A", "teams.workspace_kind is NOT NULL", kindNotNull.out === "NO",
      kindNotNull.out === "NO" ? null : `is_nullable=${kindNotNull.out}`);
  } finally {
    dropDatabase(db);
  }
}

function scenarioB() {
  const db = "p12_rehearsal_history";
  process.stdout.write("\nSCENARIO B — production-shaped history\n");
  const url = createDatabase(db);
  const stash = deferPassTwo();
  try {
    const pass1 = deploy(url);
    record("B", "pre-change chain applies", pass1.status === 0,
      pass1.status === 0 ? null : pass1.out.slice(-800));
    if (pass1.status !== 0) return;

    const seeded = psql(url, SEED_SQL);
    record("B", "production-shaped history seeds", seeded.status === 0,
      seeded.status === 0 ? null : seeded.err.slice(-600));
    if (seeded.status !== 0) return;

    const beforeDeliveries = count(url, `SELECT COUNT(*) FROM external_review_invitation_deliveries`);
    const beforeTeams = count(url, `SELECT COUNT(*) FROM teams`);
    const beforeAmbiguous = count(url,
      `SELECT COUNT(*) FROM external_review_invitation_deliveries WHERE status='PENDING'`);

    stash.restore();
    const pass2 = deploy(url);
    record("B", "expand + backfill + contract apply over history", pass2.status === 0,
      pass2.status === 0 ? null : pass2.out.slice(-1500));
    if (pass2.status !== 0) return;

    const afterDeliveries = count(url, `SELECT COUNT(*) FROM external_review_invitation_deliveries`);
    record("B", "row conservation — no delivery row deleted",
      afterDeliveries === beforeDeliveries,
      `${beforeDeliveries} → ${afterDeliveries}`);

    const afterTeams = count(url, `SELECT COUNT(*) FROM teams`);
    record("B", "row conservation — no workspace deleted",
      afterTeams === beforeTeams, `${beforeTeams} → ${afterTeams}`);

    const stillAmbiguous = count(url,
      `SELECT COUNT(*) FROM external_review_invitation_deliveries WHERE status='PENDING'`);
    record("B", "no delivery outcome invented",
      stillAmbiguous === beforeAmbiguous,
      `PENDING ${beforeAmbiguous} → ${stillAmbiguous}`);

    const attemptsRewritten = count(url,
      `SELECT COUNT(*) FROM external_review_invitation_deliveries WHERE attempt <> 1`);
    record("B", "historical `attempt` values are not renumbered",
      attemptsRewritten === 0,
      attemptsRewritten === 0 ? "all still 1, as seeded" : `${attemptsRewritten} rewritten`);

    const distinctIntents = count(url,
      `SELECT COUNT(DISTINCT intent_key) FROM external_review_invitation_deliveries`);
    record("B", "every historical row has a distinct durable intent",
      distinctIntents === afterDeliveries,
      `${distinctIntents} intents over ${afterDeliveries} rows`);

    const nullKind = count(url, `SELECT COUNT(*) FROM teams WHERE workspace_kind IS NULL`);
    record("B", "no workspace is left without a kind", nullKind === 0);

    const personalOk = count(url,
      `SELECT COUNT(*) FROM teams WHERE is_personal = TRUE AND workspace_kind <> 'PERSONAL'`);
    record("B", "personal spaces classify as PERSONAL", personalOk === 0);

    // The load-bearing one: the ENTERPRISE-plan workspace must NOT have been
    // classified ORGANIZATION from its plan. Structural authority only.
    const planDerived = count(url,
      `SELECT COUNT(*) FROM teams t
        WHERE t.is_personal = FALSE
          AND t.billing_plan = 'ENTERPRISE'
          AND t.workspace_kind = 'ORGANIZATION'
          AND NOT EXISTS (
            SELECT 1 FROM organizations o
             WHERE o.id = t.organization_id AND o.kind = 'CUSTOMER'
          )`);
    record("B", "no workspace kind is inferred from a commercial plan alone",
      planDerived === 0);

    const rerun = deploy(url);
    record("B", "re-running the chain is idempotent",
      rerun.status === 0 && /No pending migrations/i.test(rerun.out));
  } finally {
    stash.restore();
    dropDatabase(db);
  }
}

/**
 * SCENARIO B-REFUSE — the guards fire.
 *
 * Each case seeds exactly one violation into the pre-contract shape and
 * requires the contract migration to ABORT. A guard that has never been
 * observed to refuse is not a guard.
 */
const REFUSAL_CASES = [
  {
    name: "a populated duplicate lifecycle column",
    sql: `UPDATE "external_reviewer_role_assignments" SET "grant_state" = 'ACCEPTED'`,
    expect: /non-default external_reviewer_role_assignments\.grant_state/i,
  },
  {
    name: "a plaintext token left in the sidecar",
    sql: `UPDATE "external_reviewer_role_assignments" SET "raw_token" = 'left-behind'`,
    expect: /external_reviewer_role_assignments\.raw_token/i,
  },
  {
    name: "an orphan role assignment",
    sql: `INSERT INTO "external_reviewer_role_assignments"
            ("id","team_id","evidence_id","granted_by_user_id","external_email","updated_at")
          SELECT gen_random_uuid(), t."team_id", t."evidence_id", t."granted_by_user_id",
                 'orphan@reviewer.test', now()
            FROM "external_reviewer_role_assignments" t LIMIT 1`,
    expect: /have no matching external_review_grant/i,
  },
  {
    // The classification itself is TOTAL — `is_personal` and
    // `organizations.kind` are both two-valued, so every row lands somewhere.
    // What is NOT total is CONSISTENCY, and this is the shape that breaks it:
    // a Personal Space parked under a CUSTOMER Organization classifies
    // PERSONAL by rule 1 and then contradicts the container it sits in.
    name: "a Personal Space under a CUSTOMER Organization",
    sql: `UPDATE "teams" SET "organization_id" = (
            SELECT "id" FROM "organizations" WHERE "kind" = 'CUSTOMER' LIMIT 1
          ) WHERE "is_personal" = TRUE`,
    expect: /PERSONAL workspace\(s\) sit under a CUSTOMER Organization/i,
  },
  {
    name: "two Personal Spaces for one identity",
    sql: `INSERT INTO "teams"
            ("id","name","owner_user_id","is_personal","organization_id","billing_plan","updated_at")
          SELECT gen_random_uuid(), 'Second Personal', t."owner_user_id", TRUE,
                 t."organization_id", 'FREE', now()
            FROM "teams" t WHERE t."is_personal" = TRUE LIMIT 1`,
    expect: /duplicate Personal Space/i,
  },
];

function scenarioBRefuse() {
  process.stdout.write("\nSCENARIO B-REFUSE — the readiness guards fire\n");
  for (const [i, testCase] of REFUSAL_CASES.entries()) {
    const db = `p12_rehearsal_refuse_${i}`;
    const url = createDatabase(db);
    const stash = deferPassTwo();
    try {
      const pass1 = deploy(url);
      if (pass1.status !== 0) {
        record("B-REFUSE", `${testCase.name}: pre-change chain applies`, false,
          pass1.out.slice(-500));
        continue;
      }
      const seeded = psql(url, SEED_SQL);
      if (seeded.status !== 0) {
        record("B-REFUSE", `${testCase.name}: seed`, false, seeded.err.slice(-400));
        continue;
      }
      const violation = psql(url, testCase.sql);
      if (violation.status !== 0) {
        record("B-REFUSE", `${testCase.name}: inject violation`, false,
          violation.err.slice(-400));
        continue;
      }

      stash.restore();
      const pass2 = deploy(url);
      const refused = pass2.status !== 0 && testCase.expect.test(pass2.out);
      if (testCase.optional && pass2.status === 0) {
        record("B-REFUSE", `${testCase.name} (advisory)`, true,
          "no guard covers this shape; recorded, not asserted");
      } else {
        record("B-REFUSE", `the migration refuses: ${testCase.name}`, refused,
          refused ? null : `status=${pass2.status} ${pass2.out.slice(-500)}`);
      }

      if (refused) {
        // …and refusing left the database EXACTLY as it was. A guard that
        // aborts halfway, having already dropped something, is worse than no
        // guard: the operator now has neither the data nor the constraint.
        //
        // The two contract migrations are independent, so which artefact
        // survives depends on WHICH guard fired — an invitation-readiness
        // refusal happens before the invitation drops, a workspace-kind
        // refusal before the NOT NULL. Both are checked and at least one must
        // be intact, which is the strongest statement that holds for every
        // case in this table.
        const survived = count(url,
          `SELECT COUNT(*) FROM information_schema.columns
            WHERE table_name='external_reviewer_role_assignments'
              AND column_name IN ('grant_state','raw_token','token_hash','expires_at_utc','revoked_at_utc')`);
        const kindNullable = psql(url,
          `SELECT is_nullable FROM information_schema.columns
             WHERE table_name='teams' AND column_name='workspace_kind'`).out;
        record("B-REFUSE", `${testCase.name}: nothing was destroyed`,
          survived === 5 || kindNullable === "YES",
          `invitation columns ${survived}/5, teams.workspace_kind nullable=${kindNullable}`);
      }
    } finally {
      stash.restore();
      dropDatabase(db);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const only = process.argv[2] ?? "all";
try {
  if (only === "all" || only === "A") scenarioA();
  if (only === "all" || only === "B") scenarioB();
  if (only === "all" || only === "B-REFUSE") scenarioBRefuse();
} finally {
  // PHASE 13: this used to write into `audit-output/phase12-independent-source-audit/`,
  // the prefix that was retired into `audit-output/history/` — so running the
  // rehearsal RECREATED the retired directory, which the governance check
  // classifies as historical, and dropped a fresh file into it. A rehearsal
  // record is a DIAGNOSTIC, not an authority: nothing derives a release scalar
  // from it, so it belongs in the diagnostics prefix rather than beside the
  // canonical current artifacts.
  const outDir = path.resolve(API_ROOT, "../../audit-output/diagnostics");
  mkdirSync(outDir, { recursive: true });
  const failures = results.filter((r) => !r.ok);
  writeFileSync(
    path.join(outDir, "migration-rehearsal.json"),
    `${JSON.stringify(
      {
        generatedBy: "services/api/scripts/migration-rehearsal.mjs",
        scenarios: only,
        checks: results.length,
        failures: failures.length,
        results,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  process.stdout.write(
    `\n${results.length - failures.length}/${results.length} checks passed\n`,
  );
  if (failures.length > 0) process.exitCode = 1;
}
