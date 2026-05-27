#!/usr/bin/env node
/**
 * Phase 2.7X Stage 5 — Org/workspace consistency validator.
 *
 * Read-only diagnostic. Refuses to write. Surfaces structural
 * inconsistencies between the Phase 2.7X Organization domain and
 * the pre-existing Team / Workspace world.
 *
 * Checks (each is a pure SELECT — never mutates):
 *
 *   1. Teams with `organization_id` NULL — un-backfilled
 *      workspaces. Stage 5 acceptable but Stage 6 will tighten
 *      the column to NOT NULL.
 *
 *   2. Teams pointing at a non-existent organization id. SHOULD
 *      be impossible (FK constraint) but verified for completeness.
 *
 *   3. Organizations with zero `ORG_OWNER` memberships. Violates
 *      the Stage 4 invariant that every org has at least one
 *      ORG_OWNER.
 *
 *   4. Organizations whose `billing_owner_user_id` references a
 *      user that is NOT a member of the org. Indicates broken
 *      backfill or future drift.
 *
 *   5. Organization memberships referencing a non-existent user.
 *      SHOULD be impossible (FK cascade) but checked.
 *
 *   6. Pending org invites that have already expired in DB time.
 *      Cosmetic — the accept endpoint already rejects these — but
 *      surfaces unwanted "stale pending invites" to the operator.
 *
 *   7. Duplicate ORG_OWNER memberships for the same (org, user).
 *      The schema's `@@unique([organizationId, userId])` makes
 *      this impossible but we verify defensively.
 *
 *   8. Teams that share the same `organization_id` while
 *      `is_personal=true` for more than one row in the same org.
 *      Phase 2.7 backfill creates a 1:1 personal-team ↔ org
 *      mapping; this would indicate the backfill was run twice
 *      against the same dataset OR an operator manually linked
 *      multiple personal teams to one org.
 *
 * Output:
 *   - Human-readable per-check status: PASS / WARN / FAIL.
 *   - Aggregated exit code:
 *       0  all checks PASS
 *       1  internal error (DB connection, etc.)
 *       2  classification refusal (host != LOCAL)
 *       7  at least one WARN (no FAIL)
 *       8  at least one FAIL
 *
 * Usage:
 *   pnpm --filter proovra-api db:check-org-consistency
 *
 * The script intentionally NEVER repairs. Operators read the
 * report and decide whether to re-run the Stage 2 idempotent
 * backfill, file a manual SQL fix-up, or escalate.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import {
  classifyHost,
  parseDatabaseHost,
} from "./db-host-policy.mjs";

// .env loader (mirrors safe-migrate.mjs).
function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvFile(resolve(process.cwd(), ".env"));
loadEnvFile(resolve(process.cwd(), "services/api/.env"));

// Phase 2.7X Stage 6 — honor the deploy chain's skip signal.
// The Phase 2.5F drift-check uses PRELIGHT_SKIP_DRIFT=1 to bypass
// real DB connection in CI / dry-run-with-fake-URL contexts. We
// honor the same variable here so deploy:safe:dry remains
// uniformly skippable in the same flow.
if (process.env.PRELIGHT_SKIP_DRIFT === "1") {
  process.stderr.write(
    "\n[check-org-consistency] SKIPPED — PRELIGHT_SKIP_DRIFT=1.\n" +
      "  Real consistency checks run in the post-deploy chain.\n\n",
  );
  process.exit(0);
}

const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
if (!databaseUrl) {
  process.stderr.write("[check-org-consistency] DATABASE_URL not set.\n");
  process.exit(1);
}
const { host, database } = parseDatabaseHost(databaseUrl);
const classification = classifyHost(host);

process.stderr.write("\n");
process.stderr.write("───────────────────────────────────────────────────────────────\n");
process.stderr.write("  PROOVRA Phase 2.7X Stage 5 — org consistency validator\n");
process.stderr.write("───────────────────────────────────────────────────────────────\n");
process.stderr.write(`  host         : ${host}\n`);
process.stderr.write(`  database     : ${database}\n`);
process.stderr.write(`  classification: ${classification.toUpperCase()}\n`);
process.stderr.write("───────────────────────────────────────────────────────────────\n");

if (classification !== "local") {
  process.stderr.write(
    "\n[check-org-consistency] REFUSED: this validator is local-only.\n" +
      "  Production-side consistency runs through deploy-safe + a\n" +
      "  separate observability pipeline (Stage 6).\n\n",
  );
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: databaseUrl });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const results = [];
const record = (id, status, detail, metadata = {}) =>
  results.push({ id, status, detail, metadata });

try {
  // ---- Check 1: teams with NULL organization_id -------------------------
  //
  // Phase 2.7X Stage 6 — teams.organization_id is now NOT NULL at the
  // schema level. The previous WHERE organizationId: null query is no
  // longer expressible via Prisma (the type system rejects it). We
  // verify the invariant via a raw count from pg_attribute, which
  // proves the column is NOT NULL at the database level. If the
  // schema and DB diverge (drift), this check surfaces it.
  {
    const nullableRow = await prisma.$queryRawUnsafe(
      `SELECT is_nullable
         FROM information_schema.columns
         WHERE table_name='teams' AND column_name='organization_id'`,
    );
    const isNullable = nullableRow[0]?.is_nullable === "YES";
    if (!isNullable) {
      record(
        "1-teams-organization-id-not-null",
        "PASS",
        "teams.organization_id is NOT NULL at the database level (Stage 6 tightening applied).",
        { isNullable },
      );
    } else {
      record(
        "1-teams-organization-id-not-null",
        "FAIL",
        "teams.organization_id is NULLABLE at the database level but Stage 6 schema declares NOT NULL. Drift detected.",
        { isNullable },
      );
    }
  }

  // ---- Check 2: teams pointing at a non-existent org id ----------------
  {
    const dangling = await prisma.$queryRawUnsafe(
      `SELECT t.id AS team_id, t.organization_id AS missing_org_id
         FROM teams t
         LEFT JOIN organizations o ON o.id = t.organization_id
         WHERE t.organization_id IS NOT NULL
           AND o.id IS NULL
         LIMIT 50`,
    );
    if (dangling.length === 0) {
      record(
        "2-team-org-fk-integrity",
        "PASS",
        "Every team.organization_id resolves to an existing organization.",
      );
    } else {
      record(
        "2-team-org-fk-integrity",
        "FAIL",
        `${dangling.length} teams reference a non-existent organization (FK integrity broken).`,
        { sample: dangling.slice(0, 5) },
      );
    }
  }

  // ---- Check 3: orgs with zero ORG_OWNER memberships -------------------
  {
    const ownerless = await prisma.$queryRawUnsafe(
      `SELECT o.id AS organization_id, o.name
         FROM organizations o
         LEFT JOIN organization_memberships m
           ON m.organization_id = o.id AND m.role = 'ORG_OWNER'
         WHERE m.id IS NULL
         LIMIT 50`,
    );
    if (ownerless.length === 0) {
      record(
        "3-orgs-have-owner",
        "PASS",
        "Every organization has at least one ORG_OWNER membership.",
      );
    } else {
      record(
        "3-orgs-have-owner",
        "FAIL",
        `${ownerless.length} organizations have NO ORG_OWNER membership. Stage 4 invariant violated.`,
        { sample: ownerless.slice(0, 5) },
      );
    }
  }

  // ---- Check 4: billing_owner not a member of the org ------------------
  {
    const mismatched = await prisma.$queryRawUnsafe(
      `SELECT o.id AS organization_id, o.billing_owner_user_id
         FROM organizations o
         LEFT JOIN organization_memberships m
           ON m.organization_id = o.id
          AND m.user_id = o.billing_owner_user_id
         WHERE o.billing_owner_user_id IS NOT NULL
           AND m.id IS NULL
         LIMIT 50`,
    );
    if (mismatched.length === 0) {
      record(
        "4-billing-owner-membership",
        "PASS",
        "Every billing_owner_user_id is also a member of the organization.",
      );
    } else {
      record(
        "4-billing-owner-membership",
        "WARN",
        `${mismatched.length} organizations have billing_owner_user_id pointing at a non-member.`,
        { sample: mismatched.slice(0, 5) },
      );
    }
  }

  // ---- Check 5: memberships referencing a non-existent user ------------
  {
    const dangling = await prisma.$queryRawUnsafe(
      `SELECT m.id AS membership_id, m.user_id
         FROM organization_memberships m
         LEFT JOIN users u ON u.id = m.user_id
         WHERE u.id IS NULL
         LIMIT 50`,
    );
    if (dangling.length === 0) {
      record(
        "5-membership-user-fk-integrity",
        "PASS",
        "Every membership.user_id resolves to an existing user.",
      );
    } else {
      record(
        "5-membership-user-fk-integrity",
        "FAIL",
        `${dangling.length} memberships reference a non-existent user.`,
        { sample: dangling.slice(0, 5) },
      );
    }
  }

  // ---- Check 6: stale pending invites ----------------------------------
  {
    const now = new Date();
    const stale = await prisma.organizationInvite.count({
      where: {
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { lte: now },
      },
    });
    if (stale === 0) {
      record(
        "6-stale-pending-invites",
        "PASS",
        "No expired-but-unmarked pending invites.",
      );
    } else {
      record(
        "6-stale-pending-invites",
        "WARN",
        `${stale} expired invites are still "pending" by query shape. They cannot be accepted (the accept route rejects them), but they clutter the pending-invites listing.`,
        { count: stale },
      );
    }
  }

  // ---- Check 7: duplicate memberships (defensive) ----------------------
  {
    const dups = await prisma.$queryRawUnsafe(
      `SELECT organization_id, user_id, COUNT(*) AS cnt
         FROM organization_memberships
         GROUP BY organization_id, user_id
         HAVING COUNT(*) > 1
         LIMIT 50`,
    );
    if (dups.length === 0) {
      record(
        "7-no-duplicate-memberships",
        "PASS",
        "No (org_id, user_id) pairs appear in more than one membership row.",
      );
    } else {
      record(
        "7-no-duplicate-memberships",
        "FAIL",
        `${dups.length} (org_id, user_id) pairs have duplicate memberships. UNIQUE constraint violation.`,
        { sample: dups.slice(0, 5) },
      );
    }
  }

  // ---- Check 8: multiple personal teams in one org ---------------------
  {
    const overshare = await prisma.$queryRawUnsafe(
      `SELECT organization_id, COUNT(*) AS personal_count
         FROM teams
         WHERE is_personal = true AND organization_id IS NOT NULL
         GROUP BY organization_id
         HAVING COUNT(*) > 1
         LIMIT 50`,
    );
    if (overshare.length === 0) {
      record(
        "8-personal-team-per-org-uniqueness",
        "PASS",
        "Every org has at most one personal team linked (Stage 2 backfill invariant).",
      );
    } else {
      record(
        "8-personal-team-per-org-uniqueness",
        "WARN",
        `${overshare.length} organizations have more than one personal team linked. This is structurally unusual; investigate before Stage 6 cutover.`,
        { sample: overshare.slice(0, 5) },
      );
    }
  }
} catch (err) {
  process.stderr.write(`[check-org-consistency] internal error: ${err?.message ?? err}\n`);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
} finally {
  // Render results.
  const pass = results.filter((r) => r.status === "PASS").length;
  const warn = results.filter((r) => r.status === "WARN").length;
  const fail = results.filter((r) => r.status === "FAIL").length;

  process.stderr.write("\n");
  for (const r of results) {
    const icon = r.status === "PASS" ? "✓" : r.status === "WARN" ? "⚠" : "✗";
    process.stderr.write(
      `  [${r.status.padEnd(4, " ")}] ${icon}  ${r.id}\n         ${r.detail}\n`,
    );
  }
  process.stderr.write("───────────────────────────────────────────────────────────────\n");
  process.stderr.write(`  Result: ${fail} fail / ${warn} warn / ${pass} pass\n`);
  process.stderr.write("───────────────────────────────────────────────────────────────\n\n");

  await prisma.$disconnect().catch(() => {});

  if (fail > 0) process.exit(8);
  if (warn > 0) process.exit(7);
  process.exit(0);
}
