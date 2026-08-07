/**
 * PHASE 12 CORRECTIVE PASS §2 — ARCH-004, THE STRUCTURAL GATE.
 *
 * The runtime probe proves the lifecycle behaves. It cannot prove that a
 * FUTURE module will not write `status` directly, bypassing the orchestrator
 * and its audit, its fence and its timestamp discipline — nor that a new query
 * will forget the ACTIVE filter and hand a suspended member their authority
 * back.
 *
 * This is that half: it parses the sources and fails on the shapes that
 * produced the finding.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = path.resolve(HERE, "..");
const SRC = path.join(API, "src");
const read = (abs: string): string => readFileSync(abs, "utf8");

const ORCHESTRATOR =
  "src/services/identity/org-membership-lifecycle.service.ts";

/**
 * Modules permitted to WRITE `organizationMembership.status`.
 *
 * Exactly one: the orchestrator. Every other transition composes it.
 */
const PERMITTED_STATUS_WRITERS = new Set([ORCHESTRATOR]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (entry.name.endsWith(".ts")) out.push(abs);
  }
  return out;
}

const SOURCES = walk(SRC).map((abs) => ({
  rel: path.relative(API, abs).split(path.sep).join("/"),
  text: read(abs),
}));

describe("§2 — ARCH-004: one lifecycle authority, and ACTIVE is the only grant", () => {
  it("the orchestrator exists and owns the three transitions", () => {
    const src = read(path.join(API, ORCHESTRATOR));
    for (const fn of [
      "suspendOrganizationMembership",
      "revokeOrganizationMembership",
      "restoreOrganizationMembership",
      "organizationMembershipGrantsAccess",
    ]) {
      expect(src, `${fn} must be exported`).toMatch(
        new RegExp(`export (async )?function ${fn}\\b`),
      );
    }
  });

  it("every transition is FENCED by the generation, not last-writer-wins", () => {
    const src = read(path.join(API, ORCHESTRATOR));
    const update = /UPDATE "organization_memberships"[\s\S]*?RETURNING/.exec(src);
    expect(update, "the guarded UPDATE must exist").toBeTruthy();
    // It increments the generation…
    expect(update![0]).toMatch(/"status_generation" = "status_generation" \+ 1/);
    // …and refuses to move a row whose generation has already changed.
    expect(
      update![0],
      "without this predicate two concurrent transitions would both win",
    ).toMatch(/AND "status_generation" = \$8/);
    // …and is scoped to the Organization, so a membership id from another
    // tenant cannot be moved by id alone.
    expect(update![0]).toMatch(/AND "organization_id" = \$7::uuid/);
  });

  it("no module outside the orchestrator writes the membership status", () => {
    const offenders: string[] = [];
    for (const { rel, text } of SOURCES) {
      if (PERMITTED_STATUS_WRITERS.has(rel)) continue;
      // A Prisma write on this delegate that names `status` in its data.
      for (const m of text.matchAll(
        /organizationMembership\.(update|updateMany|upsert|create|createMany)\(\{[\s\S]{0,700}?\n\s{0,10}\}\)/g,
      )) {
        if (/\bstatus\s*:/.test(m[0])) {
          offenders.push(`${rel}: writes organizationMembership.status directly`);
        }
      }
      // Raw SQL that sets it.
      if (
        /UPDATE\s+"organization_memberships"[\s\S]{0,200}?SET[\s\S]{0,200}?"status"/i.test(
          text,
        )
      ) {
        offenders.push(`${rel}: raw UPDATE of organization_memberships.status`);
      }
    }
    expect(
      offenders,
      `governance-membership transitions have ONE orchestrator:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("ordinary revocation is no longer a physical delete", () => {
    const provisioning = read(
      path.join(API, "src/services/identity/membership-provisioning.service.ts"),
    );
    const body =
      /export async function removeOrganizationMembership\([\s\S]*?\n}/.exec(
        provisioning,
      );
    expect(body, "removeOrganizationMembership must exist").toBeTruthy();
    expect(
      body![0],
      "the row must survive so the removal is attributable",
    ).not.toMatch(/organizationMembership\.delete\(/);
    expect(body![0]).toMatch(/revokeOrganizationMembership\(/);
  });

  it("physical deletion survives ONLY for account closure/erasure", () => {
    const deleters: string[] = [];
    for (const { rel, text } of SOURCES) {
      for (const m of text.matchAll(
        /organizationMembership\.(delete|deleteMany)\(/g,
      )) {
        void m;
        deleters.push(rel);
      }
    }
    const unique = [...new Set(deleters)].sort();
    // Account closure is a legal erasure obligation and is a different thing
    // from an administrator removing somebody.
    expect(unique).toEqual([
      "src/services/identity/membership-provisioning.service.ts",
    ]);
    const provisioning = read(
      path.join(API, "src/services/identity/membership-provisioning.service.ts"),
    );
    const deleteBlock =
      /export async function removeAllOrganizationMembershipsForUser\([\s\S]*?\n}/.exec(
        provisioning,
      );
    expect(
      deleteBlock,
      "the only remaining deleter must be the account-closure sweep",
    ).toBeTruthy();
    expect(deleteBlock![0]).toMatch(/organizationMembership\.deleteMany\(/);
  });

  it("the access gate reads the status, not merely the row's existence", () => {
    const gate = read(path.join(API, "src/services/organization/org-access.ts"));
    expect(gate).toMatch(/organizationMembershipGrantsAccess/);
    const lookup =
      /const membership = await prisma\.organizationMembership\.findFirst\(\{[\s\S]*?\}\);/.exec(
        gate,
      );
    expect(lookup, "the membership lookup must exist").toBeTruthy();
    expect(
      lookup![0],
      "grant EXISTENCE mistaken for grant VALIDITY is the NEW-005 shape",
    ).toMatch(/status:\s*true/);
  });

  it("the switcher and the caller's own lists are ACTIVE-only", () => {
    const resolver = read(
      path.join(API, "src/services/organization/organization-resolver.service.ts"),
    );
    const listing =
      /export async function listOrgMembershipsForUser\([\s\S]*?\n}/.exec(
        resolver,
      );
    expect(listing).toBeTruthy();
    expect(
      listing![0],
      "an Organization that will refuse on arrival must not be offered",
    ).toMatch(/status:\s*"ACTIVE"/);
  });

  it("the schema declares the lifecycle and the database enforces it", () => {
    const schema = read(path.join(API, "prisma/schema.prisma"));
    expect(schema).toMatch(
      /enum OrganizationMembershipStatus \{\s*ACTIVE\s*SUSPENDED\s*REVOKED\s*\}/,
    );
    const model = /model OrganizationMembership \{[\s\S]*?\n\}/.exec(schema)![0];
    for (const field of [
      "status",
      "statusChangedAtUtc",
      "suspendedAtUtc",
      "suspendedByUserId",
      "revokedAtUtc",
      "revokedByUserId",
      "statusSource",
      "statusGeneration",
    ]) {
      expect(model, `${field} must be declared`).toMatch(
        new RegExp(`^\\s*${field}\\s`, "m"),
      );
    }
    // PENDING would be a second authority for what organization_invites owns.
    // Scoped to the enum BLOCK — an unscoped scan reaches a `PENDING` in an
    // unrelated enum further down the schema and fails for the wrong reason.
    const statusEnum = /enum OrganizationMembershipStatus \{[^}]*\}/.exec(
      schema,
    );
    expect(statusEnum).toBeTruthy();
    expect(
      statusEnum![0],
      "an unaccepted invitation is organization_invites' business",
    ).not.toMatch(/\bPENDING\b/);
  });

  it("the contract migration guards every constraint it adds", () => {
    const sql = read(
      path.join(
        API,
        "prisma/migrations/20271128000000_org_membership_lifecycle_contract/migration.sql",
      ),
    );
    const firstConstraint = sql.search(/ALTER TABLE[\s\S]{0,120}?(SET NOT NULL|ADD CONSTRAINT)/);
    const lastGuard = sql.lastIndexOf("RAISE EXCEPTION");
    expect(firstConstraint).toBeGreaterThan(0);
    expect(
      lastGuard,
      "every readiness check must precede the constraint it authorises",
    ).toBeLessThan(firstConstraint);
    for (const category of [
      "have no status",
      "timestamps contradict",
      "both suspended and revoked",
      "duplicate ACTIVE",
    ]) {
      expect(sql, `readiness must cover: ${category}`).toContain(category);
    }
  });

  it("the backfill invents no suspension, revocation or actor", () => {
    const sql = read(
      path.join(
        API,
        "prisma/migrations/20271127000000_org_membership_lifecycle_backfill/migration.sql",
      ),
    );
    const statements = sql.replace(/^--.*$/gm, "");
    // Historically-deleted memberships cannot be reconstructed, and this
    // migration must not pretend otherwise.
    expect(statements).not.toMatch(/SET[\s\S]{0,80}"status"\s*=\s*'REVOKED'/i);
    expect(statements).not.toMatch(/SET[\s\S]{0,80}"status"\s*=\s*'SUSPENDED'/i);
    expect(statements).not.toMatch(/"suspended_by_user_id"\s*=/);
    expect(statements).not.toMatch(/"revoked_by_user_id"\s*=/);
    expect(statements).not.toMatch(/DELETE\s+FROM/i);
  });
});
