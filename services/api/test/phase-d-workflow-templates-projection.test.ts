/**
 * Phase D — Workflow Templates Center surfaces every projected field.
 *
 * Goal: ensure that every metadata field already present on the
 * canonical EvidenceWorkflowTemplate projection (returned by
 * `/v1/workflows/templates`, which now spreads
 * `projectEffectiveWorkflowTemplate(...)`) is rendered on the
 * /workflows admin page with a stable `data-testid` so a future
 * refactor cannot silently drop a useful column from the admin view.
 *
 * Scope rules honored:
 *   - We do NOT invent new API fields. Every field pinned here is
 *     already present in the WorkflowTemplate Zod schema and flows
 *     through `projectEffectiveWorkflowTemplate`.
 *   - We do NOT add a new template metadata field. We only assert
 *     that fields the projection already returns reach the DOM.
 *
 * The test is a source-text guard (matching the established Phase B /
 * Phase R style) because the project does not have a DOM rendering
 * harness wired into vitest. The page is small and stable; the
 * source-text pins are sufficient to prevent regression.
 *
 * Deferred (explicitly not pinned here, because the API projection
 * does NOT carry them and Phase D is forbidden from extending the
 * API): defaultRetentionPolicy, defaultReviewerRequirements,
 * sectorPolicy, defaultIntakeMode, archivedAt, createdAt, updatedAt.
 */

import { describe, expect, it } from "vitest";

const PAGE_REL = "../../../apps/web/app/(app)/workflows/page.tsx";
const ROUTE_REL = "../src/routes/workflow-instances.routes.ts";
const SERVICE_REL = "../src/services/workflow-template.service.ts";

