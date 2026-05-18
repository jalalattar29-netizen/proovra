/**
 * Pure unit tests for the workflow template service.
 *
 * No database is required — these tests exercise the lift / merge logic in
 * memory using stub DB-row objects shaped like Prisma's EvidenceWorkflowTemplate.
 *
 * Contract under test:
 *   1. Every seed template in capture-intake-templates.ts must lift cleanly
 *      to a WorkflowTemplate (Phase 1 schema).
 *   2. The merger returns seed templates when no DB rows are supplied.
 *   3. Workspace DB rows override seed templates by slug.
 *   4. Workspace DB rows override platform DB rows by slug.
 *   5. Archived rows are hidden from the merger unless includeArchived=true.
 *   6. workspaceCategory filter limits returned templates to that category
 *      (or to category-agnostic templates).
 *   7. Invalid DB rows are skipped and reported via onInvalidRow.
 */

import type { EvidenceWorkflowTemplate as DbWorkflowTemplate } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { listIntakeTemplates } from "../src/services/capture-intake-templates.js";
import {
  liftIntakeTemplateToWorkflowTemplate,
  mergeWorkflowTemplates,
  parseDbWorkflowTemplate,
  validateWorkflowTemplatePayload,
} from "../src/services/workflow-template.service.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeDbRow(
  overrides: Partial<DbWorkflowTemplate> = {},
): DbWorkflowTemplate {
  const baseSteps = [
    {
      id: "primary",
      title: "Primary evidence",
      description: "Upload the primary item.",
      purposeLabel: "Primary",
      required: true,
      acceptedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
    },
  ];
  return {
    id: overrides.id ?? "00000000-0000-0000-0000-000000000001",
    slug: overrides.slug ?? "workspace-custom",
    teamId: overrides.teamId ?? "00000000-0000-0000-0000-000000000099",
    workspaceCategory: overrides.workspaceCategory ?? null,
    version: overrides.version ?? 1,
    name: overrides.name ?? "Workspace Custom",
    description: overrides.description ?? "A workspace-specific template.",
    archived: overrides.archived ?? false,
    status: overrides.status ?? "ACTIVE",
    planMode: overrides.planMode ?? "FLEXIBLE",
    locationRequirement: overrides.locationRequirement ?? "recommended",
    intakeModes: overrides.intakeModes ?? ["AUTHENTICATED_STANDARD"],
    allowedRoles: overrides.allowedRoles ?? [],
    stepsJson: overrides.stepsJson ?? (baseSteps as unknown as DbWorkflowTemplate["stepsJson"]),
    rulesJson: overrides.rulesJson ?? null,
    visibilityPolicyJson: overrides.visibilityPolicyJson ?? null,
    reviewPolicyJson: overrides.reviewPolicyJson ?? null,
    exportPolicyJson: overrides.exportPolicyJson ?? null,
    createdByUserId: overrides.createdByUserId ?? null,
    updatedByUserId: overrides.updatedByUserId ?? null,
    createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-01-01T00:00:00Z"),
  };
}

// -----------------------------------------------------------------------------
// Seed template compatibility
// -----------------------------------------------------------------------------

describe("liftIntakeTemplateToWorkflowTemplate", () => {
  it("lifts every active seed template to a Phase 1 WorkflowTemplate", () => {
    const seeds = listIntakeTemplates();
    expect(seeds.length).toBeGreaterThan(0);

    for (const seed of seeds) {
      const lifted = liftIntakeTemplateToWorkflowTemplate(seed);
      expect(lifted.slug).toBe(seed.id);
      expect(lifted.id).toBe(seed.id);
      expect(lifted.version).toBe(seed.version);
      expect(lifted.name).toBe(seed.name);
      expect(lifted.locationRequirement).toBe(seed.locationRequirement);
      expect(lifted.planMode).toBe("FLEXIBLE");
      expect(lifted.intakeModes).toEqual([
        "AUTHENTICATED_STANDARD",
        "AUTHENTICATED_GUIDED",
      ]);
      expect(lifted.steps.length).toBe(seed.steps.length);

      // Step shapes must round-trip
      for (let i = 0; i < seed.steps.length; i++) {
        const seedStep = seed.steps[i];
        const liftedStep = lifted.steps[i];
        expect(liftedStep.id).toBe(seedStep.id);
        expect(liftedStep.required).toBe(seedStep.required);
        expect(liftedStep.acceptedKinds).toEqual(seedStep.acceptedKinds);
      }
    }
  });

  it("freezes acceptedKinds as a new array so the seed cannot be mutated through the lifted copy", () => {
    const seeds = listIntakeTemplates();
    const first = seeds[0];
    const lifted = liftIntakeTemplateToWorkflowTemplate(first);
    expect(lifted.steps[0].acceptedKinds).not.toBe(first.steps[0].acceptedKinds);
  });
});

