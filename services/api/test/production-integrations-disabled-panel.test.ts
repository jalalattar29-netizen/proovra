/**
 * Production /integrations disabled-state panel — no raw JSON leak.
 *
 * Pins the fix for the production bug where the /integrations page
 * surfaced the raw apiFetch error message ("INTEGRATIONS_DISABLED
 * secret_missing") in the error banner whenever the backend returned
 * a structured 503 FEATURE_DISABLED response (INTEGRATIONS_ENABLED=false
 * or API_KEY_SECRET unset on the deployment).
 *
 * After the fix the page detects the `INTEGRATIONS_DISABLED` error code
 * on ApiError and renders a structured `IntegrationsDisabledPanel`
 * instead. The panel deliberately does NOT name the env vars (those are
 * deployment-internal configuration — operators are pointed at the
 * deployment runbook instead).
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

const PAGE = readWeb("app/(app)/integrations/page.tsx");
const ENV_EXAMPLE = readApi(".env.example");

describe("Production fix — /integrations renders a panel, not raw JSON, when disabled", () => {
  it("loadAll catches the INTEGRATIONS_DISABLED error code and sets the structured marker", () => {
    // The catch branch must look at .code === "INTEGRATIONS_DISABLED" and
    // switch to the disabled-state marker, instead of dumping err.message
    // into the error banner verbatim.
    expect(PAGE).toMatch(/code\?:\s*string[\s\S]{0,200}INTEGRATIONS_DISABLED/);
    expect(PAGE).toMatch(/setError\(\s*"INTEGRATIONS_DISABLED"\s*\)/);
  });

  it("renders IntegrationsDisabledPanel when error === 'INTEGRATIONS_DISABLED'", () => {
    // The JSX must branch on the structured marker BEFORE falling back to
    // the generic error banner.
    expect(PAGE).toMatch(/error\s*===\s*"INTEGRATIONS_DISABLED"[\s\S]{0,200}IntegrationsDisabledPanel/);
  });

  it("IntegrationsDisabledPanel is a structured component (not raw JSON)", () => {
    expect(PAGE).toMatch(/function IntegrationsDisabledPanel\(/);
    expect(PAGE).toMatch(/data-testid="integrations-disabled-panel"/);
    expect(PAGE).toMatch(/Integrations are not available/);
  });

  it("disabled panel does NOT leak env-var names to operators", () => {
    // Strip comments first — the env-var names may legitimately appear
    // in a /* */ comment explaining the contract.
    const stripped = PAGE
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const panelStart = stripped.indexOf("function IntegrationsDisabledPanel(");
    expect(panelStart).toBeGreaterThan(-1);
    const panelBody = stripped.slice(panelStart, panelStart + 2200);
    expect(panelBody).not.toMatch(/INTEGRATIONS_ENABLED/);
    expect(panelBody).not.toMatch(/API_KEY_SECRET/);
    // Points admins at the deployment runbook instead.
    expect(panelBody).toMatch(/deployment runbook/);
  });

  it(".env.example documents the integrations env keys", () => {
    expect(ENV_EXAMPLE).toMatch(/INTEGRATIONS_ENABLED\s*=/);
    expect(ENV_EXAMPLE).toMatch(/API_KEY_SECRET\s*=/);
  });
});
