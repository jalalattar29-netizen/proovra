/**
 * PHASE 12 CORRECTIVE PASS §5.2 (ARCH-002) — THE WORKSPACE KIND IS STRUCTURAL.
 *
 * The finding was a FALLBACK, not a missing column. `teams.workspace_kind`
 * existed and every production writer already supplied it — but the column was
 * nullable, so the classifier carried:
 *
 *     if (isPersonal === false) {
 *       return billingPlan === "ENTERPRISE" ? "ORGANIZATION" : "OWNED";
 *     }
 *
 * which reads a TENANCY fact off a COMMERCIAL one. An Owned workspace whose
 * account was upgraded to ENTERPRISE silently became an ORGANIZATION workspace
 * to the authorization chain — which then enforced customer-Organization
 * lifecycle against a workspace with no customer Organization — and the same
 * workspace downgraded silently stopped having it enforced. No audit record,
 * no decision by anyone.
 *
 * The database half is proven by the rehearsal (`migration-rehearsal.mjs`):
 * NOT NULL, backfilled from structural authority only, with readiness guards
 * observed to refuse. This file is the CODE half — the two properties the
 * database cannot state:
 *
 *   * the classifier no longer reads a plan;
 *   * every `team.create` names a kind.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { normalizeWorkspaceKind } from "@proovra/shared";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const read = (rel: string): string => readFileSync(path.join(REPO, rel), "utf8");

const CLASSIFIER = "packages/shared/src/workspace-kind.ts";

/**
 * Every module that creates a Workspace row. Pinned as DATA so a new writer is
 * a deliberate addition; the count check below fails if one appears elsewhere.
 */
// BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — `teams.routes.ts` left
// this set. It no longer creates workspaces: self-service creation was removed
// with the commercial allowance that permitted it, because a workspace created
// there could never be paid for. Two writers remain, and the "no writer outside
// the pinned set" test below independently proves the set is complete.
const WORKSPACE_WRITERS = [
  "services/api/src/services/enterprise-provisioning.service.ts",
  "services/api/src/services/platform-context/workspace-bootstrap.service.ts",
] as const;

