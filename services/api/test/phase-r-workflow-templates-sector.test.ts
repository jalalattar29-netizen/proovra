/**
 * Phase R — Workflow templates sector wiring.
 *
 * Before Phase R, the sector dropdown on the Workflow Templates admin
 * page was a NO-OP for every seed-derived template:
 *   - `liftIntakeTemplateToWorkflowTemplate` omitted `workspaceCategory`,
 *     so all 6 seeds came through with `workspaceCategory === undefined`.
 *   - `mergeWorkflowTemplates`' seed loop bypassed the category filter
 *     entirely; the DB-row branch applied it but the seed branch did
 *     not.
 *   - The `/v1/workflows/templates` alias post-filter compared
 *     `(workspaceCategory ?? "").toLowerCase()` against the requested
 *     sector. With every seed missing a category, picking any non-"All
 *     sectors" sector dropped all seeds AND every DB row whose admin
 *     never set a category. On a fresh workspace with no admin rows,
 *     the answer was always an empty list.
 *
 * Phase R wires the seeds to the dropdown. Each in-code seed declares
 * the concrete sector it serves; the lift propagates the field; the
 * merger applies the same filter to seeds that it already applied to
 * DB rows. This file pins that wiring end-to-end so any regression
 * (seed forgets a category, lift drops the field, merger skips the
 * filter, mapping drifts) is caught.
 *
 * What is NOT pinned here, and why:
 *   - We do not pin that any non-template subsystem (Evidence, Review,
 *     Reviewer Ops, SLA, Escalations, Governance, Reports) consumes
 *     workspaceCategory. Phase 1 evidence shows none of them do — Phase
 *     R does not invent new consumption paths.
 *   - We do not pin the `/v1/workflows/templates` plural alias, which
 *     applies its own post-filter outside `listEffectiveWorkflowTemplates`.
 *     That path is exercised in the existing alias tests; this file
 *     covers the canonical service layer the singular endpoint and
 *     every internal caller use.
 */

import type { EvidenceWorkflowTemplate as DbWorkflowTemplate } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  IntakeTemplate,
  listIntakeTemplates,
} from "../src/services/capture-intake-templates.js";
import {
  liftIntakeTemplateToWorkflowTemplate,
  listEffectiveWorkflowTemplates,
  mergeWorkflowTemplates,
} from "../src/services/workflow-template.service.js";

// -----------------------------------------------------------------------------
// Phase R mapping — the exact slug -> sector binding decided by the brief.
// Any future seed must update this map; any drift between this map and
// the seed list trips the "every seed has the expected sector" pin
// below.
// -----------------------------------------------------------------------------

// Intake-links-e2e Phase 6 — three SMB seeds added to the registry.
// Product decisions:
//   - `documents`        → GENERAL (catch-all paperwork ask, not legal-
//                           specific; legal teams still get `legal-matter`
//                           when they pick the LEGAL sector).
//   - `photos-videos`    → GENERAL (visual capture, no sector affinity).
//   - `property-damage`  → INSURANCE (canonically a claims-handler
//                           workflow; INSURANCE filter therefore returns
//                           BOTH `insurance-claim` and `property-damage`
//                           — see the merge test below).
const PHASE_R_SEED_SECTOR_MAP: Record<string, string> = {
  "general-evidence-record": "GENERAL",
  "insurance-claim": "INSURANCE",
  "legal-matter": "LEGAL",
  "incident-investigation": "INVESTIGATIONS",
  "compliance-audit": "COMPLIANCE",
  "journalism-field-capture": "JOURNALISM",
  documents: "GENERAL",
  "photos-videos": "GENERAL",
  "property-damage": "INSURANCE",
};

// -----------------------------------------------------------------------------
// Minimal in-memory prisma stub that satisfies the narrow Pick<>
// signature listEffectiveWorkflowTemplates expects. Returning [] from
// both findMany calls drives the service through the pure seed path so
// the wiring (lift + merge filter) can be exercised without a DB.
// -----------------------------------------------------------------------------

function buildEmptyClient() {
  return {
    evidenceWorkflowTemplate: {
      findMany: async (_args: unknown) => [] as DbWorkflowTemplate[],
    },
  } as unknown as Parameters<typeof listEffectiveWorkflowTemplates>[1];
}

function buildClientWith(rows: DbWorkflowTemplate[]) {
  return {
    evidenceWorkflowTemplate: {
      // The service issues two findMany calls: one for the workspace
      // scope (teamId === <id>), one for the platform scope (teamId
      // IS NULL). The stub returns the same row set for the matching
      // scope and [] for the other so the test can pin which scope a
      // given row was treated as.
      findMany: async (args: {
        where: { teamId: string | null };
      }): Promise<DbWorkflowTemplate[]> => {
        const wantsWorkspace = args.where.teamId !== null;
        return rows.filter((r) =>
          wantsWorkspace ? r.teamId !== null : r.teamId === null,
        );
      },
    },
  } as unknown as Parameters<typeof listEffectiveWorkflowTemplates>[1];
}

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
    id: overrides.id ?? "00000000-0000-0000-0000-0000000000aa",
    slug: overrides.slug ?? "workspace-custom",
    teamId: overrides.teamId ?? "00000000-0000-0000-0000-0000000000bb",
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
    stepsJson:
      overrides.stepsJson ??
      (baseSteps as unknown as DbWorkflowTemplate["stepsJson"]),
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
// Pin 1: every shipped seed declares the expected sector.
// -----------------------------------------------------------------------------

