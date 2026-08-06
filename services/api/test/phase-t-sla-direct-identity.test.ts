/**
 * Phase T — SLA template resolver direct-identity path.
 *
 * Phase 4 stamps the canonical template identity trio
 * (templateSlug, templateVersion, templateDbId) directly onto
 * EvidenceReviewWorkflow at upsert time. The Phase R SLA resolver now
 * prefers those columns as the primary source — a single indexed read on
 * the workflow row replaces the legacy two-join discovery for any row
 * stamped after Phase 4.
 *
 * Contract pinned by these tests:
 *
 *   1. Workflow row with templateDbId set → resolver returns it with
 *      source:"direct"; legacy joins are NOT called.
 *   2. Workflow row with only templateSlug set, DB row exists for
 *      (slug, teamId) → resolver returns the DB row id with
 *      source:"direct"; legacy joins are NOT called.
 *   3. Workflow row with only templateSlug set, NO DB row backs the slug
 *      → resolver returns { templateId:null, source:"direct" }; legacy
 *      joins are NOT called (trio is canonical; SLA falls back to
 *      baseline by design).
 *   4. Workflow row with all-NULL trio (pre-Phase-4 / legacy row) → falls
 *      back to the existing two-join discovery and reports
 *      source:"workflow_instance" or "intake_link" exactly as before.
 *   5. Workflow row missing entirely → falls back to legacy discovery.
 *   6. Direct-path read failure short-circuits to source:"error"; legacy
 *      joins are NOT attempted (deterministic fallback to baseline).
 *   7. Workspace-scoped DB row wins over global row for the slug lookup.
 *   8. Source-text wiring guard: the resolver implementation lists Path 0
 *      before either legacy join.
 *
 * Unit-level Prisma stubs only — no real database required.
 */

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveTemplateIdForEvidence } from "../src/services/reviewer-ops/reviewer-operations-engine.service.js";

// ---------------------------------------------------------------------------
// Helpers — the resolver touches at most these four model methods. We stub
// the ones each test cares about and leave the rest defaulted to "no row".
// ---------------------------------------------------------------------------

type PrismaStub = {
  evidenceReviewWorkflow: { findUnique: ReturnType<typeof vi.fn> };
  evidenceWorkflowTemplate: { findFirst: ReturnType<typeof vi.fn> };
  evidenceWorkflowInstanceEvidence: { findFirst: ReturnType<typeof vi.fn> };
  workflowIntakeSession: { findUnique: ReturnType<typeof vi.fn> };
};

function makePrismaStub(overrides: Partial<PrismaStub> = {}): PrismaStub {
  return {
    evidenceReviewWorkflow: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    evidenceWorkflowTemplate: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    evidenceWorkflowInstanceEvidence: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    workflowIntakeSession: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    ...overrides,
  } as PrismaStub;
}

// ---------------------------------------------------------------------------
// Direct path — templateDbId
// ---------------------------------------------------------------------------

