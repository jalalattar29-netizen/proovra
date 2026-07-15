/**
 * intake_link_expiring classification contract (2026-07-15).
 *
 * An expiring intake link is an INTAKE operational deadline, NOT a
 * governance (retention/legal-hold/destruction) event. This pins the
 * canonical filter→category map + the source scoping.
 *
 * NOTE: `FILTER_CATEGORY_MEMBERS` + `matchesFilter` live in
 * me-inbox.routes.ts, which imports the DB-coupled `db.js` (throws at
 * import when DATABASE_URL is unset). The runtime *visibility* behavior
 * is therefore proven by the frontend policy tests
 * (apps/web/__tests__/opscenter-ux-adaptation.test.ts, which import the
 * pure exported filter policy); here we assert the backend canonical
 * mapping + query scoping against the real source.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  resolve(HERE, "../src/routes/me-inbox.routes.ts"),
  "utf8",
);

// Scope parsing to the FILTER_CATEGORY_MEMBERS object literal only.
const MAP_BLOCK = SRC.slice(
  SRC.indexOf("const FILTER_CATEGORY_MEMBERS"),
  SRC.indexOf("function matchesFilter"),
);

/** Extract the category-string members of one filter key's array. */
function members(key: string): string[] {
  const m = MAP_BLOCK.match(new RegExp(`\\b${key}:\\s*\\[([\\s\\S]*?)\\]`));
  if (!m) throw new Error(`FILTER_CATEGORY_MEMBERS.${key} not found`);
  return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
}

describe("intake_link_expiring filter classification", () => {
  it("is NOT a member of the Governance filter", () => {
    const gov = members("governance");
    expect(gov).not.toContain("intake_link_expiring");
  });

  it("keeps Governance as exactly retention/hold + access-review sources", () => {
    // Governance stays: governance (retention/legal-hold/destruction) +
    // access_review_pending. No intake reclassification bled in.
    expect(members("governance")).toEqual(["governance", "access_review_pending"]);
  });

  it("remains a member of the Intake filter (core category)", () => {
    expect(members("intake")).toContain("intake_link_expiring");
  });

  it("remains a member of the Admin filter (resolution requires ADMIN)", () => {
    // revoke/extend/regenerate are requireAdmin in
    // workflow-intake-links.routes.ts, so the admin action queue keeps it.
    expect(members("admin")).toContain("intake_link_expiring");
  });

  it("is NOT a member of Integrity, Reviews, Collaboration, or Failures", () => {
    for (const key of ["integrity", "review", "collaboration", "failures"]) {
      expect(members(key)).not.toContain("intake_link_expiring");
    }
  });
});

describe("existing category classifications unchanged", () => {
  it("Intake keeps its three members", () => {
    expect(members("intake").sort()).toEqual(
      [
        "intake_link_expiring",
        "intake_required_items_missing",
        "intake_submission_pending_review",
      ].sort(),
    );
  });
  it("Integrity remains TSA/OTS only", () => {
    expect(members("integrity").sort()).toEqual(["ots_failure", "tsa_failure"].sort());
  });
});

describe("intake_link_expiring source scoping (recipient model)", () => {
  it("is workspace-member scoped (teamId in teamIds), not admin-scoped", () => {
    const at = SRC.indexOf("prisma.workflowIntakeLink.findMany");
    expect(at).toBeGreaterThan(-1);
    const window = SRC.slice(at, at + 260);
    expect(window).toMatch(/teamId:\s*\{\s*in:\s*teamIds\s*\}/);
    // The admin-scoped set is adjudicatorTeamIds — it must NOT gate this source.
    expect(window).not.toMatch(/adjudicatorTeamIds/);
  });

  it("only surfaces not-yet-expired links (expiresAtUtc > now) — so Overdue naturally excludes it", () => {
    const at = SRC.indexOf("prisma.workflowIntakeLink.findMany");
    const window = SRC.slice(at, at + 320);
    expect(window).toMatch(/expiresAtUtc:\s*\{[\s\S]*?gt:\s*now/);
  });
});
