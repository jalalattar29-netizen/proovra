/**
 * PHASE 5 §8.4/§8.5 (2026-07-22) — invitation-family + external-access
 * closure pins.
 *
 * §8.5 portal scope binding (behavioral): a portal grant is scoped to
 * ONE resource; every workflow op must prove the workflow's evidence IS
 * that resource (directly / via package / via case link). Out-of-scope
 * and nonexistent workflows are indistinguishable.
 *
 * §8.5 legal hold: grant token lookup derives the hold from the grant's
 * own scope — the hardcoded `hasActiveLegalHold: false` is banned.
 *
 * §8.4 TeamInvite: acceptance is a guarded atomic claim + orchestrated
 * grant in one transaction (concurrent double-accept structurally
 * impossible; provisioning failure rolls the claim back).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  workflow: null as { evidenceId: string } | null,
  pkg: null as { evidenceId: string } | null,
  caseLink: null as { id: string } | null,
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    evidenceReviewWorkflow: { findFirst: async () => H.workflow },
    verificationPackage: { findFirst: async () => H.pkg },
    caseEvidenceLink: { findFirst: async () => H.caseLink },
  },
}));

import { resolveWorkflowInGrantScope } from "../src/services/external-review/portal-scope.service.js";

beforeEach(() => {
  H.workflow = { evidenceId: "ev-1" };
  H.pkg = null;
  H.caseLink = null;
});

describe("Phase 5 §8.5 — portal grant→workflow scope binding", () => {
  const base = {
    teamId: "t1",
    evidenceId: null as string | null,
    caseId: null as string | null,
    packageId: null as string | null,
  };

  it("EVIDENCE scope: only the grant's evidence workflow passes", async () => {
    const scope = { ...base, scopeKind: "EVIDENCE" as const, evidenceId: "ev-1" };
    expect(
      await resolveWorkflowInGrantScope({ scope, workflowId: "wf-1" }),
    ).toEqual({ ok: true, evidenceId: "ev-1" });

    H.workflow = { evidenceId: "ev-OTHER" };
    expect(
      await resolveWorkflowInGrantScope({ scope, workflowId: "wf-2" }),
    ).toEqual({ ok: false });
  });

  it("PACKAGE scope: passes only when the package's evidence matches", async () => {
    const scope = { ...base, scopeKind: "PACKAGE" as const, packageId: "pkg-1" };
    H.pkg = { evidenceId: "ev-1" };
    expect(
      await resolveWorkflowInGrantScope({ scope, workflowId: "wf-1" }),
    ).toEqual({ ok: true, evidenceId: "ev-1" });

    H.pkg = { evidenceId: "ev-OTHER" };
    expect(
      await resolveWorkflowInGrantScope({ scope, workflowId: "wf-1" }),
    ).toEqual({ ok: false });
  });

  it("CASE scope: passes only when the workflow's evidence is linked to the case", async () => {
    const scope = { ...base, scopeKind: "CASE" as const, caseId: "case-1" };
    H.caseLink = { id: "link-1" };
    expect(
      await resolveWorkflowInGrantScope({ scope, workflowId: "wf-1" }),
    ).toEqual({ ok: true, evidenceId: "ev-1" });

    H.caseLink = null;
    expect(
      await resolveWorkflowInGrantScope({ scope, workflowId: "wf-1" }),
    ).toEqual({ ok: false });
  });

  it("nonexistent / cross-team workflow and null scope target fail closed", async () => {
    H.workflow = null; // teamId-scoped findFirst missed
    expect(
      await resolveWorkflowInGrantScope({
        scope: { ...base, scopeKind: "EVIDENCE" as const, evidenceId: "ev-1" },
        workflowId: "wf-1",
      }),
    ).toEqual({ ok: false });

    H.workflow = { evidenceId: "ev-1" };
    expect(
      await resolveWorkflowInGrantScope({
        scope: { ...base, scopeKind: "EVIDENCE" as const },
        workflowId: "wf-1",
      }),
    ).toEqual({ ok: false });
  });
});

describe("Phase 5 §8.4/§8.5 — source contracts", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

  it("every workflow-scoped portal route runs the scope gate; reads are capability-gated", () => {
    const routes = read("routes/external-portal.routes.ts");
    const gateCalls =
      routes.match(/requireWorkflowInScope\(s, workflowId, reply\)/g) ?? [];
    // comments GET+POST, decision POST, decisions GET, view POST.
    expect(gateCalls.length).toBe(5);
    expect(routes).toContain("resolveWorkflowInGrantScope");
    // Reads gate on capability (comment/decide OR history.read).
    expect(routes).toMatch(
      /portal\.comment[\s\S]{0,120}portal\.history\.read/,
    );
    expect(routes).toMatch(/portal\.decide[\s\S]{0,120}portal\.history\.read/);
  });

  it("grant token lookup derives Legal Hold from the grant scope (hardcoded false banned)", () => {
    const svc = read(
      "services/external-review/external-review-grant.service.ts",
    );
    expect(svc).toContain("grantScopeHasActiveLegalHold");
    expect(svc).not.toContain("hasActiveLegalHold: false");
  });

  it("TeamInvite accept: guarded claim + orchestrated grant in ONE transaction", () => {
    // WORKSPACE AND COLLABORATION RECONCILIATION — the rule is unchanged and
    // its subject moved. The handler that used to hold this logic is now one
    // call to `acceptWorkspaceInvitation`, THE workspace invitation lifecycle,
    // so the contract is read where the code actually lives.
    const routes = read("routes/teams.routes.ts");
    const at = routes.indexOf('"/v1/teams/invites/:token/accept"');
    expect(at).toBeGreaterThan(-1);
    expect(routes.slice(at, at + 4000)).toMatch(/acceptWorkspaceInvitation\(/);

    const service = read("services/identity/workspace-invitation.service.ts");
    // The claim is guarded on the un-consumed invite …
    expect(service).toMatch(
      /teamInvite\.updateMany\(\{\s*\n?\s*where:\s*\{\s*id:\s*invite\.id,\s*acceptedAt:\s*null,\s*revokedAt:\s*null\s*\}/,
    );
    const claimIdx = service.indexOf("acceptedAt: null, revokedAt: null");
    const provisionIdx = service.indexOf("provisionMembership(");
    expect(claimIdx).toBeGreaterThan(-1);
    // … the claim precedes the provisioning call …
    expect(provisionIdx).toBeGreaterThan(claimIdx);
    // … and both sit inside ONE transaction that also holds the seat check,
    // serialised per workspace so two accepts of DIFFERENT invitations cannot
    // both take the last remaining seat.
    expect(service).toMatch(/\$transaction\(/);
    expect(service).toContain("pg_try_advisory_xact_lock");

    // The old post-provisioning unguarded consume is gone.
    expect(service).not.toMatch(
      /teamInvite\.update\(\{\s*\n?\s*where:\s*\{\s*id:\s*invite\.id\s*\},\s*\n?\s*data:\s*\{\s*acceptedAt/,
    );
  });
});