describe("resolveTemplateIdForEvidence — direct path: templateDbId", () => {
  it("returns templateDbId with source:'direct' and never calls legacy joins", async () => {
    const prisma = makePrismaStub({
      evidenceReviewWorkflow: {
        findUnique: vi.fn().mockResolvedValue({
          templateDbId: "tpl-uuid-direct",
          templateSlug: "incident-report",
          teamId: "team-1",
        }),
      },
    });
    const res = await resolveTemplateIdForEvidence(
      "evidence-direct-1",
      prisma as never,
    );
    expect(res).toEqual({ templateId: "tpl-uuid-direct", source: "direct" });
    expect(prisma.evidenceReviewWorkflow.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { evidenceId: "evidence-direct-1" },
        select: expect.objectContaining({
          templateDbId: true,
          templateSlug: true,
          teamId: true,
        }),
      }),
    );
    // Trio satisfied at column 0 — legacy paths must not run.
    expect(prisma.evidenceWorkflowTemplate.findFirst).not.toHaveBeenCalled();
    expect(
      prisma.evidenceWorkflowInstanceEvidence.findFirst,
    ).not.toHaveBeenCalled();
    expect(prisma.workflowIntakeSession.findUnique).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Direct path — templateSlug, DB row exists
// ---------------------------------------------------------------------------

describe("resolveTemplateIdForEvidence — direct path: templateSlug → DB row", () => {
  it("workspace-scoped row wins for (slug, teamId) and source:'direct'", async () => {
    const prisma = makePrismaStub({
      evidenceReviewWorkflow: {
        findUnique: vi.fn().mockResolvedValue({
          templateDbId: null,
          templateSlug: "incident-report",
          teamId: "team-1",
        }),
      },
      evidenceWorkflowTemplate: {
        findFirst: vi
          .fn()
          // First call: workspace scope (teamId: team-1) — hit.
          .mockResolvedValueOnce({ id: "tpl-uuid-workspace" })
          // Second call would be the global fallback — must not happen.
          .mockResolvedValueOnce({ id: "tpl-uuid-global" }),
      },
    });
    const res = await resolveTemplateIdForEvidence(
      "evidence-slug-1",
      prisma as never,
    );
    expect(res).toEqual({ templateId: "tpl-uuid-workspace", source: "direct" });
    // The slug→DB lookup must filter on workspace scope first.
    expect(prisma.evidenceWorkflowTemplate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: "team-1",
          slug: "incident-report",
          archived: false,
        }),
      }),
    );
    // Workspace row hit ends the lookup; legacy joins must not run.
    expect(prisma.evidenceWorkflowTemplate.findFirst).toHaveBeenCalledTimes(1);
    expect(
      prisma.evidenceWorkflowInstanceEvidence.findFirst,
    ).not.toHaveBeenCalled();
    expect(prisma.workflowIntakeSession.findUnique).not.toHaveBeenCalled();
  });

  it("falls back to a global DB row when no workspace row exists", async () => {
    const prisma = makePrismaStub({
      evidenceReviewWorkflow: {
        findUnique: vi.fn().mockResolvedValue({
          templateDbId: null,
          templateSlug: "global-template",
          teamId: "team-1",
        }),
      },
      evidenceWorkflowTemplate: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: "tpl-uuid-global" }),
      },
    });
    const res = await resolveTemplateIdForEvidence(
      "evidence-slug-global",
      prisma as never,
    );
    expect(res).toEqual({ templateId: "tpl-uuid-global", source: "direct" });
    expect(prisma.evidenceWorkflowTemplate.findFirst).toHaveBeenCalledTimes(2);
    // Second call MUST scope to global rows (teamId: null).
    expect(
      prisma.evidenceWorkflowTemplate.findFirst,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: null,
          slug: "global-template",
          archived: false,
        }),
      }),
    );
    // Slug DB hit ends the lookup; legacy joins must not run.
    expect(
      prisma.evidenceWorkflowInstanceEvidence.findFirst,
    ).not.toHaveBeenCalled();
    expect(prisma.workflowIntakeSession.findUnique).not.toHaveBeenCalled();
  });

  it("performs only the global lookup when the workflow has no teamId", async () => {
    const prisma = makePrismaStub({
      evidenceReviewWorkflow: {
        findUnique: vi.fn().mockResolvedValue({
          templateDbId: null,
          templateSlug: "global-template",
          teamId: null,
        }),
      },
      evidenceWorkflowTemplate: {
        findFirst: vi.fn().mockResolvedValue({ id: "tpl-uuid-global" }),
      },
    });
    const res = await resolveTemplateIdForEvidence(
      "evidence-slug-noteam",
      prisma as never,
    );
    expect(res).toEqual({ templateId: "tpl-uuid-global", source: "direct" });
    expect(prisma.evidenceWorkflowTemplate.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.evidenceWorkflowTemplate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: null,
          slug: "global-template",
          archived: false,
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Direct path — templateSlug present, NO DB row backs it (seed-only template).
// The trio is the canonical source: the resolver returns null + source:"direct"
// and the SLA falls back to workspace/env baseline. Legacy joins are skipped
// because we trust the trio.
// ---------------------------------------------------------------------------

describe("resolveTemplateIdForEvidence — slug present, no DB row", () => {
  it("returns {templateId:null, source:'direct'} and never calls legacy joins", async () => {
    const prisma = makePrismaStub({
      evidenceReviewWorkflow: {
        findUnique: vi.fn().mockResolvedValue({
          templateDbId: null,
          templateSlug: "seed-only-template",
          teamId: "team-1",
        }),
      },
      // Both workspace + global lookups return null.
      evidenceWorkflowTemplate: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    });
    const res = await resolveTemplateIdForEvidence(
      "evidence-seed-only",
      prisma as never,
    );
    expect(res).toEqual({ templateId: null, source: "direct" });
    // Both lookups attempted (workspace + global).
    expect(prisma.evidenceWorkflowTemplate.findFirst).toHaveBeenCalledTimes(2);
    // Trio said "I am the truth, the slug is seed-only" — legacy joins
    // must NOT run.
    expect(
      prisma.evidenceWorkflowInstanceEvidence.findFirst,
    ).not.toHaveBeenCalled();
    expect(prisma.workflowIntakeSession.findUnique).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Legacy fallback — workflow row with all-NULL trio (pre-Phase-4 row)
// ---------------------------------------------------------------------------

describe("resolveTemplateIdForEvidence — legacy fallback when trio is NULL", () => {
  it("falls back to workflow_instance discovery when trio is all NULL", async () => {
    const prisma = makePrismaStub({
      evidenceReviewWorkflow: {
        findUnique: vi.fn().mockResolvedValue({
          templateDbId: null,
          templateSlug: null,
          teamId: "team-1",
        }),
      },
      evidenceWorkflowInstanceEvidence: {
        findFirst: vi.fn().mockResolvedValue({
          id: "link-legacy",
          instance: { templateId: "tpl-from-legacy-instance" },
        }),
      },
    });
    const res = await resolveTemplateIdForEvidence(
      "evidence-legacy-1",
      prisma as never,
    );
    expect(res).toEqual({
      templateId: "tpl-from-legacy-instance",
      source: "workflow_instance",
    });
    // Direct path read happened but produced no trio.
    expect(prisma.evidenceReviewWorkflow.findUnique).toHaveBeenCalled();
    // Legacy path 1 took over.
    expect(
      prisma.evidenceWorkflowInstanceEvidence.findFirst,
    ).toHaveBeenCalled();
    // Path 2 unnecessary because path 1 produced a UUID.
    expect(prisma.workflowIntakeSession.findUnique).not.toHaveBeenCalled();
  });

  it("falls back to intake_link discovery when trio NULL and instance has no template", async () => {
    const prisma = makePrismaStub({
      evidenceReviewWorkflow: {
        findUnique: vi.fn().mockResolvedValue({
          templateDbId: null,
          templateSlug: null,
          teamId: null,
        }),
      },
      evidenceWorkflowInstanceEvidence: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      workflowIntakeSession: {
        findUnique: vi.fn().mockResolvedValue({
          intakeLink: { workflowTemplateId: "tpl-from-legacy-intake" },
        }),
      },
    });
    const res = await resolveTemplateIdForEvidence(
      "evidence-legacy-2",
      prisma as never,
    );
    expect(res).toEqual({
      templateId: "tpl-from-legacy-intake",
      source: "intake_link",
    });
  });

  it("falls back to legacy discovery when the workflow row itself is missing", async () => {
    const prisma = makePrismaStub({
      // Workflow row may not yet exist for the evidence (corner case for
      // very early reads). The resolver still has to try legacy joins.
      evidenceReviewWorkflow: { findUnique: vi.fn().mockResolvedValue(null) },
      evidenceWorkflowInstanceEvidence: {
        findFirst: vi.fn().mockResolvedValue({
          id: "link-orphan",
          instance: { templateId: "tpl-orphan" },
        }),
      },
    });
    const res = await resolveTemplateIdForEvidence(
      "evidence-orphan",
      prisma as never,
    );
    expect(res).toEqual({
      templateId: "tpl-orphan",
      source: "workflow_instance",
    });
  });

  it("returns source:'none' when trio NULL and both legacy paths are empty", async () => {
    const prisma = makePrismaStub({
      evidenceReviewWorkflow: {
        findUnique: vi.fn().mockResolvedValue({
          templateDbId: null,
          templateSlug: null,
          teamId: null,
        }),
      },
    });
    const res = await resolveTemplateIdForEvidence(
      "evidence-none",
      prisma as never,
    );
    expect(res).toEqual({ templateId: null, source: "none" });
  });
});

// ---------------------------------------------------------------------------
// Direct-path failure semantics
// ---------------------------------------------------------------------------

describe("resolveTemplateIdForEvidence — direct-path failure", () => {
  it("returns source:'error' when the workflow read throws; legacy joins are NOT attempted", async () => {
    const prisma = makePrismaStub({
      evidenceReviewWorkflow: {
        findUnique: vi
          .fn()
          .mockRejectedValue(new Error("simulated db connection drop")),
      },
    });
    const res = await resolveTemplateIdForEvidence(
      "evidence-direct-throw",
      prisma as never,
    );
    expect(res).toEqual({ templateId: null, source: "error" });
    // Hard rule: a direct-path failure must short-circuit so the caller
    // falls back to baseline deterministically; legacy joins MUST NOT run.
    expect(
      prisma.evidenceWorkflowInstanceEvidence.findFirst,
    ).not.toHaveBeenCalled();
    expect(prisma.workflowIntakeSession.findUnique).not.toHaveBeenCalled();
  });

  it("returns source:'error' when the slug→DB lookup throws", async () => {
    const prisma = makePrismaStub({
      evidenceReviewWorkflow: {
        findUnique: vi.fn().mockResolvedValue({
          templateDbId: null,
          templateSlug: "incident-report",
          teamId: "team-1",
        }),
      },
      evidenceWorkflowTemplate: {
        findFirst: vi.fn().mockRejectedValue(new Error("db boom")),
      },
    });
    const res = await resolveTemplateIdForEvidence(
      "evidence-slug-throw",
      prisma as never,
    );
    expect(res).toEqual({ templateId: null, source: "error" });
    // Direct-path failure also stops legacy joins.
    expect(
      prisma.evidenceWorkflowInstanceEvidence.findFirst,
    ).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Source-text contract — pin the implementation shape independent of
// execution coverage. Mirrors the Phase R wiring guard.
// ---------------------------------------------------------------------------

describe("resolveTemplateIdForEvidence — Phase T direct-path source guard", () => {
  const src = readFileSync(
    join(
      __dirname,
      "..",
      "src",
      "services",
      "reviewer-ops",
      "reviewer-operations-engine.service.ts",
    ),
    "utf8",
  );

  it("reads the direct trio columns from EvidenceReviewWorkflow first", () => {
    expect(src).toMatch(
      /evidenceReviewWorkflow\.findUnique[\s\S]*?templateDbId:\s*true[\s\S]*?templateSlug:\s*true[\s\S]*?teamId:\s*true/,
    );
  });

  it("returns source:'direct' for the new column path", () => {
    expect(src).toMatch(/source:\s*"direct"/);
  });

  it("uses (slug, teamId, archived:false) for the slug→DB lookup, matching the workflow-intake-link pattern", () => {
    expect(src).toMatch(
      /evidenceWorkflowTemplate\.findFirst[\s\S]*?slug[\s\S]*?archived:\s*false/,
    );
  });

  it("retains the legacy workflow_instance + intake_link discovery paths as fallback", () => {
    expect(src).toMatch(/evidenceWorkflowInstanceEvidence\.findFirst/);
    expect(src).toMatch(/workflowIntakeSession\.findUnique/);
    expect(src).toMatch(/source:\s*"workflow_instance"/);
    expect(src).toMatch(/source:\s*"intake_link"/);
  });

  it("lists the direct-path read before either legacy join", () => {
    const directIdx = src.indexOf("evidenceReviewWorkflow.findUnique");
    const instanceIdx = src.indexOf(
      "evidenceWorkflowInstanceEvidence.findFirst",
    );
    const intakeIdx = src.indexOf("workflowIntakeSession.findUnique");
    expect(directIdx).toBeGreaterThan(-1);
    expect(instanceIdx).toBeGreaterThan(directIdx);
    expect(intakeIdx).toBeGreaterThan(directIdx);
  });

  it("wraps the direct-path read in try/catch with a structured warn log", () => {
    expect(src).toMatch(
      /try\s*{[\s\S]*?evidenceReviewWorkflow\.findUnique[\s\S]*?}\s*catch[\s\S]*?reviewer_ops\.sla_template_resolve_failed[\s\S]*?stage:\s*"direct"/,
    );
  });
});