describe("Phase R — seed sector mapping", () => {
  it("every shipped seed declares the Phase R sector exactly", () => {
    const seeds: IntakeTemplate[] = listIntakeTemplates();
    expect(seeds.length).toBe(Object.keys(PHASE_R_SEED_SECTOR_MAP).length);

    for (const seed of seeds) {
      const expected = PHASE_R_SEED_SECTOR_MAP[seed.id];
      expect(
        expected,
        `seed "${seed.id}" is not in the Phase R sector map — either it is a new seed (add to map) or the map drifted`,
      ).toBeDefined();
      expect(seed.workspaceCategory).toBe(expected);
    }
  });

  it("liftIntakeTemplateToWorkflowTemplate propagates workspaceCategory onto the lifted template", () => {
    const seeds = listIntakeTemplates();
    for (const seed of seeds) {
      const lifted = liftIntakeTemplateToWorkflowTemplate(seed);
      expect(lifted.workspaceCategory).toBe(seed.workspaceCategory);
      expect(lifted.workspaceCategory).toBe(
        PHASE_R_SEED_SECTOR_MAP[seed.id],
      );
    }
  });
});

// -----------------------------------------------------------------------------
// Pin 2: the merger applies the workspaceCategory filter to seeds the
// same way it already applies it to DB rows.
// -----------------------------------------------------------------------------

describe("Phase R — mergeWorkflowTemplates seed filter", () => {
  it("returns ALL shipped seeds when no workspaceCategory filter is supplied", () => {
    // The seed registry is the canonical count source; this test must
    // not hardcode a number so a future Phase-N seed addition only has
    // to update PHASE_R_SEED_SECTOR_MAP.
    const seeds = listIntakeTemplates();
    const merged = mergeWorkflowTemplates({
      seeds,
      workspaceRows: [],
      globalRows: [],
    });
    const slugs = merged.map((m) => m.template.slug).sort();
    expect(slugs).toEqual(Object.keys(PHASE_R_SEED_SECTOR_MAP).sort());
  });

  it("workspaceCategory=COMPLIANCE returns ONLY compliance-audit", () => {
    const seeds = listIntakeTemplates();
    const merged = mergeWorkflowTemplates({
      seeds,
      workspaceRows: [],
      globalRows: [],
      workspaceCategory: "COMPLIANCE",
    });
    const slugs = merged.map((m) => m.template.slug);
    expect(slugs).toEqual(["compliance-audit"]);
  });

  it("workspaceCategory=INSURANCE returns BOTH insurance-claim AND property-damage", () => {
    // Intake-links-e2e Phase 6 — `property-damage` is a claims-handler
    // workflow and maps to INSURANCE on purpose. The merger returns
    // results sorted by slug (workflow-template.service.ts), so the
    // order is alphabetical.
    const seeds = listIntakeTemplates();
    const merged = mergeWorkflowTemplates({
      seeds,
      workspaceRows: [],
      globalRows: [],
      workspaceCategory: "INSURANCE",
    });
    const slugs = merged.map((m) => m.template.slug);
    expect(slugs).toEqual(["insurance-claim", "property-damage"]);
  });

  it("workspaceCategory=GENERAL returns the three GENERAL seeds (documents, general-evidence-record, photos-videos)", () => {
    // Intake-links-e2e Phase 6 — `documents` and `photos-videos` join
    // the original `general-evidence-record` under GENERAL. Order is
    // alphabetical by slug, per the merger.
    const seeds = listIntakeTemplates();
    const merged = mergeWorkflowTemplates({
      seeds,
      workspaceRows: [],
      globalRows: [],
      workspaceCategory: "GENERAL",
    });
    const slugs = merged.map((m) => m.template.slug);
    expect(slugs).toEqual([
      "documents",
      "general-evidence-record",
      "photos-videos",
    ]);
  });

  it("workspaceCategory=FIELD_OPERATIONS returns ZERO seeds (no seed maps to that sector)", () => {
    const seeds = listIntakeTemplates();
    const merged = mergeWorkflowTemplates({
      seeds,
      workspaceRows: [],
      globalRows: [],
      workspaceCategory: "FIELD_OPERATIONS",
    });
    expect(merged.length).toBe(0);
  });

  it("workspaceCategory=RESEARCH returns ZERO seeds (no seed maps to that sector)", () => {
    const seeds = listIntakeTemplates();
    const merged = mergeWorkflowTemplates({
      seeds,
      workspaceRows: [],
      globalRows: [],
      workspaceCategory: "RESEARCH",
    });
    expect(merged.length).toBe(0);
  });

  it("workspaceCategory=OTHER returns ZERO seeds (no seed maps to that sector)", () => {
    const seeds = listIntakeTemplates();
    const merged = mergeWorkflowTemplates({
      seeds,
      workspaceRows: [],
      globalRows: [],
      workspaceCategory: "OTHER",
    });
    expect(merged.length).toBe(0);
  });

  it("a seed with no declared workspaceCategory is treated as category-agnostic (matches every filter)", () => {
    // Constructs a synthetic seed without a workspaceCategory to mirror
    // the legacy shape, then pins that the merger does not filter it
    // out — matching the existing NULL workspace_category DB behaviour.
    const agnosticSeed: IntakeTemplate = {
      id: "agnostic-synthetic",
      version: 1,
      name: "Agnostic Synthetic",
      description: "Synthetic seed without a workspaceCategory.",
      locationRequirement: "optional",
      archived: false,
      steps: [
        {
          id: "primary",
          title: "Primary",
          description: "Upload",
          purposeLabel: "Primary",
          required: true,
          acceptedKinds: ["PHOTO"],
        },
      ],
    };
    const merged = mergeWorkflowTemplates({
      seeds: [agnosticSeed],
      workspaceRows: [],
      globalRows: [],
      workspaceCategory: "INSURANCE",
    });
    expect(merged.map((m) => m.template.slug)).toEqual(["agnostic-synthetic"]);
  });
});

