/**
 * MEMBERS AUDIT ENT-01 (2026-10-25) — capabilities are a function of workspace
 * KIND, PLAN and ROLE.
 *
 * The Personal-workspace branch assumed its viewer was the only occupant: it
 * granted management to whoever looked (an invited VIEWER received
 * SETTINGS_MANAGE) and withheld every collaboration surface by kind, so a TEAM
 * buyer — whose TEAM plan lives on that very workspace — never received Team
 * management, reviewer operations or case assignment.
 */
import { describe, expect, it } from "vitest";

import { resolveCapabilities } from "../src/services/platform-context/capability-registry.js";

type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

function personal(role: Role, opts: { collaboration: boolean; reviewOps: boolean }) {
  return resolveCapabilities({
    scope: "PERSONAL",
    workspaceKind: "PERSONAL",
    role,
    plan: null,
    isPlatformAdmin: false,
    collaborationIncluded: opts.collaboration,
    reviewerOperationsIncluded: opts.reviewOps,
  });
}

const TEAM_PLAN = { collaboration: true, reviewOps: true };
const PRO_PLAN = { collaboration: true, reviewOps: false };
const FREE_PLAN = { collaboration: false, reviewOps: false };

describe("ENT-01 — Team features on the Personal Workspace", () => {
  it("TEAM: the owner manages people and groups and runs reviewer operations", () => {
    const caps = personal("OWNER", TEAM_PLAN);
    for (const key of [
      "TEAM_MANAGE",
      "REVIEWER_OPS_VIEW",
      "REVIEWER_OPS_ACT",
      "REVIEW_ASSIGN",
      "REVIEW_ESCALATE",
      "CASE_ASSIGN",
      "BULK_ACTIONS",
    ] as const) {
      expect(caps[key], key).toBe(true);
    }
  });

  it("PRO: people and groups yes, Team-only reviewer operations no", () => {
    const caps = personal("OWNER", PRO_PLAN);
    expect(caps.TEAM_MANAGE).toBe(true);
    for (const key of ["REVIEWER_OPS_VIEW", "REVIEW_ASSIGN", "CASE_ASSIGN", "BULK_ACTIONS"] as const) {
      expect(caps[key], key).toBe(false);
    }
  });

  it("FREE: nothing collaborative, and the owner keeps their own records", () => {
    const caps = personal("OWNER", FREE_PLAN);
    expect(caps.TEAM_MANAGE).toBe(false);
    expect(caps.REVIEWER_OPS_VIEW).toBe(false);
    expect(caps.EVIDENCE_MANAGE).toBe(true);
    expect(caps.SETTINGS_MANAGE).toBe(true);
  });

  it("an invited VIEWER gets no management, whatever the plan", () => {
    const caps = personal("VIEWER", TEAM_PLAN);
    for (const key of [
      "SETTINGS_MANAGE",
      "CASES_MANAGE",
      "EVIDENCE_MANAGE",
      "TEAM_MANAGE",
      "REVIEWER_OPS_ACT",
      "CASE_ASSIGN",
      "BULK_ACTIONS",
    ] as const) {
      expect(caps[key], key).toBe(false);
    }
    expect(caps.TEAM_VIEW).toBe(true);
  });

  it("an invited MEMBER works records but does not administer the workspace", () => {
    const caps = personal("MEMBER", TEAM_PLAN);
    expect(caps.CASES_MANAGE).toBe(true);
    expect(caps.REVIEW_ASSIGN).toBe(true);
    expect(caps.SETTINGS_MANAGE).toBe(false);
    expect(caps.TEAM_MANAGE).toBe(false);
    expect(caps.CASE_ASSIGN).toBe(false);
  });

  it("a shared workspace without the plan stops offering reviewer operations", () => {
    const caps = resolveCapabilities({
      scope: "TEAM",
      workspaceKind: "OWNED",
      role: "OWNER",
      plan: null,
      isPlatformAdmin: false,
      reviewerOperationsIncluded: false,
    });
    for (const key of ["REVIEWER_OPS_VIEW", "REVIEW_ASSIGN", "CASE_ASSIGN", "BULK_ACTIONS"] as const) {
      expect(caps[key], key).toBe(false);
    }
    // Management of the shared workspace itself is unchanged.
    expect(caps.TEAM_MANAGE).toBe(true);
  });
});
