/**
 * Phase 5 — Workflow template `exportPolicyJson` overlay.
 *
 * Phase 1 inventory found `EvidenceWorkflowTemplate.exportPolicyJson` was
 * a writable, validated, persisted field with ZERO production consumers.
 * Report / verification-package / public-verify generation and download
 * paths all ignored it. Phase 5 wires it into the existing
 * `enforceSensitiveAction` gate without inventing a new enforcement
 * layer.
 *
 * These tests pin the contract:
 *
 *   1. Pure overlay function (`evaluateTemplateExportOverlay`):
 *        - null policy → allow.
 *        - allowReportPdf=false → blocks generate_report + download_report.
 *        - allowVerificationPackage=false → blocks generate_package +
 *          download_package.
 *        - allowPublicVerify=false → blocks publish_public_verify.
 *        - allowedDownloaderRoles tightens download_* actions but not
 *          generate_* actions.
 *        - empty allowedDownloaderRoles → no role restriction.
 *
 *   2. Loader (`loadTemplateExportPolicy`):
 *        - null/undefined templateId → null.
 *        - missing row → null.
 *        - row with null exportPolicyJson → null.
 *        - row with invalid shape → null (fail-safe).
 *        - row with valid shape → parsed policy.
 *        - prisma.findUnique throws → null (NEVER throws).
 *
 *   3. enforceSensitiveAction integration:
 *        - existing workspace decision unchanged when no templateId.
 *        - workspace allow + template deny → final decision is denied
 *          with TEMPLATE-prefixed code.
 *        - workspace deny → template overlay does NOT fire (workspace
 *          decision stands; overlay can only tighten, not enable).
 *        - template lookup throws → existing workspace decision wins
 *          (fail-safe: template resolution failure must never block).
 */

import { describe, expect, it, vi } from "vitest";

import {
  evaluateTemplateExportOverlay,
  loadTemplateExportPolicy,
  type TemplateExportAction,
} from "../src/services/governance/template-export-policy.service.js";
import { enforceSensitiveAction } from "../src/services/governance.service.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

import type { WorkflowExportPolicy } from "@proovra/shared";

const STRICT_POLICY: WorkflowExportPolicy = {
  allowPublicVerify: false,
  allowReportPdf: false,
  allowVerificationPackage: false,
  watermark: null,
  allowedDownloaderRoles: [],
};

const PERMISSIVE_POLICY: WorkflowExportPolicy = {
  allowPublicVerify: true,
  allowReportPdf: true,
  allowVerificationPackage: true,
  watermark: null,
  allowedDownloaderRoles: [],
};

const ADMIN_ONLY_POLICY: WorkflowExportPolicy = {
  allowPublicVerify: true,
  allowReportPdf: true,
  allowVerificationPackage: true,
  watermark: null,
  allowedDownloaderRoles: ["OWNER", "ADMIN"],
};

type PrismaStub = {
  evidenceWorkflowTemplate: { findUnique: ReturnType<typeof vi.fn> };
  workspaceGovernancePolicy: { findUnique: ReturnType<typeof vi.fn> };
};

function makePrismaStub(overrides: Partial<PrismaStub> = {}): PrismaStub {
  return {
    evidenceWorkflowTemplate: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    workspaceGovernancePolicy: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    ...overrides,
  } as PrismaStub;
}

// ---------------------------------------------------------------------------
// 1 — Pure overlay function
// ---------------------------------------------------------------------------

