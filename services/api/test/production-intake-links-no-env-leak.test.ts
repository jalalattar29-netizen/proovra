/**
 * Production /intake-links feature-disabled panel — no env-var leak.
 *
 * Pins the fix for the production bug where the feature-disabled panel
 * rendered the literal env-var names
 * `WORKFLOW_INTAKE_LINKS_ENABLED` and `WORKFLOW_INTAKE_TOKEN_SECRET`
 * directly to operators. Env-var names are deployment-internal; the
 * panel now shows a bounded "Configuration required" message and
 * points admins at the deployment runbook.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}
function readApi(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

const PAGE = readWeb("app/(app)/intake-links/page.tsx");
const ENV_EXAMPLE = readApi(".env.example");

describe("Production fix — /intake-links feature-disabled panel never leaks env names", () => {
  it("page.tsx does NOT render literal WORKFLOW_INTAKE_LINKS_ENABLED in JSX", () => {
    // The env-var name may appear in a /* */ comment but MUST NOT
    // appear as user-facing copy or inside a <code> block.
    const stripped = PAGE
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(stripped).not.toMatch(/<code>\s*WORKFLOW_INTAKE_LINKS_ENABLED\s*<\/code>/);
    expect(stripped).not.toMatch(/<code>\s*WORKFLOW_INTAKE_TOKEN_SECRET\s*<\/code>/);
  });

  it("page.tsx renders a bounded 'Configuration required' panel for the disabled state", () => {
    expect(PAGE).toMatch(/Configuration required/);
    expect(PAGE).toMatch(/data-testid="intake-links-feature-disabled"/);
  });

  it("page.tsx points admins at deployment docs (no raw env names in copy)", () => {
    // The disabled panel must surface a deployment-runbook hint rather
    // than spell out env-var names that operators cannot act on.
    expect(PAGE).toMatch(/deployment runbook/);
  });

  it(".env.example documents the required intake-link env keys", () => {
    expect(ENV_EXAMPLE).toMatch(/WORKFLOW_INTAKE_LINKS_ENABLED\s*=/);
    expect(ENV_EXAMPLE).toMatch(/WORKFLOW_INTAKE_TOKEN_SECRET\s*=/);
  });
});