// -----------------------------------------------------------------------------
// parseDbWorkflowTemplate
// -----------------------------------------------------------------------------

describe("parseDbWorkflowTemplate", () => {
  it("validates a well-formed row", () => {
    const row = makeDbRow({ slug: "well-formed" });
    const parsed = parseDbWorkflowTemplate(row);
    expect(parsed).not.toBeNull();
    expect(parsed?.slug).toBe("well-formed");
  });

  it("returns null when stepsJson is malformed", () => {
    const row = makeDbRow({
      stepsJson: [
        {
          id: "primary",
          // missing required fields like title/purposeLabel/acceptedKinds
          required: true,
        },
      ] as unknown as DbWorkflowTemplate["stepsJson"],
    });
    expect(parseDbWorkflowTemplate(row)).toBeNull();
  });

  it("returns null when slug is not kebab-case", () => {
    const row = makeDbRow({ slug: "BadSlug" });
    expect(parseDbWorkflowTemplate(row)).toBeNull();
  });

  it("returns null when intakeModes is empty", () => {
    const row = makeDbRow({ intakeModes: [] });
    expect(parseDbWorkflowTemplate(row)).toBeNull();
  });

  it("returns null when intakeModes contains an unknown value", () => {
    const row = makeDbRow({ intakeModes: ["NOT_A_MODE"] });
    expect(parseDbWorkflowTemplate(row)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// mergeWorkflowTemplates
// -----------------------------------------------------------------------------

describe("mergeWorkflowTemplates", () => {
  it("returns all active seeds when no DB rows are supplied", () => {
    const seeds = listIntakeTemplates();
    const merged = mergeWorkflowTemplates({
      seeds,
      workspaceRows: [],
      globalRows: [],
    });

    expect(merged.length).toBe(seeds.filter((s) => !s.archived).length);
    for (const entry of merged) {
      expect(entry.source).toBe("platform_seed");
      expect(entry.dbId).toBeNull();
    }
    const slugs = merged.map((m) => m.template.slug).sort();
    const expected = seeds.filter((s) => !s.archived).map((s) => s.id).sort();
    expect(slugs).toEqual(expected);
  });

  it("workspace DB row overrides a seed template with the same slug", () => {
    const seeds = listIntakeTemplates();
    const overridingSeedSlug = seeds[0].id;

    const workspaceRow = makeDbRow({
      slug: overridingSeedSlug,
      name: "Workspace Override Name",
    });

    const merged = mergeWorkflowTemplates({
      seeds,
      workspaceRows: [workspaceRow],
      globalRows: [],
    });

    const entry = merged.find((m) => m.template.slug === overridingSeedSlug);
    expect(entry).toBeDefined();
    expect(entry!.source).toBe("workspace_db");
    expect(entry!.template.name).toBe("Workspace Override Name");

    // Seed slugs that were NOT overridden still appear once each.
    for (const seed of seeds) {
      const found = merged.filter((m) => m.template.slug === seed.id);
      expect(found.length).toBe(1);
    }
  });

  it("workspace DB row wins over a platform DB row with the same slug", () => {
    const workspaceRow = makeDbRow({
      slug: "shared-slug",
      teamId: "team-1",
      name: "Workspace Wins",
    });
    const platformRow = makeDbRow({
      id: "00000000-0000-0000-0000-000000000002",
      slug: "shared-slug",
      teamId: null,
      name: "Platform Loses",
    });

    const merged = mergeWorkflowTemplates({
      seeds: [],
      workspaceRows: [workspaceRow],
      globalRows: [platformRow],
    });

    const entry = merged.find((m) => m.template.slug === "shared-slug");
    expect(entry?.source).toBe("workspace_db");
    expect(entry?.template.name).toBe("Workspace Wins");
  });

  it("platform DB row wins over a seed template with the same slug", () => {
    const seeds = listIntakeTemplates();
    const seedSlug = seeds[0].id;

    const platformRow = makeDbRow({
      slug: seedSlug,
      teamId: null,
      name: "Platform Override",
    });

    const merged = mergeWorkflowTemplates({
      seeds,
      workspaceRows: [],
      globalRows: [platformRow],
    });

    const entry = merged.find((m) => m.template.slug === seedSlug);
    expect(entry?.source).toBe("platform_db");
    expect(entry?.template.name).toBe("Platform Override");
  });

  it("archived rows are hidden by default", () => {
    const row = makeDbRow({ slug: "archived-row", archived: true });
    const merged = mergeWorkflowTemplates({
      seeds: [],
      workspaceRows: [row],
      globalRows: [],
    });
    expect(merged.find((m) => m.template.slug === "archived-row")).toBeUndefined();
  });

  it("archived rows are returned when includeArchived=true", () => {
    const row = makeDbRow({ slug: "archived-row", archived: true });
    const merged = mergeWorkflowTemplates({
      seeds: [],
      workspaceRows: [row],
      globalRows: [],
      includeArchived: true,
    });
    expect(merged.find((m) => m.template.slug === "archived-row")).toBeDefined();
  });

  it("workspaceCategory filter excludes templates bound to a different category", () => {
    const insuranceRow = makeDbRow({
      slug: "insurance-only",
      workspaceCategory: "INSURANCE",
    });
    const legalRow = makeDbRow({
      id: "00000000-0000-0000-0000-000000000003",
      slug: "legal-only",
      workspaceCategory: "LEGAL",
    });
    const categoryAgnostic = makeDbRow({
      id: "00000000-0000-0000-0000-000000000004",
      slug: "agnostic",
      workspaceCategory: null,
    });

    const merged = mergeWorkflowTemplates({
      seeds: [],
      workspaceRows: [insuranceRow, legalRow, categoryAgnostic],
      globalRows: [],
      workspaceCategory: "INSURANCE",
    });

    const slugs = merged.map((m) => m.template.slug).sort();
    expect(slugs).toEqual(["agnostic", "insurance-only"]);
  });

  it("skips invalid DB rows and reports them via onInvalidRow", () => {
    const valid = makeDbRow({ slug: "good-row" });
    const invalid = makeDbRow({
      id: "00000000-0000-0000-0000-000000000005",
      slug: "BadSlug",
    });

    const reports: Array<{ slug: string; reason: string }> = [];
    const merged = mergeWorkflowTemplates({
      seeds: [],
      workspaceRows: [valid, invalid],
      globalRows: [],
      onInvalidRow: (row, reason) => {
        reports.push({ slug: row.slug, reason });
      },
    });

    expect(merged.map((m) => m.template.slug)).toEqual(["good-row"]);
    expect(reports).toEqual([{ slug: "BadSlug", reason: "schema_validation_failed" }]);
  });

  it("produces a stable slug-sorted output", () => {
    const a = makeDbRow({
      id: "00000000-0000-0000-0000-000000000006",
      slug: "zebra",
    });
    const b = makeDbRow({
      id: "00000000-0000-0000-0000-000000000007",
      slug: "alpha",
    });
    const c = makeDbRow({
      id: "00000000-0000-0000-0000-000000000008",
      slug: "mango",
    });
    const merged = mergeWorkflowTemplates({
      seeds: [],
      workspaceRows: [a, b, c],
      globalRows: [],
    });
    expect(merged.map((m) => m.template.slug)).toEqual(["alpha", "mango", "zebra"]);
  });
});

// -----------------------------------------------------------------------------
// validateWorkflowTemplatePayload
// -----------------------------------------------------------------------------

describe("validateWorkflowTemplatePayload", () => {
  const baseSteps = [
    {
      id: "primary",
      title: "Primary",
      description: "Upload",
      purposeLabel: "Primary evidence",
      required: true,
      acceptedKinds: ["PHOTO"],
    },
  ] as const;

  it("accepts a minimal valid payload", () => {
    const result = validateWorkflowTemplatePayload({
      slug: "valid-slug",
      name: "Valid",
      planMode: "FLEXIBLE",
      locationRequirement: "optional",
      intakeModes: ["AUTHENTICATED_STANDARD"],
      steps: baseSteps as never,
    });
    expect(result.slug).toBe("valid-slug");
  });

  it("rejects a bad slug", () => {
    expect(() =>
      validateWorkflowTemplatePayload({
        slug: "Bad_Slug",
        name: "Invalid",
        planMode: "FLEXIBLE",
        locationRequirement: "optional",
        intakeModes: ["AUTHENTICATED_STANDARD"],
        steps: baseSteps as never,
      }),
    ).toThrow();
  });

  it("rejects when intakeModes is empty", () => {
    expect(() =>
      validateWorkflowTemplatePayload({
        slug: "valid-slug",
        name: "Invalid",
        planMode: "FLEXIBLE",
        locationRequirement: "optional",
        intakeModes: [],
        steps: baseSteps as never,
      }),
    ).toThrow();
  });

  it("rejects an unknown rule action", () => {
    expect(() =>
      validateWorkflowTemplatePayload({
        slug: "valid-slug",
        name: "Invalid",
        planMode: "FLEXIBLE",
        locationRequirement: "optional",
        intakeModes: ["AUTHENTICATED_STANDARD"],
        steps: baseSteps as never,
        rules: [
          {
            id: "r1",
            when: { field: "intakeMode", op: "eq", value: "EXTERNAL_ONE_TIME" },
            then: { action: "deleteEvidence" as never, target: "primary" },
          },
        ],
      }),
    ).toThrow();
  });
});
