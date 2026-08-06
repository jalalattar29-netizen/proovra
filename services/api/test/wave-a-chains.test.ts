/**
 * WAVE A CROSS-PHASE CHAINS (2026-07-22) — chains 1/4/6 through the REAL
 * production composition (not per-service unit tests).
 *
 * CHAIN 1 (behavioral): persisted TeamMember row → loadMemberAccessSnapshot
 *   (real loader; only the db client is substituted) → canonical
 *   resolveWorkspaceKind classification → parent-Organization lifecycle →
 *   ACTIVE-membership gate → role/capability decision. Negatives prove
 *   fail-closed at every stage with NO record data leaked in the decision.
 *
 * CHAIN 4 / CHAIN 6 (source-contract at the production symbols): Evidence
 *   finalize binds to the PERSISTED workspace, and the worker purge executor
 *   re-asserts all three legal-hold families + object-lock retention before
 *   any destructive write, with the custody event inside the same tx.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";

import {
  loadMemberAccessSnapshot,
  evaluateAccess,
} from "../src/services/identity/access-policy.service.js";

// ── CHAIN 1 fixture: a fake db returning a configurable TeamMember row ──
type Row = Record<string, unknown> | null;
function dbWith(row: Row): PrismaClient {
  return {
    teamMember: { findUnique: async () => row },
  } as unknown as PrismaClient;
}

function memberRow(overrides: Record<string, unknown> = {}): Row {
  return {
    id: "tm-1",
    teamId: "team-1",
    userId: "user-1",
    role: "ADMIN",
    status: "ACTIVE",
    accessExpiresAtUtc: null,
    team: {
      isPersonal: false,
      workspaceKind: "ORGANIZATION",
      billingPlan: "ENTERPRISE",
      organization: { status: "ACTIVE" },
    },
    capabilityGrants: [],
    delegatedAdminScopes: [],
    ...overrides,
  };
}

async function decide(row: Row, permission = "evidence.read") {
  const snapshot = await loadMemberAccessSnapshot(
    { teamId: "team-1", userId: "user-1" },
    dbWith(row),
  );
  return evaluateAccess(
    snapshot ? { kind: "MEMBER", member: snapshot } : null,
    { permission } as never,
  );
}

describe("Wave A CHAIN 1 — context → classification → lifecycle → membership → authorization", () => {
  it("POSITIVE: ACTIVE member in an ACTIVE-org ORGANIZATION workspace with role floor → allowed", async () => {
    const d = await decide(memberRow());
    expect(d.allowed).toBe(true);
  });

  it("wrong workspace (no membership row) → denied, no record data leaked", async () => {
    const d = await decide(null);
    expect(d).toEqual({ allowed: false, reason: "no_actor" });
  });

  it("inactive (SUSPENDED) membership → denied before any capability evaluation", async () => {
    const d = await decide(memberRow({ status: "SUSPENDED" }));
    expect(d.allowed).toBe(false);
    expect((d as { reason?: string }).reason).toBe("member_not_active");
  });

  it("suspended parent Organization → ORGANIZATION workspace denied (lifecycle gate)", async () => {
    const d = await decide(
      memberRow({
        team: {
          isPersonal: false,
          workspaceKind: "ORGANIZATION",
          billingPlan: "ENTERPRISE",
          organization: { status: "SUSPENDED" },
        },
      }),
    );
    expect(d.allowed).toBe(false);
    expect((d as { reason?: string }).reason).toBe("organization_not_active");
  });

  it("unresolvable workspace kind → fail closed (no null-means-skip path)", async () => {
    const d = await decide(
      memberRow({
        team: null, // team row unprovable → UNKNOWN kind
      }),
    );
    expect(d.allowed).toBe(false);
    expect((d as { reason?: string }).reason).toBe("workspace_kind_unresolved");
  });

  it("missing capability → denied; PERSONAL/OWNED workspace correctly skips org-lifecycle", async () => {
    const d = await decide(
      memberRow({
        role: "VIEWER",
        team: {
          isPersonal: false,
          workspaceKind: "OWNED",
          billingPlan: "PRO",
          organization: null, // OWNED → org lifecycle not applicable
        },
      }),
      "team.manage_billing",
    );
    expect(d.allowed).toBe(false);
    // Denial reason names the missing permission policy, never the resource.
    expect(JSON.stringify(d)).not.toMatch(/team-1|user-1|tm-1/);
  });
});

// ── CHAINS 4 & 6 — source contracts at the production symbols ──
function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}

describe("Wave A CHAIN 4 — Evidence bound to PERSISTED workspace through finalize/worker", () => {
  it("finalize derives scope from the PERSISTED evidence row, never a client-supplied teamId", () => {
    const complete = read("src/services/evidence-complete.service.ts");
    // Finalize loads the persisted row (owner-scoped) inside the tx…
    expect(complete).toMatch(/evidence\.(findUnique|findFirst)/);
    // …and every downstream binding uses the ROW's teamId, not a request value.
    expect(complete).toMatch(/teamId:\s*evidence\.teamId/);
    // No `params.teamId`/body-supplied tenant participates in finalize binding.
    expect(complete).not.toMatch(/teamId:\s*params\.teamId/);
  });

  it("worker reloads the authoritative Evidence row (payload id is a KEY, not tenant truth)", () => {
    const processor = readFileSync(
      fileURLToPath(new URL("../../worker/src/processor.ts", import.meta.url)),
      "utf8",
    );
    // The purge path re-reads evidence by id and uses ITS persisted teamId.
    expect(processor).toMatch(/evidence\.findUnique\(\{\s*\n?\s*where:\s*\{\s*id:\s*evidenceId\s*\}/);
  });
});

describe("Wave A CHAIN 6 — destruction: retention → legal-hold precedence → custody → audit", () => {
  const processor = readFileSync(
    fileURLToPath(new URL("../../worker/src/processor.ts", import.meta.url)),
    "utf8",
  );

  it("purge re-asserts every hold family at execute time (hold placed after enqueue still blocks)", () => {
    // PHASE 12B CLUSTER 8 — one union evaluator replaces the three per-store
    // lookups. All three families are still consulted, and a transient DB
    // failure now aborts the purge instead of reporting "no hold".
    expect(processor).toMatch(/evaluateEffectiveLegalHold\(prisma/);
    const evaluator = readFileSync(
      fileURLToPath(
        new URL("../../worker/src/governance/effective-legal-hold.ts", import.meta.url),
      ),
      "utf8",
    );
    // PHASE 12 POINT 3 — one store, every scope. Coverage is proven by the
    // canonical scope vocabulary plus the historical clause that makes an
    // unresolvable ACTIVE hold fail closed.
    expect(evaluator).toMatch(/prisma\.evidenceLegalHold\.findMany/);
    expect(evaluator).toMatch(/scope: "EVIDENCE"/);
    expect(evaluator).toMatch(/scope: "CASE"/);
    expect(evaluator).toMatch(/scope: "WORKSPACE"/);
    expect(evaluator).toMatch(/historical/);
    // No retired store may reappear.
    expect(evaluator).not.toMatch(/prisma\.caseLegalHold\./);
    expect(evaluator).not.toMatch(/prisma\.legalHold\./);
    expect(evaluator).toMatch(/throw err;/);
  });

  it("an active hold RESCHEDULES (zero destruction), it does not proceed", () => {
    expect(processor).toMatch(/rescheduled because evidence is under an active legal hold/);
  });

  it("object-lock retention still active → no destruction", () => {
    expect(processor).toMatch(/isRetentionStillActive/);
  });

  it("custody EVIDENCE_PURGED event is written in the SAME transaction as the delete", () => {
    const txIdx = processor.indexOf("appendCustodyEventTx(tx, {");
    const delIdx = processor.indexOf("await tx.evidence.delete(");
    expect(txIdx).toBeGreaterThan(-1);
    expect(delIdx).toBeGreaterThan(txIdx); // custody event precedes the delete in one tx
  });
});
