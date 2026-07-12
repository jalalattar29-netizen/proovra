/**
 * Phase C4 (live) — DB-backed citation resolver (behavioral, injected prisma).
 */
import { describe, expect, it } from "vitest";

import {
  buildCitationResolver,
  buildWorkspaceCitationLookups,
  type CitationPrisma,
} from "../src/services/ai/ai-citation-db-resolver.service.js";
import { validateCitations, type AiCitation } from "../src/services/ai/ai-citation.service.js";

const prisma: CitationPrisma = {
  evidence: {
    findUnique: async ({ where }) => {
      if (where.id === "ev-ok") return { teamId: "ws-1", deletedAt: null, verificationPackageVersion: 3 };
      if (where.id === "ev-deleted") return { teamId: "ws-1", deletedAt: new Date(0), verificationPackageVersion: 3 };
      if (where.id === "ev-other") return { teamId: "ws-2", deletedAt: null, verificationPackageVersion: 3 };
      return null;
    },
  },
  case: {
    findUnique: async ({ where }) =>
      where.id === "c-ok" ? { teamId: "ws-1", deletedAt: null } : null,
  },
};

const cite = (over: Partial<AiCitation>): AiCitation => ({
  type: "EVIDENCE_RECORD", objectId: "ev-ok", displayLabel: "E", sourceField: null,
  objectVersion: 3, timestampUtc: null, route: "/evidence/ev-ok", workspaceId: "ws-1",
  analyzedAtUtc: "2026-07-12T00:00:00Z", ...over,
});

describe("C4 live — workspace citation lookups + resolver", () => {
  const resolver = buildCitationResolver(buildWorkspaceCitationLookups(prisma, "ws-1"));

  it("valid in-tenant evidence citation passes", async () => {
    const r = await validateCitations([cite({})], { workspaceId: "ws-1" }, resolver);
    expect(r.valid.length).toBe(1);
  });
  it("invented (not found) rejected", async () => {
    const r = await validateCitations([cite({ objectId: "nope", route: "/evidence/nope" })], { workspaceId: "ws-1" }, resolver);
    expect(r.rejected[0]?.reason).toBe("NOT_FOUND");
  });
  it("deleted rejected", async () => {
    const r = await validateCitations([cite({ objectId: "ev-deleted", route: "/evidence/ev-deleted" })], { workspaceId: "ws-1" }, resolver);
    expect(r.rejected[0]?.reason).toBe("DELETED");
  });
  it("cross-tenant rejected", async () => {
    const r = await validateCitations([cite({ objectId: "ev-other", route: "/evidence/ev-other" })], { workspaceId: "ws-1" }, resolver);
    expect(r.rejected[0]?.reason).toBe("CROSS_TENANT");
  });
  it("stale version rejected", async () => {
    const r = await validateCitations([cite({ objectVersion: 99 })], { workspaceId: "ws-1" }, resolver);
    expect(r.rejected[0]?.reason).toBe("VERSION_MISMATCH");
  });
  it("unconfigured citation type rejected fail-closed (no lookup)", async () => {
    const r = await validateCitations([cite({ type: "REPORT", objectId: "r-1", route: "/reports/r-1" })], { workspaceId: "ws-1" }, resolver);
    expect(r.rejected[0]?.reason).toBe("NOT_FOUND");
  });
});
