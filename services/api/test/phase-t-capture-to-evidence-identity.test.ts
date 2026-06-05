/**
 * Phase T — Capture-to-Evidence template identity propagation.
 *
 * Asserts the propagation contract added in Phase T:
 *
 *   1. resolveTemplateTrioForCaptureSession returns {slug, version, dbId?}
 *      reading the CaptureSession's templateId (slug) + templateVersion.
 *   2. When a DB-backed EvidenceWorkflowTemplate row matches the slug for
 *      the workspace, templateDbId is populated. When only a platform
 *      seed matches, templateDbId stays null but slug + version remain.
 *   3. resolveTemplateTrioForCaptureSession returns the empty trio on
 *      every failure path — missing id, missing session, missing slug,
 *      thrown error from prisma — and NEVER throws.
 *   4. resolveTemplateTrioForIntakeLink honours the link snapshot
 *      verbatim and only falls back to slug-based dbId lookup when the
 *      link's stored workflowTemplateId is null.
 *   5. templateIdentityAuditMetadata returns a bounded, deterministic
 *      payload suitable for appendPlatformAuditLog. No PII or bytes.
 *   6. evidence.routes.ts wires the resolver + audit emission into the
 *      capture-finalize path (POST /v1/evidence) inside a try/catch and
 *      uses the canonical action name "evidence.template_identity.stamped"
 *      with source: "capture".
 *   7. external-intake-orchestration.service.ts stamps the trio onto
 *      Evidence inside createOrLoadExternalEvidence, sourced from the
 *      WorkflowIntakeLink, with source: "external_intake".
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EMPTY_TEMPLATE_IDENTITY_TRIO,
  resolveTemplateDbIdForSlug,
  resolveTemplateTrioForCaptureSession,
  resolveTemplateTrioForIntakeLink,
  templateIdentityAuditMetadata,
} from "../src/services/templates/identity-resolver.service.js";

// ---------------------------------------------------------------------------
// Fixture factory — minimal client shape that the resolver actually touches.
// ---------------------------------------------------------------------------

type CaptureSessionRow = {
  id: string;
  templateId: string | null;
  templateVersion: number | null;
};

type TemplateRow = {
  id: string;
  slug: string;
  teamId: string | null;
  version: number;
  archived: boolean;
  name: string;
  description: string;
  workspaceCategory: string | null;
  planMode: string;
  locationRequirement: string;
  intakeModes: string[];
  allowedRoles: string[];
  stepsJson: unknown;
  rulesJson: unknown;
  visibilityPolicyJson: unknown;
  reviewPolicyJson: unknown;
  exportPolicyJson: unknown;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

function makeTemplateRow(overrides: Partial<TemplateRow> = {}): TemplateRow {
  return {
    id: overrides.id ?? "00000000-0000-0000-0000-00000000aaaa",
    slug: overrides.slug ?? "general-evidence-record",
    teamId: overrides.teamId ?? null,
    version: overrides.version ?? 2,
    archived: overrides.archived ?? false,
    name: overrides.name ?? "General Evidence Record",
    description: overrides.description ?? "Balanced intake.",
    workspaceCategory: overrides.workspaceCategory ?? null,
    planMode: overrides.planMode ?? "FLEXIBLE",
    locationRequirement: overrides.locationRequirement ?? "recommended",
    intakeModes: overrides.intakeModes ?? ["AUTHENTICATED_STANDARD"],
    allowedRoles: overrides.allowedRoles ?? [],
    stepsJson:
      overrides.stepsJson ??
      [
        {
          id: "primary_evidence",
          title: "Primary evidence file",
          description: "Upload.",
          purposeLabel: "Primary evidence",
          required: true,
          acceptedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
        },
      ],
    rulesJson: overrides.rulesJson ?? null,
    visibilityPolicyJson: overrides.visibilityPolicyJson ?? null,
    reviewPolicyJson: overrides.reviewPolicyJson ?? null,
    exportPolicyJson: overrides.exportPolicyJson ?? null,
    createdByUserId: overrides.createdByUserId ?? null,
    updatedByUserId: overrides.updatedByUserId ?? null,
    status: overrides.status ?? "ACTIVE",
    createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-01-01T00:00:00Z"),
  };
}

function makeFakeClient(opts: {
  sessions?: Record<string, CaptureSessionRow>;
  workspaceRows?: TemplateRow[];
  globalRows?: TemplateRow[];
  sessionLookupThrows?: boolean;
  templateLookupThrows?: boolean;
}) {
  const sessions = opts.sessions ?? {};
  const workspaceRows = opts.workspaceRows ?? [];
  const globalRows = opts.globalRows ?? [];

  return {
    captureSession: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        if (opts.sessionLookupThrows) {
          throw new Error("BOOM_SESSION");
        }
        return sessions[where.id] ?? null;
      },
    },
    evidenceWorkflowTemplate: {
      findMany: async ({ where }: { where: { teamId: string | null; archived?: boolean } }) => {
        if (opts.templateLookupThrows) {
          throw new Error("BOOM_TEMPLATE");
        }
        if (where.teamId === null) return globalRows;
        return workspaceRows.filter((row) => row.teamId === where.teamId);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 1-3. resolveTemplateTrioForCaptureSession
// ---------------------------------------------------------------------------

describe("Phase T — resolveTemplateTrioForCaptureSession", () => {
  it("returns the empty trio when captureSessionId is missing", async () => {
    const trio = await resolveTemplateTrioForCaptureSession({
      captureSessionId: null,
    });
    expect(trio).toEqual(EMPTY_TEMPLATE_IDENTITY_TRIO);
  });

  it("returns the empty trio when the session row is not found", async () => {
    const client = makeFakeClient({ sessions: {} });
    const trio = await resolveTemplateTrioForCaptureSession({
      captureSessionId: "11111111-1111-1111-1111-111111111111",
      client: client as never,
    });
    expect(trio).toEqual(EMPTY_TEMPLATE_IDENTITY_TRIO);
  });

  it("returns the empty trio when the session has no templateId", async () => {
    const client = makeFakeClient({
      sessions: {
        "11111111-1111-1111-1111-111111111111": {
          id: "11111111-1111-1111-1111-111111111111",
          templateId: null,
          templateVersion: null,
        },
      },
    });
    const trio = await resolveTemplateTrioForCaptureSession({
      captureSessionId: "11111111-1111-1111-1111-111111111111",
      client: client as never,
    });
    expect(trio).toEqual(EMPTY_TEMPLATE_IDENTITY_TRIO);
  });

  it("populates slug + version from a session even when only the seed exists (templateDbId stays null)", async () => {
    // No DB rows — only the in-code seeds. The lookup runs against the
    // workflow-template service which lifts seeds. For a seed-only slug
    // dbId must remain null.
    const client = makeFakeClient({
      sessions: {
        "22222222-2222-2222-2222-222222222222": {
          id: "22222222-2222-2222-2222-222222222222",
          templateId: "general-evidence-record",
          templateVersion: 1,
        },
      },
    });
    const trio = await resolveTemplateTrioForCaptureSession({
      captureSessionId: "22222222-2222-2222-2222-222222222222",
      teamId: null,
      client: client as never,
    });
    expect(trio.templateSlug).toBe("general-evidence-record");
    expect(trio.templateVersion).toBe(1);
    expect(trio.templateDbId).toBeNull();
  });

  it("populates templateDbId when a workspace-DB row matches the slug", async () => {
    const teamId = "33333333-3333-3333-3333-333333333333";
    const dbId = "99999999-9999-9999-9999-999999999999";
    const client = makeFakeClient({
      sessions: {
        "44444444-4444-4444-4444-444444444444": {
          id: "44444444-4444-4444-4444-444444444444",
          templateId: "general-evidence-record",
          templateVersion: 7,
        },
      },
      workspaceRows: [
        makeTemplateRow({
          id: dbId,
          slug: "general-evidence-record",
          teamId,
          version: 7,
        }),
      ],
    });
    const trio = await resolveTemplateTrioForCaptureSession({
      captureSessionId: "44444444-4444-4444-4444-444444444444",
      teamId,
      client: client as never,
    });
    expect(trio.templateSlug).toBe("general-evidence-record");
    expect(trio.templateVersion).toBe(7);
    expect(trio.templateDbId).toBe(dbId);
  });

  it("never throws — a resolver error returns the empty trio", async () => {
    const client = makeFakeClient({ sessionLookupThrows: true });
    const trio = await resolveTemplateTrioForCaptureSession({
      captureSessionId: "55555555-5555-5555-5555-555555555555",
      client: client as never,
    });
    expect(trio).toEqual(EMPTY_TEMPLATE_IDENTITY_TRIO);
  });

  it("never throws — a template-lookup error still returns slug + version", async () => {
    const client = makeFakeClient({
      sessions: {
        "66666666-6666-6666-6666-666666666666": {
          id: "66666666-6666-6666-6666-666666666666",
          templateId: "general-evidence-record",
          templateVersion: 1,
        },
      },
      templateLookupThrows: true,
    });
    const trio = await resolveTemplateTrioForCaptureSession({
      captureSessionId: "66666666-6666-6666-6666-666666666666",
      teamId: null,
      client: client as never,
    });
    // slug + version came from the session row before the template
    // lookup ran, so they survive a template-DB outage. dbId stays null.
    expect(trio.templateSlug).toBe("general-evidence-record");
    expect(trio.templateVersion).toBe(1);
    expect(trio.templateDbId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. resolveTemplateTrioForIntakeLink
// ---------------------------------------------------------------------------

describe("Phase T — resolveTemplateTrioForIntakeLink", () => {
  it("returns the empty trio when the link has no slug", async () => {
    const trio = await resolveTemplateTrioForIntakeLink({
      link: {
        workflowTemplateId: null,
        workflowTemplateSlug: null,
        workflowTemplateVersion: null,
        teamId: null,
      },
    });
    expect(trio).toEqual(EMPTY_TEMPLATE_IDENTITY_TRIO);
  });

  it("honours the link snapshot verbatim when workflowTemplateId is present", async () => {
    const dbId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const trio = await resolveTemplateTrioForIntakeLink({
      link: {
        workflowTemplateId: dbId,
        workflowTemplateSlug: "legal-matter",
        workflowTemplateVersion: 3,
        teamId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      },
      client: makeFakeClient({}) as never,
    });
    expect(trio.templateSlug).toBe("legal-matter");
    expect(trio.templateVersion).toBe(3);
    expect(trio.templateDbId).toBe(dbId);
  });

  it("falls back to slug-based dbId lookup when the link's id is null", async () => {
    const teamId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const dbId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const client = makeFakeClient({
      workspaceRows: [
        makeTemplateRow({
          id: dbId,
          slug: "legal-matter",
          teamId,
          version: 2,
        }),
      ],
    });
    const trio = await resolveTemplateTrioForIntakeLink({
      link: {
        workflowTemplateId: null,
        workflowTemplateSlug: "legal-matter",
        workflowTemplateVersion: 2,
        teamId,
      },
      client: client as never,
    });
    expect(trio.templateSlug).toBe("legal-matter");
    expect(trio.templateVersion).toBe(2);
    expect(trio.templateDbId).toBe(dbId);
  });

  it("returns slug + version with null dbId when the slug is seed-only", async () => {
    const trio = await resolveTemplateTrioForIntakeLink({
      link: {
        workflowTemplateId: null,
        workflowTemplateSlug: "legal-matter",
        workflowTemplateVersion: 1,
        teamId: null,
      },
      client: makeFakeClient({}) as never,
    });
    expect(trio.templateSlug).toBe("legal-matter");
    expect(trio.templateVersion).toBe(1);
    expect(trio.templateDbId).toBeNull();
  });

  it("never throws — any lookup error returns slug+version with null dbId", async () => {
    const trio = await resolveTemplateTrioForIntakeLink({
      link: {
        workflowTemplateId: null,
        workflowTemplateSlug: "legal-matter",
        workflowTemplateVersion: 1,
        teamId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      },
      client: makeFakeClient({ templateLookupThrows: true }) as never,
    });
    // The link-driven path keeps slug + version honest even when the
    // dbId lookup throws.
    expect(trio.templateSlug).toBe("legal-matter");
    expect(trio.templateVersion).toBe(1);
    expect(trio.templateDbId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveTemplateDbIdForSlug — slug-only edge cases
// ---------------------------------------------------------------------------

describe("Phase T — resolveTemplateDbIdForSlug", () => {
  it("returns null when slug is missing", async () => {
    const result = await resolveTemplateDbIdForSlug(null, null);
    expect(result).toBeNull();
  });

  it("returns null for a seed-only slug", async () => {
    const result = await resolveTemplateDbIdForSlug(
      "general-evidence-record",
      null,
      makeFakeClient({}) as never,
    );
    expect(result).toBeNull();
  });

  it("returns the DB id for a workspace-scoped match", async () => {
    const teamId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const dbId = "12121212-1212-1212-1212-121212121212";
    const client = makeFakeClient({
      workspaceRows: [
        makeTemplateRow({
          id: dbId,
          slug: "general-evidence-record",
          teamId,
        }),
      ],
    });
    const result = await resolveTemplateDbIdForSlug(
      "general-evidence-record",
      teamId,
      client as never,
    );
    expect(result).toBe(dbId);
  });
});

// ---------------------------------------------------------------------------
// 5. templateIdentityAuditMetadata
// ---------------------------------------------------------------------------

describe("Phase T — templateIdentityAuditMetadata", () => {
  it("returns a bounded, deterministic payload (no PII)", () => {
    const meta = templateIdentityAuditMetadata({
      evidenceId: "ev-1",
      source: "capture",
      trio: {
        templateSlug: "general-evidence-record",
        templateVersion: 7,
        templateDbId: "12121212-1212-1212-1212-121212121212",
      },
    });
    expect(meta).toEqual({
      evidenceId: "ev-1",
      source: "capture",
      templateSlug: "general-evidence-record",
      templateVersion: 7,
      templateDbId: "12121212-1212-1212-1212-121212121212",
    });
  });

  it("accepts every documented source label", () => {
    const sources = ["capture", "intake_link", "external_intake", "direct"] as const;
    for (const source of sources) {
      const meta = templateIdentityAuditMetadata({
        evidenceId: "x",
        source,
        trio: { templateSlug: null, templateVersion: null, templateDbId: null },
      });
      expect(meta.source).toBe(source);
      expect(meta.templateSlug).toBeNull();
      expect(meta.templateVersion).toBeNull();
      expect(meta.templateDbId).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 6-7. Source-contract greps — wiring on the canonical call sites.
// ---------------------------------------------------------------------------

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("Phase T — capture-finalize route wiring", () => {
  const src = readSource("../src/routes/evidence.routes.ts");

  it("imports resolveTemplateTrioForCaptureSession", () => {
    expect(src).toContain("resolveTemplateTrioForCaptureSession");
    expect(src).toContain("templateIdentityAuditMetadata");
    expect(src).toContain("templates/identity-resolver.service");
  });

  it("emits the canonical audit action with source: capture", () => {
    expect(src).toContain('action: "evidence.template_identity.stamped"');
    expect(src).toMatch(/source:\s*"capture"/);
  });

  it("wraps stamping in try/catch with a non-fatal warn log", () => {
    expect(src).toContain("template_identity_stamp_failed");
  });

  it("stamps templateSlug / templateVersion / templateDbId together", () => {
    // The three fields must all appear in the update data block.
    const updateBlock = src.match(/data:\s*\{[^}]*templateSlug:[^}]*templateDbId:[^}]*\}/s);
    expect(updateBlock).not.toBeNull();
  });
});

describe("Phase T — external-intake orchestration wiring", () => {
  const src = readSource(
    "../src/services/external-intake-orchestration.service.ts",
  );

  it("imports resolveTemplateTrioForIntakeLink", () => {
    expect(src).toContain("resolveTemplateTrioForIntakeLink");
    expect(src).toContain("templates/identity-resolver.service");
  });

  it("emits the canonical audit action with source: external_intake", () => {
    expect(src).toContain('action: "evidence.template_identity.stamped"');
    expect(src).toMatch(/source:\s*"external_intake"/);
  });

  it("wraps the stamping block in try/catch — propagation only", () => {
    // Must contain a /* propagation-only */ swallow.
    expect(src).toMatch(/propagation-only|never break/);
  });

  it("stamps the trio onto the Evidence row inside createOrLoadExternalEvidence", () => {
    // The trio fields must all appear on the orchestration evidence.update.
    expect(src).toMatch(/templateSlug:\s*trio\.templateSlug/);
    expect(src).toMatch(/templateVersion:\s*trio\.templateVersion/);
    expect(src).toMatch(/templateDbId:\s*trio\.templateDbId/);
  });
});

// ---------------------------------------------------------------------------
// Hard-rules guard — schema additions stay nullable / additive.
// ---------------------------------------------------------------------------

describe("Phase T — hard-rules guard", () => {
  it("identity-resolver.service.ts NEVER throws — all paths return a trio", () => {
    const src = readSource(
      "../src/services/templates/identity-resolver.service.ts",
    );
    // Every public function returns either a trio or null; no `throw` statements.
    expect(src).not.toMatch(/^\s*throw\s/m);
  });

  it("identity-resolver.service.ts does NOT touch policy decisions", () => {
    const src = readSource(
      "../src/services/templates/identity-resolver.service.ts",
    );
    // Identity only. Must not import billing, RBAC, governance, or webhook surfaces.
    expect(src).not.toMatch(/billing-enforcement/);
    expect(src).not.toMatch(/rbac-engine/);
    expect(src).not.toMatch(/governance/);
    expect(src).not.toMatch(/webhook-dispatcher/);
  });
});
