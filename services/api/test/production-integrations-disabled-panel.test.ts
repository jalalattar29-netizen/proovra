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
    // PHASE 1 — panel grew with the admin-only diagnostics chip block, so
    // bump the slice window. Match against the entire remainder of the file
    // after the panel start; the "disclosureBoxStyle" const that follows is
    // safely outside the panel.
    const panelBody = stripped.slice(panelStart, panelStart + 6000);
    expect(panelBody).not.toMatch(/INTEGRATIONS_ENABLED/);
    expect(panelBody).not.toMatch(/API_KEY_SECRET/);
    // Points admins at the deployment runbook instead.
    expect(panelBody).toMatch(/deployment runbook/);
  });

  it(".env.example documents the integrations env keys", () => {
    expect(ENV_EXAMPLE).toMatch(/INTEGRATIONS_ENABLED\s*=/);
    expect(ENV_EXAMPLE).toMatch(/API_KEY_SECRET\s*=/);
    expect(ENV_EXAMPLE).toMatch(/INTEGRATION_CRON_SECRET\s*=/);
  });

  it("disabled panel uses the canonical PHASE 1 title + body copy", () => {
    const stripped = PAGE
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const panelStart = stripped.indexOf("function IntegrationsDisabledPanel(");
    expect(panelStart).toBeGreaterThan(-1);
    const panelBody = stripped.slice(panelStart, panelStart + 6000);
    // Title (PHASE 1 required copy).
    expect(panelBody).toMatch(
      /Integrations are not available on this workspace\./,
    );
    // Body (PHASE 1 required copy — describes the operational state in
    // generic operator language without naming env-vars). Whitespace-
    // tolerant: the JSX renderer auto-wraps long strings across lines.
    const collapsed = panelBody.replace(/\s+/g, " ");
    expect(collapsed).toMatch(
      /Integrations are disabled because the API key signing secret is not configured in the running API environment\./,
    );
  });

  it("admin reason chip is gated on isAdmin AND diagnostics presence", () => {
    // The chip must NEVER render for normal users — guarded by isAdmin.
    expect(PAGE).toMatch(/isAdmin\s*&&\s*diagnostics\s*\?/);
    // The chip text follows the audit's "reason=…" shape.
    expect(PAGE).toMatch(/data-testid="integrations-disabled-reason-chip"/);
    expect(PAGE).toMatch(/reason=\{diagnostics\.reason\s*\?\?\s*"unknown"\}/);
  });

  it("disabled panel does NOT render a raw JSON blob", () => {
    const stripped = PAGE
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const panelStart = stripped.indexOf("function IntegrationsDisabledPanel(");
    const panelBody = stripped.slice(panelStart, panelStart + 6000);
    // No <pre> dump, no JSON.stringify call inside the panel body.
    expect(panelBody).not.toMatch(/<pre/);
    expect(panelBody).not.toMatch(/JSON\.stringify/);
  });

  it("admin diagnostics fetch is gated on (error === disabled) AND isAdmin", () => {
    // The diagnostics fetch effect must short-circuit for normal users.
    expect(PAGE).toMatch(
      /if\s*\(\s*error\s*!==\s*"INTEGRATIONS_DISABLED"\s*\)\s*return;\s*if\s*\(\s*!teamId\s*\|\|\s*!isAdmin\s*\)\s*return;/,
    );
    expect(PAGE).toMatch(
      /\/v1\/integrations\/diagnostics\?teamId=/,
    );
  });
});

describe("PHASE 1 — admin-only integrations diagnostics endpoint", () => {
  const ROUTES = readApi("src/routes/integrations.routes.ts");

  it("registers GET /v1/integrations/diagnostics", () => {
    expect(ROUTES).toMatch(/\/v1\/integrations\/diagnostics/);
    expect(ROUTES).toMatch(
      /app\.get\([\s\S]{0,80}\/v1\/integrations\/diagnostics/,
    );
  });

  it("requires OWNER or ADMIN role on the requested workspace", () => {
    // The handler must reject non-admin members explicitly. We match the
    // canonical denial form used elsewhere in the file.
    expect(ROUTES).toMatch(
      /ok\.role\s*!==\s*"OWNER"\s*&&\s*ok\.role\s*!==\s*"ADMIN"/,
    );
  });

  it("response payload never includes the raw secret or numeric length", () => {
    // Locate the diagnostics handler and check that it only sends the
    // canonical safe fields.
    const idx = ROUTES.indexOf("/v1/integrations/diagnostics");
    expect(idx).toBeGreaterThan(-1);
    const handlerSlice = ROUTES.slice(idx, idx + 2200);
    expect(handlerSlice).toMatch(/apiKeySecretBound/);
    expect(handlerSlice).toMatch(/apiKeySecretLengthValid/);
    expect(handlerSlice).toMatch(/cronSecretBound/);
    expect(handlerSlice).toMatch(/envSourceHint/);
    // Forbid leaking the raw env value or a numeric "length" field.
    expect(handlerSlice).not.toMatch(/process\.env\.API_KEY_SECRET[^?]/);
    expect(handlerSlice).not.toMatch(/secretLength\s*:/);
  });
});

describe("PHASE 1 — env.ts loader covers repo-root .env", () => {
  const ENV_LOADER = readApi("src/env.ts");

  it("loads <cwd>/../../.env in addition to <cwd>/.env and services/api/.env", () => {
    expect(ENV_LOADER).toMatch(/resolve\(process\.cwd\(\),\s*"\.\.\/\.\.\/\.env"\)/);
  });

  it("only fills undefined keys — never overwrites the real shell env", () => {
    // The first-writer-wins guard is the load-order invariant the
    // env layering depends on.
    expect(ENV_LOADER).toMatch(
      /if\s*\(\s*process\.env\[key\]\s*===\s*undefined\s*\)/,
    );
  });

  it("exposes a getEnvSourceHint() helper for safe diagnostics", () => {
    expect(ENV_LOADER).toMatch(/export\s+function\s+getEnvSourceHint/);
  });
});