describe("evaluateTemplateExportOverlay — pure decision", () => {
  it("returns allow when no policy is supplied", () => {
    for (const action of [
      "generate_report",
      "download_report",
      "generate_package",
      "download_package",
      "publish_public_verify",
    ] as TemplateExportAction[]) {
      const res = evaluateTemplateExportOverlay({
        action,
        role: "MEMBER",
        policy: null,
      });
      expect(res).toEqual({ allowed: true });
    }
  });

  it("permissive policy allows every action for every role", () => {
    for (const action of [
      "generate_report",
      "download_report",
      "generate_package",
      "download_package",
      "publish_public_verify",
    ] as TemplateExportAction[]) {
      for (const role of ["OWNER", "ADMIN", "MEMBER", "VIEWER"] as const) {
        const res = evaluateTemplateExportOverlay({
          action,
          role,
          policy: PERMISSIVE_POLICY,
        });
        expect(res).toEqual({ allowed: true });
      }
    }
  });

  it("allowReportPdf=false blocks generate_report and download_report", () => {
    const policy = { ...PERMISSIVE_POLICY, allowReportPdf: false };
    const gen = evaluateTemplateExportOverlay({
      action: "generate_report",
      role: "OWNER",
      policy,
    });
    expect(gen.allowed).toBe(false);
    if (!gen.allowed) {
      expect(gen.code).toBe("REPORT_BLOCKED_BY_TEMPLATE_POLICY");
      expect(gen.reason).toBe("report_disabled_by_template_policy");
    }
    const dl = evaluateTemplateExportOverlay({
      action: "download_report",
      role: "OWNER",
      policy,
    });
    expect(dl.allowed).toBe(false);
    if (!dl.allowed) {
      expect(dl.code).toBe("REPORT_BLOCKED_BY_TEMPLATE_POLICY");
    }
    // Sanity: package + public verify untouched.
    expect(
      evaluateTemplateExportOverlay({
        action: "generate_package",
        role: "OWNER",
        policy,
      }),
    ).toEqual({ allowed: true });
    expect(
      evaluateTemplateExportOverlay({
        action: "publish_public_verify",
        role: "OWNER",
        policy,
      }),
    ).toEqual({ allowed: true });
  });

  it("allowVerificationPackage=false blocks generate_package and download_package", () => {
    const policy = {
      ...PERMISSIVE_POLICY,
      allowVerificationPackage: false,
    };
    const gen = evaluateTemplateExportOverlay({
      action: "generate_package",
      role: "OWNER",
      policy,
    });
    expect(gen.allowed).toBe(false);
    if (!gen.allowed) {
      expect(gen.code).toBe("PACKAGE_BLOCKED_BY_TEMPLATE_POLICY");
      expect(gen.reason).toBe("verification_package_disabled_by_template_policy");
    }
    const dl = evaluateTemplateExportOverlay({
      action: "download_package",
      role: "OWNER",
      policy,
    });
    expect(dl.allowed).toBe(false);
  });

  it("allowPublicVerify=false blocks publish_public_verify only", () => {
    const policy = { ...PERMISSIVE_POLICY, allowPublicVerify: false };
    const pub = evaluateTemplateExportOverlay({
      action: "publish_public_verify",
      role: "OWNER",
      policy,
    });
    expect(pub.allowed).toBe(false);
    if (!pub.allowed) {
      expect(pub.code).toBe("PUBLIC_VERIFY_BLOCKED_BY_TEMPLATE_POLICY");
    }
    // Generation actions still allowed.
    expect(
      evaluateTemplateExportOverlay({
        action: "generate_report",
        role: "OWNER",
        policy,
      }),
    ).toEqual({ allowed: true });
  });

  it("strict policy blocks every gated action", () => {
    for (const action of [
      "generate_report",
      "download_report",
      "generate_package",
      "download_package",
      "publish_public_verify",
    ] as TemplateExportAction[]) {
      const res = evaluateTemplateExportOverlay({
        action,
        role: "OWNER",
        policy: STRICT_POLICY,
      });
      expect(res.allowed).toBe(false);
    }
  });

  it("allowedDownloaderRoles tightens download_* but does NOT bind generate_*", () => {
    // MEMBER is excluded from ADMIN_ONLY_POLICY.allowedDownloaderRoles.
    const memberDownload = evaluateTemplateExportOverlay({
      action: "download_report",
      role: "MEMBER",
      policy: ADMIN_ONLY_POLICY,
    });
    expect(memberDownload.allowed).toBe(false);
    if (!memberDownload.allowed) {
      expect(memberDownload.code).toBe("REPORT_BLOCKED_BY_TEMPLATE_POLICY");
      expect(memberDownload.reason).toContain("MEMBER");
      expect(memberDownload.reason).toContain(
        "not_in_template_allowed_downloader_roles",
      );
    }

    // MEMBER may still trigger generation — only the download is gated.
    expect(
      evaluateTemplateExportOverlay({
        action: "generate_report",
        role: "MEMBER",
        policy: ADMIN_ONLY_POLICY,
      }),
    ).toEqual({ allowed: true });
    expect(
      evaluateTemplateExportOverlay({
        action: "generate_package",
        role: "MEMBER",
        policy: ADMIN_ONLY_POLICY,
      }),
    ).toEqual({ allowed: true });

    // OWNER (in the allowed list) downloads fine.
    expect(
      evaluateTemplateExportOverlay({
        action: "download_report",
        role: "OWNER",
        policy: ADMIN_ONLY_POLICY,
      }),
    ).toEqual({ allowed: true });
  });

  it("empty allowedDownloaderRoles preserves baseline (no role restriction)", () => {
    // PERMISSIVE_POLICY has allowedDownloaderRoles: [] — every role
    // should pass.
    for (const role of ["OWNER", "ADMIN", "MEMBER", "VIEWER"] as const) {
      expect(
        evaluateTemplateExportOverlay({
          action: "download_report",
          role,
          policy: PERMISSIVE_POLICY,
        }),
      ).toEqual({ allowed: true });
      expect(
        evaluateTemplateExportOverlay({
          action: "download_package",
          role,
          policy: PERMISSIVE_POLICY,
        }),
      ).toEqual({ allowed: true });
    }
  });

  it("null role with non-empty allowedDownloaderRoles passes the role gate (workspace decision already gated on permission)", () => {
    // A null role means no membership — the workspace decision already
    // failed (caught by perm check). The overlay should not invent a
    // restriction the workspace did not. Effectively: if workspace let
    // a null-role caller through (e.g. for generate_*, which has no
    // download path), the template overlay must not invent one.
    const res = evaluateTemplateExportOverlay({
      action: "download_report",
      role: null,
      policy: ADMIN_ONLY_POLICY,
    });
    expect(res).toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------
// 2 — loadTemplateExportPolicy: loader + fail-safety
// ---------------------------------------------------------------------------

describe("loadTemplateExportPolicy — loader and fail-safety", () => {
  it("returns null when templateId is null or undefined", async () => {
    const prisma = makePrismaStub();
    expect(await loadTemplateExportPolicy(null, prisma as never)).toBeNull();
    expect(await loadTemplateExportPolicy(undefined, prisma as never)).toBeNull();
    // No DB call.
    expect(
      prisma.evidenceWorkflowTemplate.findUnique,
    ).not.toHaveBeenCalled();
  });

  it("returns null when no row exists for the id", async () => {
    const prisma = makePrismaStub();
    expect(
      await loadTemplateExportPolicy("tpl-1", prisma as never),
    ).toBeNull();
  });

  it("returns null when the row has a null exportPolicyJson", async () => {
    const prisma = makePrismaStub({
      evidenceWorkflowTemplate: {
        findUnique: vi.fn().mockResolvedValue({ exportPolicyJson: null }),
      },
    });
    expect(
      await loadTemplateExportPolicy("tpl-2", prisma as never),
    ).toBeNull();
  });

  it("returns null when the row has a structurally invalid exportPolicyJson", async () => {
    const prisma = makePrismaStub({
      evidenceWorkflowTemplate: {
        findUnique: vi.fn().mockResolvedValue({
          exportPolicyJson: { allowReportPdf: "not-a-bool", what: 42 },
        }),
      },
    });
    expect(
      await loadTemplateExportPolicy("tpl-3", prisma as never),
    ).toBeNull();
  });

  it("returns the parsed policy when the row is well-formed", async () => {
    const prisma = makePrismaStub({
      evidenceWorkflowTemplate: {
        findUnique: vi.fn().mockResolvedValue({
          exportPolicyJson: {
            allowPublicVerify: false,
            allowReportPdf: true,
            allowVerificationPackage: false,
            watermark: "CONFIDENTIAL",
            allowedDownloaderRoles: ["OWNER", "ADMIN"],
          },
        }),
      },
    });
    const policy = await loadTemplateExportPolicy("tpl-4", prisma as never);
    expect(policy).toEqual({
      allowPublicVerify: false,
      allowReportPdf: true,
      allowVerificationPackage: false,
      watermark: "CONFIDENTIAL",
      allowedDownloaderRoles: ["OWNER", "ADMIN"],
    });
  });

  it("returns null and NEVER throws when prisma.findUnique throws", async () => {
    const prisma = makePrismaStub({
      evidenceWorkflowTemplate: {
        findUnique: vi
          .fn()
          .mockRejectedValue(new Error("simulated db connection drop")),
      },
    });
    // Crucial: the loader must not propagate the error. A template
    // resolution failure must never break the export lifecycle.
    const res = await loadTemplateExportPolicy("tpl-5", prisma as never);
    expect(res).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3 — enforceSensitiveAction integration: overlay only tightens, never
//     enables, and a template-resolution failure is fail-safe.
// ---------------------------------------------------------------------------

describe("enforceSensitiveAction — Phase 5 export policy overlay", () => {
  // The full enforcer needs the workspace-policy loader + (when the
  // overlay opts in) the template-id resolver + the template loader.
  // We stub all three on a single prisma-like object.
  type FullPrismaStub = PrismaStub & {
    evidenceWorkflowInstanceEvidence: { findFirst: ReturnType<typeof vi.fn> };
    workflowIntakeSession: { findUnique: ReturnType<typeof vi.fn> };
  };

  function fullStub(opts: {
    workspaceRow?: Record<string, unknown> | null;
    templateRow?: { exportPolicyJson: unknown } | null;
    templateThrows?: boolean;
    /** Defaults to a templateId resolved via the workflow_instance join. */
    resolvedTemplateId?: string | null;
    /** When true, the template-id resolver itself throws. */
    resolveThrows?: boolean;
  }): FullPrismaStub {
    const templateId =
      opts.resolvedTemplateId === undefined ? "tpl-x" : opts.resolvedTemplateId;
    return {
      // Phase T — direct trio columns on the workflow row are NULL in
      // these tests, so the resolver falls through to legacy discovery
      // (the original workflow_instance / intake_link paths) exactly
      // as before. This preserves the pre-Phase-T contract of these
      // tests verbatim.
      evidenceReviewWorkflow: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      evidenceWorkflowInstanceEvidence: {
        findFirst: opts.resolveThrows
          ? vi.fn().mockRejectedValue(new Error("simulated resolver db error"))
          : vi
              .fn()
              .mockResolvedValue(
                templateId
                  ? { id: "link-1", instance: { templateId } }
                  : null,
              ),
      },
      workflowIntakeSession: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      evidenceWorkflowTemplate: {
        findUnique: opts.templateThrows
          ? vi.fn().mockRejectedValue(new Error("simulated template db error"))
          : vi.fn().mockResolvedValue(opts.templateRow ?? null),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      workspaceGovernancePolicy: {
        findUnique: vi.fn().mockResolvedValue(opts.workspaceRow ?? null),
      },
    } as FullPrismaStub;
  }

  const baseCtx = {
    teamId: "team-1",
    role: "OWNER" as const,
    evidence: {
      id: "evidence-1",
      teamId: "team-1",
      retentionUntilUtc: null,
    },
  };

  it("baseline: existing workspace decision unchanged when consultTemplatePolicy is omitted", async () => {
    // Default workspace policy is permissive (DEFAULT_POLICY). No
    // opt-in → no overlay. download_report should pass.
    const prisma = fullStub({});
    const decision = await enforceSensitiveAction(
      "download_report",
      baseCtx,
      prisma as never,
    );
    expect(decision).toEqual({ allowed: true });
    // Template resolver + loader must NOT have been called.
    expect(
      prisma.evidenceWorkflowInstanceEvidence.findFirst,
    ).not.toHaveBeenCalled();
    expect(
      prisma.evidenceWorkflowTemplate.findUnique,
    ).not.toHaveBeenCalled();
  });

  it("workspace allow + template deny → final decision is denied (overlay tightens)", async () => {
    const prisma = fullStub({
      templateRow: {
        exportPolicyJson: {
          ...PERMISSIVE_POLICY,
          allowReportPdf: false,
        },
      },
    });
    const decision = await enforceSensitiveAction(
      "download_report",
      { ...baseCtx, consultTemplatePolicy: true },
      prisma as never,
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe("REPORT_BLOCKED_BY_TEMPLATE_POLICY");
    }
  });

  it("workspace allow + template deny on package → blocks download_package", async () => {
    const prisma = fullStub({
      templateRow: {
        exportPolicyJson: {
          ...PERMISSIVE_POLICY,
          allowVerificationPackage: false,
        },
      },
    });
    const decision = await enforceSensitiveAction(
      "download_package",
      { ...baseCtx, consultTemplatePolicy: true },
      prisma as never,
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe("PACKAGE_BLOCKED_BY_TEMPLATE_POLICY");
    }
  });

  it("workspace allow + template publish_public_verify deny → blocks publish_public_verify", async () => {
    const prisma = fullStub({
      templateRow: {
        exportPolicyJson: {
          ...PERMISSIVE_POLICY,
          allowPublicVerify: false,
        },
      },
    });
    const decision = await enforceSensitiveAction(
      "publish_public_verify",
      { ...baseCtx, consultTemplatePolicy: true },
      prisma as never,
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe("PUBLIC_VERIFY_BLOCKED_BY_TEMPLATE_POLICY");
    }
  });

  it("workspace deny → template overlay is NOT consulted (overlay can only tighten)", async () => {
    // Force a workspace deny via the report download policy flag.
    const prisma = fullStub({
      workspaceRow: {
        allowReportDownload: false,
        allowPackageDownload: true,
        allowOriginalDownload: true,
        allowPublicVerify: true,
        allowExternalIntake: true,
        allowAnonymousIntake: true,
        evidenceDeletionMode: "ALLOWED",
        requireLegalHoldApprovalForDeletion: false,
        requireReviewBeforeReport: false,
        requireReviewBeforePackage: false,
        requireReviewBeforePublicVerify: false,
        defaultRetentionDays: null,
        defaultReviewDueHours: null,
        defaultFirstResponseDueHours: null,
        defaultEscalationDueHours: null,
        requirePublicationApproval: false,
        requireLegalHoldReleaseApproval: false,
        defaultAssignmentDueHours: null,
        defaultCompletionDueHours: null,
        defaultDueSoonHours: null,
        requireStepUpForApprove: false,
        requireStepUpForReject: false,
        requireStepUpForEscalationResolve: false,
        requireStepUpForBulk: false,
        reviewerInactivityHours: null,
        metadataRedactionDefault: null,
      },
      // Even with a permissive template policy that would "enable"
      // report download, the workspace deny must hold.
      templateRow: { exportPolicyJson: PERMISSIVE_POLICY },
    });
    const decision = await enforceSensitiveAction(
      "download_report",
      { ...baseCtx, consultTemplatePolicy: true },
      prisma as never,
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      // The code is the workspace code, NOT a template code — proves
      // the overlay never fires when workspace already denied.
      expect(decision.code).toBe("REPORT_BLOCKED_BY_POLICY");
    }
    // Neither the resolver nor the template loader should have been
    // called — the overlay short-circuits on workspace deny.
    expect(
      prisma.evidenceWorkflowInstanceEvidence.findFirst,
    ).not.toHaveBeenCalled();
    expect(
      prisma.evidenceWorkflowTemplate.findUnique,
    ).not.toHaveBeenCalled();
  });

  it("template lookup throws → workspace decision wins (fail-safe)", async () => {
    // Workspace policy is permissive (allows). The template loader is
    // wired to throw. Because the loader is fail-safe (returns null on
    // error), the overlay degrades to "no policy" and the workspace
    // allow stands.
    const prisma = fullStub({
      templateThrows: true,
    });
    const decision = await enforceSensitiveAction(
      "download_report",
      { ...baseCtx, consultTemplatePolicy: true },
      prisma as never,
    );
    expect(decision).toEqual({ allowed: true });
  });

  it("template-id resolver throws → workspace decision wins (fail-safe)", async () => {
    // The resolver itself blows up. The enforcer must swallow the
    // error and return the workspace decision unchanged.
    const prisma = fullStub({
      resolveThrows: true,
    });
    const decision = await enforceSensitiveAction(
      "download_report",
      { ...baseCtx, consultTemplatePolicy: true },
      prisma as never,
    );
    expect(decision).toEqual({ allowed: true });
  });

  it("no resolvable templateId → workspace decision wins (preserves hardcoded baseline)", async () => {
    // No row at the instance join; no intake-session match either.
    // The overlay has nothing to apply. Workspace permissive default
    // still allows download_report.
    const prisma = fullStub({
      resolvedTemplateId: null,
    });
    const decision = await enforceSensitiveAction(
      "download_report",
      { ...baseCtx, consultTemplatePolicy: true },
      prisma as never,
    );
    expect(decision).toEqual({ allowed: true });
    // The template-row loader is never reached when no templateId
    // resolved.
    expect(
      prisma.evidenceWorkflowTemplate.findUnique,
    ).not.toHaveBeenCalled();
  });
});
