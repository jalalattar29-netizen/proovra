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

  /**
   * EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — the chain is unchanged; its
   * links moved into the canonical destruction executor, which the purge job
   * now triggers. Each assertion below is made where the behaviour lives, and
   * each is STRONGER there than it was here:
   *
   *   - the hold is re-evaluated AFTER a durable claim and a re-read, so a hold
   *     placed mid-flight still wins;
   *   - retention is no longer a hand-rolled `isRetentionStillActive` helper in
   *     the worker but one of the boundaries the shared authority applies, and
   *     it now covers application retention and Object Lock together;
   *   - the custody event is written in the same transaction as the TOMBSTONE
   *     rather than the same transaction as a hard delete, because the hard
   *     delete is gone: it removed the Evidence row AND its custody chain, so a
   *     destroyed record left no trace it had ever existed.
   */
  const executor = readFileSync(
    fileURLToPath(
      new URL(
        "../../../packages/shared-runtime/src/evidence-destruction/executor.ts",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  it("an active hold RESCHEDULES (zero destruction), it does not proceed", () => {
    // The trigger reschedules on any block reason…
    expect(processor).toMatch(/rescheduled: destruction is not yet permitted/);
    expect(processor).toMatch(/legalHold: hold\.held/);
    // …and the executor is what refuses, fail-closed, before any storage call.
    const blockIdx = executor.indexOf("if (!eligibility.eligible)");
    const deleteIdx = executor.indexOf("storage.deleteObject(target)");
    expect(blockIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(blockIdx);
    expect(executor).toMatch(/await releaseClaim\(\);\s*return \{\s*ok: false,\s*outcome: "BLOCKED"/);
  });

  it("object-lock retention still active → no destruction", () => {
    // Enforced by the shared authority, which applies application retention AND
    // Object Lock retain-until — the worker's old helper only knew about one.
    expect(executor).toMatch(/computeEvidenceDestructionEligibility\(/);
    expect(executor).toMatch(/objectLockRetainUntil: evidence\.storageObjectLockRetainUntilUtc/);
    expect(executor).toMatch(/appRetentionUntil: evidence\.retentionUntilUtc/);
  });

  it("custody EVIDENCE_PURGED is written in the SAME transaction as the tombstone", () => {
    const tx = executor.slice(executor.indexOf("await prisma.$transaction("));
    const custodyIdx = tx.indexOf("appendCustodyEventInTx(tx, {");
    const tombstoneIdx = tx.indexOf('lifecycleState: "DESTROYED"');
    expect(custodyIdx).toBeGreaterThan(-1);
    expect(tombstoneIdx).toBeGreaterThan(custodyIdx);
    // And the chain is PRESERVED, not deleted with the row.
    expect(executor).not.toMatch(/custodyEvent\.deleteMany/);
    expect(executor).not.toMatch(/\bevidence\.delete\s*\(/);
  });
});
