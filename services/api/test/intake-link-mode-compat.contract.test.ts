/**
 * Intake-links-e2e mode-compat bugfix — pins that every built-in seed
 * template advertises the EXTERNAL_ONE_TIME and EXTERNAL_REUSABLE
 * intake modes so the intake-links create flow can use them.
 *
 * Regression history:
 *   The seed-lifter (workflow-template.service.ts) was setting
 *   `intakeModes` to only ["AUTHENTICATED_STANDARD",
 *   "AUTHENTICATED_GUIDED"]. Every intake-link create against a
 *   built-in template was failing the template-compatibility check at
 *   workflow-intake-link.service.ts:188 with
 *   `intake_mode_not_supported_by_template`. This contract test makes
 *   the omission impossible to re-introduce silently.
 */

import { describe, expect, it } from "vitest";

import { listIntakeTemplates } from "../src/services/capture-intake-templates.js";
import {
  liftIntakeTemplateToWorkflowTemplate,
} from "../src/services/workflow-template.service.js";

const EXTERNAL_REQUIRED = [
  "EXTERNAL_ONE_TIME",
  "EXTERNAL_REUSABLE",
] as const;

const ALL_EXTERNAL = [
  "EXTERNAL_ONE_TIME",
  "EXTERNAL_REUSABLE",
  "EXTERNAL_ANONYMOUS",
  "EXTERNAL_PSEUDONYMOUS",
] as const;

describe("Intake-links mode-compat — every shipped seed supports external intake", () => {
  it("every seed advertises EXTERNAL_ONE_TIME and EXTERNAL_REUSABLE after liftIntakeTemplateToWorkflowTemplate", () => {
    const seeds = listIntakeTemplates();
    expect(seeds.length).toBeGreaterThan(0);

    for (const seed of seeds) {
      const lifted = liftIntakeTemplateToWorkflowTemplate(seed);
      for (const required of EXTERNAL_REQUIRED) {
        expect(
          lifted.intakeModes.includes(required),
          `seed "${seed.id}" must advertise ${required} for intake-link support`,
        ).toBe(true);
      }
    }
  });

  it("every seed also advertises the anonymous + pseudonymous variants so journalism / source-witness flows work", () => {
    const seeds = listIntakeTemplates();
    for (const seed of seeds) {
      const lifted = liftIntakeTemplateToWorkflowTemplate(seed);
      for (const mode of ALL_EXTERNAL) {
        expect(
          lifted.intakeModes.includes(mode),
          `seed "${seed.id}" must advertise ${mode}`,
        ).toBe(true);
      }
    }
  });

  it("the authenticated modes are still advertised (no regression for workflow instances)", () => {
    const seeds = listIntakeTemplates();
    for (const seed of seeds) {
      const lifted = liftIntakeTemplateToWorkflowTemplate(seed);
      expect(lifted.intakeModes).toContain("AUTHENTICATED_STANDARD");
      expect(lifted.intakeModes).toContain("AUTHENTICATED_GUIDED");
    }
  });

  it("each of the 9 SMB request types is named in the seed registry so the catalog dropdown is backed by real templates", () => {
    // Pinned set must include every catalog slug the frontend's
    // REQUEST_TYPES references. A missing seed here means the
    // catalog will silently 404 at create time.
    const expectedSlugs = [
      "general-evidence-record",
      "photos-videos",
      "documents",
      "insurance-claim",
      "legal-matter",
      "property-damage",
      "incident-investigation",
      "compliance-audit",
      "journalism-field-capture",
    ];
    const seedIds = new Set(listIntakeTemplates().map((s) => s.id));
    for (const slug of expectedSlugs) {
      expect(
        seedIds.has(slug),
        `frontend REQUEST_TYPES references "${slug}" but no seed exists with that id`,
      ).toBe(true);
    }
  });
});