async function readFileRel(rel: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  return readFile(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// -----------------------------------------------------------------------------
// API alias surface — the alias must spread the canonical projection
// so every field on WorkflowTemplate reaches the page.
// -----------------------------------------------------------------------------

describe("Phase D — /v1/workflows/templates alias spreads canonical projection", () => {
  it("imports projectEffectiveWorkflowTemplate alongside listEffectiveWorkflowTemplates", async () => {
    const src = await readFileRel(ROUTE_REL);
    expect(src).toMatch(/listEffectiveWorkflowTemplates/);
    expect(src).toMatch(/projectEffectiveWorkflowTemplate/);
  });

  it("templates response spreads ...projectEffectiveWorkflowTemplate(r)", async () => {
    const src = await readFileRel(ROUTE_REL);
    // Robust to whitespace inside the spread expression.
    expect(src).toMatch(/\.\.\.projectEffectiveWorkflowTemplate\(\s*r\s*\)/);
  });

  it("templates response retains the requiredStepCount + stepCount convenience counts", async () => {
    const src = await readFileRel(ROUTE_REL);
    // Phase B pins these via the page test; keep the API pin too so a
    // refactor of the alias cannot drop the counts.
    expect(src).toMatch(/requiredStepCount:\s*r\.template\.steps\.filter/);
    expect(src).toMatch(/stepCount:\s*r\.template\.steps\.length/);
  });

  it("canonical projection helper still returns every WorkflowTemplate field", async () => {
    // Guards the upstream helper that the alias now spreads. If a
    // future refactor drops one of these keys here, every consumer
    // (including this page) silently regresses.
    const src = await readFileRel(SERVICE_REL);
    const helperStart = src.indexOf("export function projectEffectiveWorkflowTemplate");
    expect(helperStart).toBeGreaterThan(-1);
    const helperBody = src.slice(helperStart, helperStart + 2000);
    for (const key of [
      "id:",
      "dbId:",
      "slug:",
      "source:",
      "version:",
      "name:",
      "description:",
      "workspaceCategory:",
      "locationRequirement:",
      "planMode:",
      "intakeModes:",
      "allowedRoles:",
      "archived:",
      "steps:",
      "rules:",
    ]) {
      expect(helperBody).toContain(key);
    }
  });
});

// -----------------------------------------------------------------------------
// Page — every projected field renders with a stable data-testid.
// -----------------------------------------------------------------------------

describe("Phase D — /workflows page renders every projected template field", () => {
  it("renders the template name with data-testid workflow-template-name-${slug}", async () => {
    const src = await readFileRel(PAGE_REL);
    expect(src).toMatch(/data-testid={`workflow-template-name-\$\{t\.slug\}`}/);
    expect(src).toMatch(/\{t\.name\}/);
  });

  it("renders the template slug and version chips with data-testids", async () => {
    const src = await readFileRel(PAGE_REL);
    expect(src).toMatch(/data-testid={`workflow-template-slug-\$\{t\.slug\}`}/);
    expect(src).toMatch(/data-testid={`workflow-template-version-\$\{t\.slug\}`}/);
    expect(src).toMatch(/\{t\.slug\}/);
    expect(src).toMatch(/v\{t\.version\}/);
  });

  it("renders the source badge with data-testid", async () => {
    const src = await readFileRel(PAGE_REL);
    expect(src).toMatch(/data-testid={`workflow-template-source-\$\{t\.slug\}`}/);
    expect(src).toMatch(/\{t\.source\}/);
  });

  it("renders an Active / Archived status pill driven by t.archived", async () => {
    const src = await readFileRel(PAGE_REL);
    expect(src).toMatch(/data-testid={`workflow-template-status-\$\{t\.slug\}`}/);
    // Both labels must be reachable in the source — the conditional
    // expression is parsed verbatim by the regex.
    expect(src).toMatch(/t\.archived\s*\?\s*"Archived"\s*:\s*"Active"/);
  });

  it("renders description with data-testid", async () => {
    const src = await readFileRel(PAGE_REL);
    expect(src).toMatch(/data-testid={`workflow-template-description-\$\{t\.slug\}`}/);
    expect(src).toMatch(/t\.description\s*\?\?\s*"No description\."/);
  });

  it("renders the sector / step counts / intake modes summary line with data-testids", async () => {
    const src = await readFileRel(PAGE_REL);
    expect(src).toMatch(/data-testid={`workflow-template-step-counts-\$\{t\.slug\}`}/);
    expect(src).toMatch(/data-testid={`workflow-template-sector-\$\{t\.slug\}`}/);
    expect(src).toMatch(/data-testid={`workflow-template-intake-modes-\$\{t\.slug\}`}/);
    expect(src).toMatch(/\{t\.requiredStepCount\}\/\{t\.stepCount\}/);
    // Phase R — every seed now declares its concrete workspaceCategory,
    // so the previous "GENERAL" fallback in the UI was a lie that
    // overwrote a missing category as if the platform had picked a
    // category. The fallback now reads "unspecified" so the only thing
    // the operator sees as "unspecified" is a DB row that genuinely has
    // no category set, never a seed.
    expect(src).toMatch(/t\.workspaceCategory\s*\?\?\s*"unspecified"/);
    expect(src).toMatch(/t\.intakeModes\.join\(/);
  });

  it("renders planMode chip with data-testid", async () => {
    const src = await readFileRel(PAGE_REL);
    expect(src).toMatch(/data-testid={`workflow-template-plan-mode-\$\{t\.slug\}`}/);
    expect(src).toMatch(/\{t\.planMode\}/);
  });

  it("renders locationRequirement chip with data-testid", async () => {
    const src = await readFileRel(PAGE_REL);
    expect(src).toMatch(/data-testid={`workflow-template-location-\$\{t\.slug\}`}/);
    expect(src).toMatch(/\{t\.locationRequirement\}/);
  });

  it("renders allowedRoles chip with data-testid + 'any role' fallback", async () => {
    const src = await readFileRel(PAGE_REL);
    expect(src).toMatch(/data-testid={`workflow-template-allowed-roles-\$\{t\.slug\}`}/);
    expect(src).toMatch(/t\.allowedRoles/);
    expect(src).toMatch(/"any role"/);
  });

  it("renders a rule-count chip when t.rules has entries", async () => {
    const src = await readFileRel(PAGE_REL);
    expect(src).toMatch(/data-testid={`workflow-template-rule-count-\$\{t\.slug\}`}/);
    expect(src).toMatch(/Array\.isArray\(t\.rules\)\s*&&\s*t\.rules\.length\s*>\s*0/);
  });

  it("renders the compact steps list when t.steps has entries", async () => {
    const src = await readFileRel(PAGE_REL);
    expect(src).toMatch(/data-testid={`workflow-template-steps-\$\{t\.slug\}`}/);
    expect(src).toMatch(/Array\.isArray\(t\.steps\)\s*&&\s*t\.steps\.length\s*>\s*0/);
    // Each step must surface title, purposeLabel, required flag, and
    // acceptedKinds — the four fields the schema actually carries.
    expect(src).toMatch(/\{step\.title\}/);
    expect(src).toMatch(/\{step\.purposeLabel\}/);
    expect(src).toMatch(/step\.required/);
    expect(src).toMatch(/step\.acceptedKinds/);
    // Per-step data-testid must include both slug + step id so a
    // future test harness can target a specific step.
    expect(src).toMatch(
      /data-testid={`workflow-template-step-\$\{t\.slug\}-\$\{step\.id \?\? idx\}`}/,
    );
  });

  it("documents the deferred fields that are NOT on the projection", async () => {
    const src = await readFileRel(PAGE_REL);
    // Pin the comment block so the deferred-field documentation is
    // not silently removed by a future cleanup pass. Without this,
    // someone could "extend the API to support retention policy" and
    // re-introduce the exact divergence Phase D is trying to prevent.
    expect(src).toMatch(/defaultRetentionPolicy/);
    expect(src).toMatch(/defaultReviewerRequirements/);
    expect(src).toMatch(/sectorPolicy/);
    expect(src).toMatch(/defaultIntakeMode/);
    expect(src).toMatch(/archivedAt/);
  });
});
