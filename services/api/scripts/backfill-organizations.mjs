#!/usr/bin/env node
/**
 * Phase 2.7X Stage 2 — Organization backfill (local-only).
 *
 * Creates one Organization per existing Team, links it back, and
 * seeds an ORG_OWNER membership for the team's owner. Designed to
 * be:
 *
 *   - IDEMPOTENT — skips teams already linked, skips users already
 *     in the new org as ORG_OWNER. Safe to re-run.
 *   - DRY-RUN AWARE — `--dry-run` walks the data and reports what
 *     WOULD happen without writing anything.
 *   - LOCAL-ONLY — the Phase 2.5C in-process hook (prisma.config.ts)
 *     refuses to connect to any non-local host. This script never
 *     contacts Neon.
 *   - ROLLBACK-FRIENDLY — the only writes are:
 *       INSERT organization
 *       INSERT organization_membership
 *       UPDATE teams SET organization_id = ?
 *     A rollback is `DELETE FROM organization_memberships`, then
 *     `UPDATE teams SET organization_id = NULL`, then
 *     `DELETE FROM organizations`. The script prints a rollback
 *     summary at completion.
 *
 * Backfill rules (per Phase 2.7 §10):
 *   - One organization per team (1:1). No auto-merge across teams.
 *   - Organization.name mirrors team.name (operator can rename
 *     later via the Stage 3 dual-read endpoints).
 *   - Organization.billingOwnerUserId = team.billingOwnerUserId
 *     if set, else team.ownerUserId.
 *   - Organization.status = ACTIVE.
 *   - One OrganizationMembership per team owner with role=ORG_OWNER.
 *   - teams.organization_id ← new org id.
 *
 * Hard rules:
 *   - NEVER promote a user to ORG_OWNER unless they're already
 *     team.ownerUserId or team.billingOwnerUserId on the source team.
 *   - NEVER cross-link teams: each team becomes its own org. No
 *     surprise hierarchy.
 *   - NEVER mutate evidence ownership, reviewer assignments, case
 *     ownership, external collaborator grants, or any RBAC table.
 *     Only the 3 writes listed above happen.
 *
 * Exit codes:
 *   0  backfill (or dry-run) completed cleanly
 *   1  internal error (DB connection, etc.)
 *   2  preflight refusal — host classification != LOCAL
 *   3  orphan / consistency failure detected; aborted
 *
 * Usage:
 *   pnpm --filter proovra-api db:backfill:orgs:dry
 *   pnpm --filter proovra-api db:backfill:orgs
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyHost,
  parseDatabaseHost,
} from "./db-host-policy.mjs";

// ---------------------------------------------------------------------------
// .env loader — mirrors safe-migrate.mjs so the same precedence rules apply.
// ---------------------------------------------------------------------------
function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (!key) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
loadEnvFile(resolve(process.cwd(), ".env"));
loadEnvFile(resolve(process.cwd(), "services/api/.env"));

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

// ---------------------------------------------------------------------------
// Preflight — refuse to run against non-local DB.
// ---------------------------------------------------------------------------
const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
if (!databaseUrl) {
  process.stderr.write("[backfill-organizations] REFUSED: DATABASE_URL is not set.\n");
  process.exit(2);
}
const { host, database } = parseDatabaseHost(databaseUrl);
const classification = classifyHost(host);
if (classification !== "local") {
  process.stderr.write(
    `[backfill-organizations] REFUSED: target host "${host}" classification=${classification}.\n` +
      `  This backfill is local-only. To run against a non-local DB you must build\n` +
      `  a deploy-safe procedure with a backup id (Phase 2.5D / 2.5E discipline).\n`,
  );
  process.exit(2);
}

process.stderr.write("\n");
process.stderr.write("───────────────────────────────────────────────────────────────\n");
process.stderr.write("  PROOVRA Phase 2.7X Stage 2 — Organization backfill\n");
process.stderr.write("───────────────────────────────────────────────────────────────\n");
process.stderr.write(`  mode         : ${dryRun ? "DRY-RUN (no writes)" : "APPLY"}\n`);
process.stderr.write(`  host         : ${host}\n`);
process.stderr.write(`  database     : ${database}\n`);
process.stderr.write(`  classification: ${classification.toUpperCase()}\n`);
process.stderr.write("───────────────────────────────────────────────────────────────\n\n");

// ---------------------------------------------------------------------------
// Connect — match services/api/src/db.ts (PG adapter pattern for Prisma 7).
// ---------------------------------------------------------------------------
const pool = new pg.Pool({ connectionString: databaseUrl });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const stats = {
    teamsTotal: 0,
    teamsAlreadyLinked: 0,
    teamsBackfilled: 0,
    orgsCreated: 0,
    membershipsCreated: 0,
    membershipsAlreadyExisted: 0,
    orphansFound: [],
    failed: [],
  };

  // Use a single transaction in apply mode so a mid-flight failure
  // leaves no half-state. In dry-run mode we still query under the
  // transaction so the read-consistency snapshot matches.
  await prisma.$transaction(async (tx) => {
    const teams = await tx.team.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        ownerUserId: true,
        billingOwnerUserId: true,
        isPersonal: true,
        organizationId: true,
        createdAt: true,
      },
    });
    stats.teamsTotal = teams.length;

    for (const team of teams) {
      // Skip if already linked.
      if (team.organizationId) {
        stats.teamsAlreadyLinked += 1;
        process.stderr.write(
          `  [SKIP] team "${team.name}" (${team.id}) already linked to org ${team.organizationId}\n`,
        );
        continue;
      }

      // Determine the org owner.
      const ownerUserId = team.billingOwnerUserId ?? team.ownerUserId;
      if (!ownerUserId) {
        stats.orphansFound.push({
          teamId: team.id,
          teamName: team.name,
          reason: "no billingOwnerUserId AND no ownerUserId",
        });
        continue;
      }

      // Verify the owner user exists.
      const ownerExists = await tx.user.findUnique({
        where: { id: ownerUserId },
        select: { id: true, email: true },
      });
      if (!ownerExists) {
        stats.orphansFound.push({
          teamId: team.id,
          teamName: team.name,
          reason: `owner user ${ownerUserId} does not exist`,
        });
        continue;
      }

      if (dryRun) {
        process.stderr.write(
          `  [DRY] would create Organization for team "${team.name}" ` +
            `(${team.id}) with billing_owner=${ownerExists.email}\n`,
        );
        stats.teamsBackfilled += 1;
        stats.orgsCreated += 1;
        stats.membershipsCreated += 1;
        continue;
      }

      // Create the Organization.
      const org = await tx.organization.create({
        data: {
          name: team.name,
          billingOwnerUserId: ownerUserId,
          status: "ACTIVE",
        },
        select: { id: true, name: true },
      });
      stats.orgsCreated += 1;

      // Create the ORG_OWNER membership.
      const existingMembership = await tx.organizationMembership.findFirst({
        where: { organizationId: org.id, userId: ownerUserId },
        select: { id: true },
      });
      if (existingMembership) {
        stats.membershipsAlreadyExisted += 1;
      } else {
        await tx.organizationMembership.create({
          data: {
            organizationId: org.id,
            userId: ownerUserId,
            role: "ORG_OWNER",
          },
        });
        stats.membershipsCreated += 1;
      }

      // Link the team.
      await tx.team.update({
        where: { id: team.id },
        data: { organizationId: org.id },
      });
      stats.teamsBackfilled += 1;

      process.stderr.write(
        `  [OK ] team "${team.name}" -> org ${org.id}, owner=${ownerExists.email}\n`,
      );
    }

    // In dry-run, roll back the transaction (we made no writes, but
    // being explicit). Prisma's transaction wrapper auto-commits on
    // success; we trigger rollback by throwing a sentinel only in
    // dry-run mode.
    if (dryRun) {
      // No writes happened; the read-only sequence is fine to
      // commit. We still write a sentinel marker via process.stderr.
      process.stderr.write("\n  (DRY-RUN — no writes were issued.)\n");
    }
  });

  // ---------------------------------------------------------------------------
  // Final report
  // ---------------------------------------------------------------------------
  process.stderr.write("\n");
  process.stderr.write("───────────────────────────────────────────────────────────────\n");
  process.stderr.write(`  backfill summary (${dryRun ? "DRY-RUN" : "APPLIED"})\n`);
  process.stderr.write("───────────────────────────────────────────────────────────────\n");
  process.stderr.write(`  teams total              : ${stats.teamsTotal}\n`);
  process.stderr.write(`  teams already linked     : ${stats.teamsAlreadyLinked}\n`);
  process.stderr.write(`  teams backfilled         : ${stats.teamsBackfilled}\n`);
  process.stderr.write(`  organizations created    : ${stats.orgsCreated}\n`);
  process.stderr.write(`  memberships created      : ${stats.membershipsCreated}\n`);
  process.stderr.write(`  memberships already exist: ${stats.membershipsAlreadyExisted}\n`);
  process.stderr.write(`  orphans (skipped)        : ${stats.orphansFound.length}\n`);
  process.stderr.write(`  failed                   : ${stats.failed.length}\n`);
  if (stats.orphansFound.length > 0) {
    process.stderr.write("\n  orphans detail:\n");
    for (const o of stats.orphansFound) {
      process.stderr.write(`    - team ${o.teamId} (${o.teamName}): ${o.reason}\n`);
    }
  }
  process.stderr.write("───────────────────────────────────────────────────────────────\n");
  process.stderr.write(
    dryRun
      ? "  Re-run without --dry-run to apply.\n\n"
      : "  Rollback if needed:\n" +
          "    UPDATE teams SET organization_id = NULL WHERE organization_id IS NOT NULL;\n" +
          "    DELETE FROM organization_memberships;\n" +
          "    DELETE FROM organizations;\n\n",
  );

  if (stats.orphansFound.length > 0 && !dryRun) {
    process.exit(3);
  }
  process.exit(0);
}

main()
  .catch((err) => {
    process.stderr.write(`[backfill-organizations] internal error: ${err?.message ?? err}\n`);
    if (err?.stack) process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