// -----------------------------------------------------------------------------
// Pin 3: listEffectiveWorkflowTemplates wires the sector filter end-to-
// end through the prisma client. Uses an in-memory stub so no DB is
// required.
// -----------------------------------------------------------------------------

describe("Phase R — listEffectiveWorkflowTemplates sector filter", () => {
  it("workspaceCategory=COMPLIANCE returns only compliance-audit when no DB rows exist", async () => {
    const list = await listEffectiveWorkflowTemplates(
      { workspaceCategory: "COMPLIANCE" },
      buildEmptyClient(),
    );
    expect(list.map((e) => e.template.slug)).toEqual(["compliance-audit"]);
    expect(list[0].source).toBe("platform_seed");
  });

  it("workspaceCategory=null returns every shipped seed when no DB rows exist", async () => {
    const list = await listEffectiveWorkflowTemplates(
      { workspaceCategory: null },
      buildEmptyClient(),
    );
    const slugs = list.map((e) => e.template.slug).sort();
    expect(slugs).toEqual(Object.keys(PHASE_R_SEED_SECTOR_MAP).sort());
  });

  it("workspaceCategory undefined (filter omitted) returns every shipped seed", async () => {
    // Pinned against PHASE_R_SEED_SECTOR_MAP so a future seed addition
    // only updates that map (no count hardcoded here).
    const list = await listEffectiveWorkflowTemplates({}, buildEmptyClient());
    expect(list.length).toBe(Object.keys(PHASE_R_SEED_SECTOR_MAP).length);
  });

  it("a workspace DB row with workspaceCategory=LEGAL beats the seed when filter is LEGAL", async () => {
    // A workspace-scoped DB row sharing the seed's slug should win
    // override precedence (existing service contract). With the Phase
    // R filter, the seed AND the workspace row both match a LEGAL
    // filter — but the workspace row's source must be the one that
    // surfaces, since the merger already gives DB rows precedence.
    const workspaceRow = makeDbRow({
      id: "00000000-0000-0000-0000-0000000000cc",
      slug: "legal-matter",
      teamId: "00000000-0000-0000-0000-0000000000dd",
      name: "Workspace Legal Override",
      workspaceCategory: "LEGAL",
    });
    const list = await listEffectiveWorkflowTemplates(
      {
        teamId: "00000000-0000-0000-0000-0000000000dd",
        workspaceCategory: "LEGAL",
      },
      buildClientWith([workspaceRow]),
    );
    const legalEntry = list.find((e) => e.template.slug === "legal-matter");
    expect(legalEntry).toBeDefined();
    expect(legalEntry!.source).toBe("workspace_db");
    expect(legalEntry!.template.name).toBe("Workspace Legal Override");
    // No other seed maps to LEGAL, so the list collapses to this one
    // override row.
    expect(list.length).toBe(1);
  });

  it("a workspace DB row with workspaceCategory=INSURANCE does NOT surface when filter is LEGAL (DB-row filter still applied)", async () => {
    const insuranceRow = makeDbRow({
      id: "00000000-0000-0000-0000-0000000000ee",
      slug: "ws-insurance-override",
      teamId: "00000000-0000-0000-0000-0000000000ff",
      workspaceCategory: "INSURANCE",
    });
    const list = await listEffectiveWorkflowTemplates(
      {
        teamId: "00000000-0000-0000-0000-0000000000ff",
        workspaceCategory: "LEGAL",
      },
      buildClientWith([insuranceRow]),
    );
    expect(list.find((e) => e.template.slug === "ws-insurance-override")).toBeUndefined();
    // Only the legal-matter seed remains under a LEGAL filter.
    expect(list.map((e) => e.template.slug)).toEqual(["legal-matter"]);
  });
});
