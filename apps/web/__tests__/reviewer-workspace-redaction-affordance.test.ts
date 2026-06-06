/**
 * PHASE 5 — Request Redaction affordance from Reviewer Workspace.
 *
 * The Reviewer Workspace EVIDENCE side-pane gains an honest entry-point
 * into the existing Redaction console. The affordance:
 *
 *   * Reads the canonical REVIEWER capability hint (the active space
 *     role label — server gating remains the source of truth).
 *   * Probes existing redaction projects (GET /v1/redaction/projects)
 *     so a duplicate POST is avoided when a project for this evidence
 *     already exists.
 *   * Opens (or surfaces the existing) project via POST
 *     /v1/redaction/projects — the canonical idempotent open. No new
 *     endpoint is introduced.
 *   * Distinguishes FORBIDDEN / ENTITLEMENT_REQUIRED / UNSUPPORTED_MIME
 *     / ERROR honestly — every catch surfaces a bounded operator-facing
 *     copy, never a fake success.
 *
 * What this test pins (Phase 5 hard rules):
 *
 *   1. No new endpoint: only `/v1/redaction/projects` (GET + POST)
 *      appears in the affordance code. No `/v1/reviewer/redaction/*`
 *      or other invented path.
 *
 *   2. The capability hint passes through `useActiveSpace()` (the
 *      canonical platform-context hook) and the affordance renders
 *      DISABLED — never hidden — when the operator role does not
 *      carry the redaction author capability.
 *
 *   3. The POST helper sends `artifactKind` mapped from `mimeType`
 *      via the canonical PDF / IMAGE / VIDEO / AUDIO enum (matching
 *      REDACTION_ARTIFACT_KINDS in packages/shared).
 *
 *   4. Anti-leak: no raw rationale / schema field / storage key
 *      content appears in the affordance code path.
 *
 *   5. All fetches wrapped in try/catch with a structured
 *      `console.warn` channel.
 *
 *   6. SLA / governance / escalations are NOT moved or relocated.
 *
 * Runs under Node's built-in `node:test`. Invoke with e.g.
 *   `node --test --import tsx \
 *      apps/web/__tests__/reviewer-workspace-redaction-affordance.test.ts`
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PAGE_PATH = resolve(
  __dirname,
  "..",
  "app",
  "(app)",
  "review",
  "workspace",
  "page.tsx",
);
const API_PATH = resolve(
  __dirname,
  "..",
  "lib",
  "reviewer-workspace",
  "reviewer-api.ts",
);
const EVIDENCE_PANE_PATH = resolve(
  __dirname,
  "..",
  "components",
  "reviewer-workspace",
  "SidePaneEvidence.tsx",
);

const PAGE_SOURCE = readFileSync(PAGE_PATH, "utf8");
const API_SOURCE = readFileSync(API_PATH, "utf8");
const PANE_SOURCE = readFileSync(EVIDENCE_PANE_PATH, "utf8");

// ---------------------------------------------------------------------------
// 1. Helper signatures + canonical endpoint targets.
// ---------------------------------------------------------------------------

test("reviewer-api exports inferRedactionArtifactKind covering the canonical four kinds", () => {
  assert.match(
    API_SOURCE,
    /export function inferRedactionArtifactKind\s*\(/,
    "reviewer-api.ts must export inferRedactionArtifactKind.",
  );
  // The four canonical kinds (REDACTION_ARTIFACT_KINDS in shared).
  for (const kind of ["PDF", "IMAGE", "VIDEO", "AUDIO"]) {
    assert.ok(
      new RegExp(`return\\s+"${kind}"`).test(API_SOURCE),
      `inferRedactionArtifactKind must map a mime branch to "${kind}".`,
    );
  }
});

test("reviewer-api exports lookupRedactionProjectForEvidence targeting GET /v1/redaction/projects", () => {
  assert.match(
    API_SOURCE,
    /export async function lookupRedactionProjectForEvidence\s*\(/,
    "reviewer-api.ts must export lookupRedactionProjectForEvidence.",
  );
  assert.match(
    API_SOURCE,
    /apiFetch\("\/v1\/redaction\/projects",\s*\{\s*method:\s*"GET"/,
    "lookupRedactionProjectForEvidence must call GET /v1/redaction/projects.",
  );
});

test("reviewer-api exports openRedactionProjectForEvidence targeting POST /v1/redaction/projects", () => {
  assert.match(
    API_SOURCE,
    /export async function openRedactionProjectForEvidence\s*\(/,
    "reviewer-api.ts must export openRedactionProjectForEvidence.",
  );
  assert.match(
    API_SOURCE,
    /apiFetch\("\/v1\/redaction\/projects",\s*\{\s*\n?\s*method:\s*"POST"/,
    "openRedactionProjectForEvidence must POST /v1/redaction/projects.",
  );
});

// ---------------------------------------------------------------------------
// 2. Bounded body shape on POST — evidenceId + artifactKind only.
// ---------------------------------------------------------------------------

test("openRedactionProjectForEvidence body includes evidenceId + artifactKind, plus optional title", () => {
  assert.match(
    API_SOURCE,
    /evidenceId:\s*input\.evidenceId/,
    "POST body must include evidenceId from input.",
  );
  assert.match(
    API_SOURCE,
    /artifactKind:\s*kind/,
    "POST body must include the inferred artifactKind.",
  );
  // Title is optional + bounded (backend caps at 200 chars).
  assert.match(
    API_SOURCE,
    /input\.title\.slice\(0,\s*200\)/,
    "Title must be bounded to 200 chars before send.",
  );
});

test("openRedactionProjectForEvidence rejects unsupported mime types BEFORE hitting the network", () => {
  // Ensure the early return precedes apiFetch by checking ordering.
  const fnBody = API_SOURCE.split(
    "export async function openRedactionProjectForEvidence",
  )[1] ?? "";
  const earlyReturnIdx = fnBody.indexOf("UNSUPPORTED_MIME");
  const apiFetchIdx = fnBody.indexOf("apiFetch");
  assert.ok(
    earlyReturnIdx > 0,
    "openRedactionProjectForEvidence must surface UNSUPPORTED_MIME for unknown kinds.",
  );
  assert.ok(
    apiFetchIdx > 0 && earlyReturnIdx < apiFetchIdx,
    "Unsupported-mime guard must run BEFORE the network call.",
  );
});

// ---------------------------------------------------------------------------
// 3. Denial classification — honest, no RATE_LIMITED collapse.
// ---------------------------------------------------------------------------

test("openRedactionProjectForEvidence distinguishes ENTITLEMENT_REQUIRED / FORBIDDEN / ERROR", () => {
  for (const reason of ["ENTITLEMENT_REQUIRED", "FORBIDDEN", "ERROR"]) {
    assert.ok(
      new RegExp(`reason:\\s*"${reason}"`).test(API_SOURCE),
      `Denial classifier must surface ${reason} explicitly.`,
    );
  }
  // No silent collapse to RATE_LIMITED — the affordance must
  // distinguish capability denial from generic throttling.
  const opener =
    API_SOURCE.split("export async function openRedactionProjectForEvidence")[1] ??
    "";
  assert.ok(
    !/RATE_LIMITED/.test(opener),
    "openRedactionProjectForEvidence must NOT collapse to RATE_LIMITED.",
  );
});

// ---------------------------------------------------------------------------
// 4. Both helpers wrap fetch in try/catch + structured warn.
// ---------------------------------------------------------------------------

test("both redaction helpers wrap apiFetch in try/catch with structured console.warn", () => {
  for (const fnName of [
    "lookupRedactionProjectForEvidence",
    "openRedactionProjectForEvidence",
  ]) {
    const slice = API_SOURCE.split(`export async function ${fnName}`)[1] ?? "";
    assert.ok(
      /try\s*\{/.test(slice) && /\}\s*catch/.test(slice),
      `${fnName} must wrap apiFetch in try/catch.`,
    );
    assert.ok(
      /console\.warn\(\s*"\[reviewer-workspace\]/.test(slice),
      `${fnName} must emit a bounded "[reviewer-workspace]" warn.`,
    );
  }
});

// ---------------------------------------------------------------------------
// 5. Side-pane wires the affordance + role-derived capability hint.
// ---------------------------------------------------------------------------

test("SidePaneEvidence imports the redaction helpers and accepts canRequestRedaction prop", () => {
  for (const symbol of [
    "inferRedactionArtifactKind",
    "lookupRedactionProjectForEvidence",
    "openRedactionProjectForEvidence",
  ]) {
    assert.ok(
      PANE_SOURCE.includes(symbol),
      `SidePaneEvidence must import ${symbol} from reviewer-api.`,
    );
  }
  assert.match(
    PANE_SOURCE,
    /canRequestRedaction\?:\s*boolean/,
    "SidePaneEvidence must accept the optional canRequestRedaction prop.",
  );
});

test("SidePaneEvidence renders the affordance button with data-capability-allowed attr", () => {
  assert.match(
    PANE_SOURCE,
    /data-request-redaction-btn/,
    "Affordance must expose a stable test selector data-request-redaction-btn.",
  );
  assert.match(
    PANE_SOURCE,
    /data-capability-allowed=\{canRequest\s*\?\s*"true"\s*:\s*"false"\}/,
    "Affordance must reflect capability state via data-capability-allowed.",
  );
  assert.match(
    PANE_SOURCE,
    /Request redaction/,
    "Button copy must read 'Request redaction'.",
  );
});

test("SidePaneEvidence keeps the button DISABLED but VISIBLE on denial / unsupported / unauthorised", () => {
  // The hard rule: cap-denied users must see a disabled control with
  // bounded explanation — never an invisible button.
  assert.match(
    PANE_SOURCE,
    /disabled=\{disabled\}/,
    "Affordance must use the `disabled` attribute, not hide the button.",
  );
  assert.match(
    PANE_SOURCE,
    /Redaction author capability is required/,
    "Disabled-by-role tooltip must name the capability requirement.",
  );
  assert.match(
    PANE_SOURCE,
    /Redaction is not supported for this evidence type/,
    "Unsupported-mime tooltip must be bounded and honest.",
  );
});

test("SidePaneEvidence routes to the EXISTING /redaction/[projectId] console on success", () => {
  assert.match(
    PANE_SOURCE,
    /href=\{`\/redaction\/\$\{phase\.projectId\}`\}/,
    "Success path must Link into the existing /redaction/[projectId] page — not a new route.",
  );
  assert.match(
    PANE_SOURCE,
    /data-request-redaction-link/,
    "Success link must expose stable selector data-request-redaction-link.",
  );
});

test("SidePaneEvidence distinguishes 'already exists' from 'just opened' honestly", () => {
  assert.match(
    PANE_SOURCE,
    /A redaction project already exists for this evidence\./,
    "When backend returns opened=false the copy must say the project already exists.",
  );
  assert.match(
    PANE_SOURCE,
    /Redaction project opened\./,
    "When backend returns opened=true the copy must say the project was opened.",
  );
});

test("SidePaneEvidence denial copy avoids RATE_LIMITED collapse", () => {
  for (const reason of ["FORBIDDEN", "ENTITLEMENT_REQUIRED", "UNSUPPORTED_MIME", "ERROR"]) {
    assert.ok(
      new RegExp(`case\\s+"${reason}"`).test(PANE_SOURCE),
      `denialCopy() must have a bounded branch for ${reason}.`,
    );
  }
  assert.ok(
    !/RATE_LIMITED/.test(PANE_SOURCE),
    "Affordance UI must not collapse to a misleading RATE_LIMITED message.",
  );
});

// ---------------------------------------------------------------------------
// 6. Workspace page wires useActiveSpace + passes canRequestRedaction.
// ---------------------------------------------------------------------------

test("workspace page derives canRequestRedaction from useActiveSpace role label", () => {
  assert.match(
    PAGE_SOURCE,
    /import\s*\{\s*useActiveSpace\s*\}\s*from\s*"\.\.\/\.\.\/\.\.\/\.\.\/lib\/platform-context"/,
    "Workspace page must import useActiveSpace from the canonical platform-context.",
  );
  assert.match(
    PAGE_SOURCE,
    /const\s+canRequestRedaction\s*=/,
    "Workspace page must derive a canRequestRedaction flag.",
  );
  // The DB-level OWNER / ADMIN / MEMBER role labels carry
  // redaction.region.author per packages/shared/permissions.ts.
  // VIEWER (and missing role) must NOT pass the hint.
  for (const role of ["OWNER", "ADMIN", "MEMBER"]) {
    assert.ok(
      new RegExp(`roleLabel\\s*===\\s*"${role}"`).test(PAGE_SOURCE),
      `canRequestRedaction derivation must accept ${role}.`,
    );
  }
  assert.ok(
    !/roleLabel\s*===\s*"VIEWER"/.test(PAGE_SOURCE),
    "VIEWER must not be granted the redaction capability hint.",
  );
});

test("workspace page passes canRequestRedaction down to SidePaneEvidence", () => {
  assert.match(
    PAGE_SOURCE,
    /<SidePaneEvidence[\s\S]*?canRequestRedaction=\{canRequestRedaction\}/,
    "SidePaneEvidence must receive the canRequestRedaction prop from the page.",
  );
});

// ---------------------------------------------------------------------------
// 7. Hard-rule anti-leak + no relocations.
// ---------------------------------------------------------------------------

test("affordance code never references invented endpoints or relocates SLA/escalations", () => {
  // No new endpoint may be introduced.
  assert.ok(
    !/\/v1\/reviewer\/redaction/.test(API_SOURCE),
    "No /v1/reviewer/redaction/* surface may be introduced.",
  );
  assert.ok(
    !/\/v1\/redaction\/projects\/by-evidence/.test(API_SOURCE),
    "No invented by-evidence read route is allowed; use GET list + client-side filter.",
  );
  // SLA and escalations have NOT moved under workflows.
  assert.ok(
    !/\/workflows\/sla/.test(PAGE_SOURCE),
    "SLA must not be relocated under /workflows in this phase.",
  );
  assert.ok(
    !/\/workflows\/escalations/.test(PAGE_SOURCE),
    "Escalations must not be relocated under /workflows in this phase.",
  );
});

test("affordance code never leaks raw rationale / schema field bodies / storage keys", () => {
  // Strip block comments + line comments so doc references to
  // forbidden tokens (these legitimately appear in the file's
  // hard-rule documentation header) do not trigger the guard.
  const stripped = PANE_SOURCE
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  // Loose anti-leak guards — these tokens should never appear in
  // the operator-visible side-pane code path.
  for (const forbidden of [
    "storageBucket",
    "storageKey",
    "signedPreviewUrl",
    "extractedText",
    "rationaleBody",
  ]) {
    assert.ok(
      !stripped.includes(forbidden),
      `Affordance UI code must not reference ${forbidden}.`,
    );
  }
});

test("affordance helpers do NOT request redaction version/region downstream mutations", () => {
  // The affordance is OPEN-only. Version / region / publish surfaces
  // belong on the existing /redaction/[projectId] console. Scope the
  // check to the two redaction helpers (the broader file legitimately
  // calls /v1/reviewer-ops/reviews/:id/approve for review decisions).
  for (const fnName of [
    "lookupRedactionProjectForEvidence",
    "openRedactionProjectForEvidence",
  ]) {
    const slice = API_SOURCE.split(`export async function ${fnName}`)[1] ?? "";
    const upTo = slice.indexOf("\nexport ");
    const fnBody = upTo > 0 ? slice.slice(0, upTo) : slice;
    for (const downstream of [
      "/v1/redaction/versions",
      "/v1/redaction/regions",
      "/v1/redaction/projects/${input.evidenceId}/versions",
      "/submit",
      "/publish",
    ]) {
      assert.ok(
        !fnBody.includes(downstream),
        `${fnName} must not call ${downstream} — those belong to the existing redaction console.`,
      );
    }
  }
});