describe("§5.2 — no workspace kind is derived from a commercial fact", () => {
  it("the classifier no longer reads a plan", () => {
    const src = read(CLASSIFIER);
    const body = /export function normalizeWorkspaceKind\([\s\S]*?\n}/.exec(src);
    expect(body, "normalizeWorkspaceKind must exist").toBeTruthy();
    expect(
      body![0],
      "a plan is a commercial fact and must not decide tenancy",
    ).not.toMatch(/billingPlan/);
    expect(body![0]).not.toMatch(/ENTERPRISE/);
  });

  it("an ENTERPRISE plan does not make a workspace an ORGANIZATION", () => {
    // The exact input that used to return ORGANIZATION.
    expect(
      normalizeWorkspaceKind({
        workspaceKind: null,
        isPersonal: false,
        billingPlan: "ENTERPRISE",
        teamLoaded: true,
      }),
      "an unproven kind must fail closed, never be inferred from the plan",
    ).toBe("UNKNOWN");
  });

  it("a FREE plan does not make a workspace OWNED either", () => {
    expect(
      normalizeWorkspaceKind({
        workspaceKind: null,
        isPersonal: false,
        billingPlan: "FREE",
        teamLoaded: true,
      }),
    ).toBe("UNKNOWN");
  });

  it("the personal-space invariant IS still authority — it is structural, not commercial", () => {
    // Kept deliberately. `is_personal` says how the row came to exist; the
    // contract migration makes it equivalent to the PERSONAL kind by CHECK
    // constraint, and dropping it would lock users out of their own Personal
    // Space during a rolling deploy for no gain.
    for (const plan of ["FREE", "PRO", "TEAM", "ENTERPRISE"]) {
      expect(
        normalizeWorkspaceKind({
          workspaceKind: null,
          isPersonal: true,
          billingPlan: plan,
          teamLoaded: true,
        }),
        "…and the answer does not depend on the plan",
      ).toBe("PERSONAL");
    }
  });

  it("an explicit persisted kind is honoured, and only an explicit one", () => {
    for (const kind of ["PERSONAL", "OWNED", "ORGANIZATION"] as const) {
      expect(
        normalizeWorkspaceKind({
          workspaceKind: kind,
          isPersonal: kind === "PERSONAL",
          billingPlan: "ENTERPRISE",
          teamLoaded: true,
        }),
      ).toBe(kind);
    }
    expect(
      normalizeWorkspaceKind({
        workspaceKind: "TEAM",
        isPersonal: false,
        billingPlan: "TEAM",
        teamLoaded: true,
      }),
      "TEAM is a PLAN. It is not, and has never been, a workspace kind.",
    ).toBe("UNKNOWN");
  });

  it("an unloaded team row still fails closed", () => {
    expect(
      normalizeWorkspaceKind({
        workspaceKind: "ORGANIZATION",
        isPersonal: false,
        billingPlan: "ENTERPRISE",
        teamLoaded: false,
      }),
    ).toBe("UNKNOWN");
  });

  it("the schema makes the kind mandatory", () => {
    const schema = read("services/api/prisma/schema.prisma");
    const model = /model Team \{[\s\S]*?\n\}/.exec(schema)![0];
    const line = model
      .split("\n")
      .find((l) => /^\s*workspaceKind\s/.test(l));
    expect(line, "Team.workspaceKind must exist").toBeTruthy();
    expect(
      line,
      "a nullable kind is what forced the fallback that produced this finding",
    ).not.toMatch(/WorkspaceKind\?/);
  });

  it("every workspace writer states the kind explicitly", () => {
    const found: string[] = [];
    const missing: string[] = [];
    for (const file of WORKSPACE_WRITERS) {
      const src = read(file);
      for (const m of src.matchAll(
        /(?:tx|prisma|client|db)\.team\.create\(\{[\s\S]{0,900}?\n\s{4,}\}\)/g,
      )) {
        found.push(`${file}@${m.index}`);
        if (!/workspaceKind:\s*"(PERSONAL|OWNED|ORGANIZATION)"/.test(m[0])) {
          missing.push(`${file}: a team.create without an explicit kind`);
        }
      }
    }
    // Positive control: if the parser stops finding writers, this test would
    // pass vacuously.
    expect(
      found.length,
      "the writer scan must still find creation sites",
    ).toBeGreaterThanOrEqual(WORKSPACE_WRITERS.length);
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("no workspace writer exists outside the pinned set", () => {
    // A new creation path elsewhere would escape the check above entirely.
    const roots = [
      "services/api/src",
      "services/worker/src",
      "packages/shared-runtime/src",
    ];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(path.join(REPO, dir), {
        withFileTypes: true,
      })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(rel);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const src = read(rel);
        if (!/\.team\.create\(/.test(src)) continue;
        if ((WORKSPACE_WRITERS as ReadonlyArray<string>).includes(rel)) continue;
        offenders.push(rel);
      }
    };
    for (const r of roots) walk(r);
    expect(
      offenders,
      `a workspace creation path outside the pinned writer set:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the backfill classifies from structure, never from a plan", () => {
    const sql = read(
      "services/api/prisma/migrations/20271124000000_workspace_kind_authority_backfill/migration.sql",
    );
    const statements = sql.replace(/^--.*$/gm, "");
    expect(
      statements,
      "the backfill must not read a commercial column",
    ).not.toMatch(/billing_plan|billing_status|subscription/i);
    // It must read the two structural authorities.
    expect(statements).toMatch(/is_personal/);
    expect(statements).toMatch(/o\."kind" = 'CUSTOMER'/);
    expect(statements).toMatch(/o\."kind" = 'SYSTEM'/);
  });
});
