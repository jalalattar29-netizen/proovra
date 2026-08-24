/**
 * PHASE 1 — final caller classification: the 10 former
 * `getEvidenceWithOwnerAccess` callers now route through the canonical
 * per-record wrapper (`resolveEvidenceRecordAccess`, via the throwing
 * loader `getEvidenceWithRecordAccess`).
 *
 * Behavioral (mocked prisma, real canonical engine):
 *   * former ORGANIZATION-Evidence creator, SUSPENDED / REVOKED → denied;
 *   * active member with the operation capability → allowed (not creator);
 *   * active member WITHOUT the capability → denied;
 *   * denial performs NO mutation;
 *   * Personal-scope evidence (teamId null): owner rule remains valid.
 *
 * Source contracts: every one of the 10 call sites passes its
 * operation-specific capability; no `getEvidenceWithOwnerAccess` caller
 * remains; every denial class throws the same 404 "Evidence not found".
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const CREATOR = "11111111-1111-4111-8111-111111111111";
const MEMBER = "22222222-2222-4222-8222-222222222222";
const TEAM_ORG = "44444444-4444-4444-8444-444444444444";
const EV_PERSONAL = "55555555-5555-4555-8555-555555555555";
const EV_TEAM = "66666666-6666-4666-8666-666666666666";

const H = vi.hoisted(() => ({
  evidence: new Map<string, { id: string; teamId: string | null; ownerUserId: string }>(),
  members: new Map<string, { role: string; status: string }>(),
  mutations: 0,
}));

vi.mock("../src/db.js", () => {
  const countMutation = async () => {
    H.mutations += 1;
    return {};
  };
  return {
    prisma: {
      evidence: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          H.evidence.get(where.id) ?? null,
        update: countMutation,
        updateMany: countMutation,
        delete: countMutation,
        deleteMany: countMutation,
      },
      teamMember: {
        findUnique: async ({
          where,
        }: {
          where: { teamId_userId: { teamId: string; userId: string } };
        }) => {
          const m = H.members.get(
            `${where.teamId_userId.teamId}:${where.teamId_userId.userId}`,
          );
          if (!m) return null;
          return {
            id: "tm-1",
            teamId: where.teamId_userId.teamId,
            userId: where.teamId_userId.userId,
            role: m.role,
            status: m.status,
            accessExpiresAtUtc: null,
            team: {
              isPersonal: false,
              workspaceKind: "ORGANIZATION",
              billingPlan: "ENTERPRISE",
              organization: { status: "ACTIVE" },
            },
            capabilityGrants: [],
            delegatedAdminScopes: [],
          };
        },
      },
      securityEvent: { create: async () => ({ id: "se-1" }) },
    },
  };
});

import { resolveEvidenceRecordAccess } from "../src/services/evidence/evidence-record-access.service.js";

beforeEach(() => {
  H.evidence.clear();
  H.members.clear();
  H.mutations = 0;
  H.evidence.set(EV_PERSONAL, {
    id: EV_PERSONAL,
    teamId: null,
    ownerUserId: CREATOR,
  });
  H.evidence.set(EV_TEAM, {
    id: EV_TEAM,
    teamId: TEAM_ORG,
    ownerUserId: CREATOR,
  });
});

describe("record access — non-destructive operations decision matrix", () => {
  it("SUSPENDED / REVOKED former creator denied for label / lock / complete / report ops", async () => {
    for (const status of ["SUSPENDED", "REVOKED"] as const) {
      H.members.set(`${TEAM_ORG}:${CREATOR}`, { role: "OWNER", status });
      for (const permission of [
        "evidence.update_metadata",
        "evidence.generate_report",
        "evidence.read",
      ] as const) {
        const d = await resolveEvidenceRecordAccess({
          userId: CREATOR, // IS the creator — must not matter
          evidenceId: EV_TEAM,
          permission,
        });
        expect(d.allowed).toBe(false);
        if (!d.allowed) expect(d.internalReason).toBe("member_not_active");
      }
    }
    expect(H.mutations).toBe(0); // denial performs no mutation
  });

  it("ACTIVE member with the operation capability allowed (not the creator)", async () => {
    // MEMBER role → canonical REVIEWER: holds read/update_metadata/
    // generate_report but NOT archive.
    H.members.set(`${TEAM_ORG}:${MEMBER}`, { role: "MEMBER", status: "ACTIVE" });
    for (const permission of [
      "evidence.read",
      "evidence.update_metadata",
      "evidence.generate_report",
    ] as const) {
      const d = await resolveEvidenceRecordAccess({
        userId: MEMBER,
        evidenceId: EV_TEAM,
        permission,
      });
      expect(d.allowed).toBe(true);
    }
  });

  it("ACTIVE member WITHOUT the capability denied (MEMBER lacks evidence.archive → cannot unlock)", async () => {
    H.members.set(`${TEAM_ORG}:${MEMBER}`, { role: "MEMBER", status: "ACTIVE" });
    const d = await resolveEvidenceRecordAccess({
      userId: MEMBER,
      evidenceId: EV_TEAM,
      permission: "evidence.archive",
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.internalReason).toBe("permission_not_granted");
    expect(H.mutations).toBe(0);
  });

  it("Personal-scope evidence: owner rule remains valid (owner allowed, non-owner denied)", async () => {
    const owner = await resolveEvidenceRecordAccess({
      userId: CREATOR,
      evidenceId: EV_PERSONAL,
      permission: "evidence.update_metadata",
    });
    expect(owner.allowed).toBe(true);
    const nonOwner = await resolveEvidenceRecordAccess({
      userId: MEMBER,
      evidenceId: EV_PERSONAL,
      permission: "evidence.update_metadata",
    });
    expect(nonOwner.allowed).toBe(false);
  });
});

describe("evidence.routes — the 10 former owner-gate callers are classified", () => {
  const SRC = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "src",
      "routes",
      "evidence.routes.ts",
    ),
    "utf8",
  );

  it("no route calls getEvidenceWithOwnerAccess any more", () => {
    // The identifier survives only in the removal-note comment.
    expect(SRC).not.toMatch(/getEvidenceWithOwnerAccess\(/);
  });

  it("each caller passes its operation-specific capability", () => {
    const count = (perm: string) =>
      (
        SRC.match(
          new RegExp(
            `getEvidenceWithRecordAccess\\([^)]*"${perm.replace(/\./g, "\\.")}"`,
            "g",
          ),
        ) ?? []
      ).length;
    expect(count("evidence.read")).toBe(1); // GET technical-metadata
    // label + parts + lock + complete + bulk case-link = 5
    expect(count("evidence.update_metadata")).toBe(5);
    // EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — the bulk (un)archive and
    // bulk trash/restore callers are GONE from this file. Their authorization
    // moved into `applyEvidenceLifecycleAction`, alongside the single routes',
    // so there is one resolution per action rather than one per code path —
    // which is what stopped bulk RESTORE_TRASH and single restore from
    // requiring different things. What remains here is `unlock`, the one
    // `evidence.archive` caller that is not a lifecycle action.
    expect(count("evidence.archive")).toBe(1);
    expect(count("evidence.delete")).toBe(0);

    // The lifecycle capabilities are asserted where they now live.
    const service = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "services",
        "evidence",
        "evidence-lifecycle.service.ts",
      ),
      "utf8",
    );
    expect(service).toContain('ARCHIVE: "evidence.archive"');
    expect(service).toContain('UNARCHIVE: "evidence.archive"');
    expect(service).toContain('TRASH: "evidence.delete"');
    expect(service).toContain('RESTORE_FROM_TRASH: "evidence.delete"');
    // regenerate + cert request + cert attest + cert revoke = 4
    // (the attest route was wired in Phase 12 Point 4 Pass H — the service,
    // request schema and CERTIFICATION_ATTESTED custody event already
    // existed, but no route reached them.)
    expect(count("evidence.generate_report")).toBe(4);
  });

  it("the loader throws one uniform 404 for every denial class (anti-enum)", () => {
    const loader = SRC.match(
      /async function getEvidenceWithRecordAccess[\s\S]{0,1600}?\n\}/,
    );
    expect(loader).not.toBeNull();
    expect(loader![0]).toContain("resolveEvidenceRecordAccess");
    // Both the access-denied and record-missing paths throw the same
    // message + statusCode; no 403 / "Forbidden" branch exists.
    const notFoundThrows =
      loader![0].match(/Evidence not found/g) ?? [];
    expect(notFoundThrows.length).toBe(2);
    expect(loader![0]).not.toContain("Forbidden");
    expect(loader![0]).not.toMatch(/statusCode = 403/);
  });
});
