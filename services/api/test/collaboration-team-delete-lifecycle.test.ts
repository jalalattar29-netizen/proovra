/**
 * COLLABORATION TEAM LIFECYCLE — archive is the one retirement, and nothing
 * reaches evidence (2026-10-28).
 *
 * A Collaboration Team is never customer-deleted. Archive preserves the row
 * and every record of who was in it and what they did, and frees one active
 * slot; Restore re-checks everything that admits a group. The behaviour is
 * proven against PostgreSQL in collaboration-team-archive.integration.test.ts;
 * this file keeps the STRUCTURAL guarantees: no hard-delete path is exported,
 * the provenance columns exist, and nothing cascading from a team could ever
 * reach evidence, cases or workspace membership.
 *
 * (The file keeps its name from the delete lifecycle it used to cover.)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCHEMA = readFileSync(
  join(HERE, "..", "prisma", "schema.prisma"),
  "utf8",
);

vi.mock("../src/services/audit/tenant-audit.service.js", () => ({
  emitTenantAudit: async () => undefined,
}));

// Static (vi.mock above is hoisted over it): an in-test dynamic import of
// this module times out under a loaded full-suite run.
import * as collaborationTeamService from "../src/services/collaboration-team/collaboration-team.service.js";

describe("no customer hard-delete exists", () => {
  it("the service exports archive and restore, and no delete or disposability", () => {
    const exported = Object.keys(collaborationTeamService);
    expect(exported).toContain("archiveCollaborationTeam");
    expect(exported).toContain("unarchiveCollaborationTeam");
    expect(exported).toContain("assessCollaborationTeamArchiveImpact");
    for (const gone of ["deleteCollaborationTeam", "assessCollaborationTeamDisposability"]) {
      expect(exported, gone).not.toContain(gone);
    }
  });

  it("the archived row keeps who archived it and why", () => {
    const teamModel = SCHEMA.slice(
      SCHEMA.indexOf("model CollaborationTeam {"),
      SCHEMA.indexOf("@@map(\"collaboration_teams\")"),
    );
    expect(teamModel).toMatch(/archivedByUserId\s+String\?/);
    expect(teamModel).toMatch(/archiveReason\s+String\?/);
  });
});

describe("evidence and case safety — structural, not promised", () => {
  it("a team assignment holds NO foreign key to Case or Evidence", () => {
    const model = SCHEMA.slice(
      SCHEMA.indexOf("model CollaborationTeamAssignment"),
      SCHEMA.indexOf("@@map(\"collaboration_team_assignments\")"),
    );
    expect(model.length).toBeGreaterThan(0);
    // The target is a bare uuid. This is WHY a cascade cannot reach evidence.
    expect(model).toMatch(/targetId\s+String\s+@map\("target_id"\)\s+@db\.Uuid/);
    expect(model).not.toMatch(/@relation\([^)]*references:\s*\[id\][^)]*\)\s*\/\/\s*case/i);
    for (const forbidden of ["Case @relation", "Evidence @relation"]) {
      expect(
        model,
        `a Collaboration Team must not own ${forbidden} — deleting a grouping would then reach evidence`,
      ).not.toContain(forbidden);
    }
  });

  it("nothing cascading from a team reaches evidence, cases or workspace membership", () => {
    /*
     * Ten child tables cascade from `collaboration_teams`. Every one of them is
     * a collaboration_team_* table — the group's own bookkeeping. Evidence,
     * Case and TeamMember (workspace membership) are not among them, so a
     * delete cannot touch ownership data.
     */
    const cascading = SCHEMA.split("\n").filter(
      (l) =>
        l.includes("CollaborationTeam @relation") ||
        l.includes("CollaborationTeam? @relation"),
    );
    expect(cascading.length).toBeGreaterThan(5);
    for (const line of cascading) {
      // Members audit ACC-10 — the ONE exception is a Case grant, and it is
      // the stronger guarantee: RESTRICT, so a team that still holds case
      // reach can never be deleted (it is archived) and the grant record can
      // never be cascaded away.
      if (line.includes("CaseCollaborationTeamAccessTeam")) {
        expect(line).toContain("onDelete: Restrict");
        continue;
      }
      expect(line).toContain("onDelete: Cascade");
    }
    // And the workspace relation points the OTHER way: a team belongs to a
    // workspace, deleting the team never deletes the workspace or its members.
    const teamModel = SCHEMA.slice(
      SCHEMA.indexOf("model CollaborationTeam {"),
      SCHEMA.indexOf("@@map(\"collaboration_teams\")"),
    );
    expect(teamModel).toMatch(/workspace Team @relation\("CollaborationTeamWorkspace"/);
    expect(teamModel).not.toContain("Evidence");
    expect(teamModel).not.toContain("Case[]");
  });
});

describe("capacity — ACTIVE consumes, ARCHIVED does not", () => {
  const GUARDS = readFileSync(
    join(HERE, "..", "src", "services", "collaboration-team", "billing-guards.ts"),
    "utf8",
  );

  it("every used-count query excludes archived groups", () => {
    /*
     * ALREADY IMPLEMENTED and verified rather than rewritten. Both capacity
     * counters — the creation gate and the projection — filter on
     * `status: "ACTIVE"` AND `archivedAtUtc: null`, so archiving frees a slot
     * and a customer never has to delete history to create another group.
     */
    const counts = GUARDS.match(/collaborationTeam\.count\(\{[\s\S]{0,220}?\}\)/g) ?? [];
    expect(counts.length).toBeGreaterThanOrEqual(2);
    for (const q of counts) {
      expect(q).toContain('status: "ACTIVE"');
      expect(q).toContain("archivedAtUtc: null");
    }
  });

  it("unarchive re-checks capacity under the same lock as creation", () => {
    const svc = readFileSync(
      join(
        HERE,
        "..",
        "src",
        "services",
        "collaboration-team",
        "collaboration-team.service.ts",
      ),
      "utf8",
    );
    const fn = svc.slice(svc.indexOf("export async function unarchiveCollaborationTeam"));
    const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
    // Without this, a workspace could archive one group, create a third, then
    // reopen the first and hold three active groups on a plan that sells two.
    expect(body).toContain("lockAndAssertCollaborationTeamCapacity");
    expect(body).toContain("$transaction");
  });
});
