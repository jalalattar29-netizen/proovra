/**
 * Phase 32.6.4 — Frontend runtime/governance/workspace UX hotfix
 * regression guards (source-contract).
 *
 * apps/web has no JS test runner today (`pnpm --filter proovra-web
 * test` is a stub) so the tests below run inside the API test suite
 * and read the web source files directly. They assert structural
 * properties of the source that are easy to regress:
 *
 *   1. Governance page uses `Promise.allSettled` (NOT `Promise.all`)
 *      so a 503 on `/policy` does not blank every widget.
 *   2. Governance page does NOT open-code `/v1/users/me` — it must
 *      use the canonical `useActiveWorkspaceId` hook (which has the
 *      `/v1/teams` fallback the topbar uses).
 *   3. Ops page uses `Promise.allSettled` + the canonical workspace
 *      hook (same two contract checks as the governance page).
 *   4. The verification-package click handler inspects either
 *      `data.code` on the 2xx path or `e.statusCode` / `e.code` on
 *      the error path — i.e. it does NOT just look at `data.url`.
 *   5. `useGlobalRuntimeState` resets readiness/incidents/escalations
 *      explicitly on teamId transitions and uses a generation guard
 *      to drop stale in-flight responses.
 *   6. AppSidebarV2 resolves `role` from `useActiveWorkspaceId`
 *      (not just from the explicit prop), so role-gated nav items
 *      can actually appear for OWNER/ADMIN even when AppShellV2
 *      doesn't pass anything.
 *   7. `useActiveWorkspaceId` surfaces a bounded `role` field on
 *      the `ready` branch.
 *   8. No forbidden vocabulary (fake/forged/manipulated/tampered/
 *      authentic/admissible/proves/confirms) was added to the
 *      hotfixed surfaces.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readWebSource(rel: string): string {
  // services/api/test/<this file> → ../../../apps/web/<rel>
  const url = new URL(`../../../apps/web/${rel}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

function readApiSource(rel: string): string {
  const url = new URL(`../${rel}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

const FORBIDDEN_VOCAB = [
  "fake",
  "forged",
  "manipulated",
  "tampered",
  "authentic",
  "admissible",
  "proves",
  "confirms",
] as const;

function assertNoForbiddenVocab(label: string, source: string): void {
  // Only check tokens that appear in operator-facing strings. We
  // exclude:
  //   - import/export identifiers (matched as part of longer
  //     identifiers like `confirmDialog` — the substring match would
  //     misfire)
  // The simplest approach: lowercase the source and check for
  // exact-word matches via word-boundary regex. Identifiers like
  // `confirmDialog` will not match `\bconfirms\b`.
  const lower = source.toLowerCase();
  for (const word of FORBIDDEN_VOCAB) {
    const re = new RegExp(`\\b${word}\\b`);
    if (re.test(lower)) {
      throw new Error(
        `Phase 32.6.4 vocabulary violation in ${label}: forbidden token "${word}" appears in operator-facing source. Use bounded alternatives: "unavailable" / "temporarily unavailable" / "blocked by governance policy" / "still being generated" / "permission required" / "workspace required" / "retry shortly".`,
      );
    }
  }
}

describe("Phase 32.6.4 — Governance page resilience (Phase 32.8E architecture)", () => {
  // Phase 32.8E — /governance is now a thin wrapper around the
  // GovernanceControlPlane component. The resilience invariants are
  // preserved by the BACKEND aggregator (per-section try/catch +
  // per-section status enum) rather than by client-side
  // `Promise.allSettled`. Assert on the new component + service.
  const pageSrc = readWebSource("app/(app)/governance/page.tsx");
  const panelSrc = readWebSource(
    "components/governance-experience/GovernanceControlPlane.tsx",
  );
  const serviceSrc = readFileSync(
    fileURLToPath(
      new URL(
        "../src/services/governance/governance-control-plane.service.ts",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  it("/governance page delegates to GovernanceControlPlane (no Promise.all([...]) defect possible)", () => {
    expect(pageSrc).toMatch(/<GovernanceControlPlane\s*\/>/);
  });

  it("backend aggregator wraps each section in try/catch (partial-failure tolerant)", () => {
    // The previous Phase 32.6.4 client-side defect was that one
    // failed widget killed the page. The Phase 32.8E aggregator
    // moves that resilience to the server: each section has its
    // own try/catch so the envelope is never half-built.
    const tryCount = (serviceSrc.match(/try\s*\{/g) ?? []).length;
    const catchCount = (serviceSrc.match(/catch\s*[({]/g) ?? []).length;
    expect(tryCount).toBeGreaterThanOrEqual(5);
    expect(catchCount).toBeGreaterThanOrEqual(5);
  });

  it("page state machine has loading / ready / error / unavailable branches", () => {
    expect(panelSrc).toContain('status: "loading"');
    expect(panelSrc).toContain('status: "ready"');
    expect(panelSrc).toContain('status: "auth_error"');
    expect(panelSrc).toContain('status: "unavailable"');
  });

  it("uses bounded UX wording (no forbidden vocabulary)", () => {
    assertNoForbiddenVocab("governance/page.tsx", pageSrc);
    assertNoForbiddenVocab(
      "governance-experience/GovernanceControlPlane.tsx",
      panelSrc,
    );
  });

  it("preserves operator-safe error messages (no raw API leakage)", () => {
    // The new architecture maps backend HTTP statuses to bounded
    // client-side states (auth_error vs unavailable) — raw err.message
    // is only surfaced inside the bounded ShellUnavailable copy.
    expect(panelSrc).toMatch(/statusCode === 401/);
    expect(panelSrc).toMatch(/statusCode === 403/);
    // The Phase 14 case-legal-holds drift handling moved to the
    // backend service — surfaced via `caseLegalHoldsEnabled`.
    expect(serviceSrc).toContain("caseLegalHoldsEnabled");
  });
});

describe("Phase 32.6.4 — Ops page resilience", () => {
  const src = readWebSource("app/(app)/operations/page.tsx");

  it("uses Promise.allSettled (NOT Promise.all)", () => {
    expect(src).toContain("Promise.allSettled");
    const allCalls = src.match(/Promise\.all\(\[/g) ?? [];
    expect(allCalls.length).toBe(0);
  });

  it("each source has independent loading / ready / error state", () => {
    // The panels changed when the tenant workbench stopped rendering PLATFORM
    // runtime. `healthPanel` and `metricsPanel` read /v1/ops/health and
    // /v1/ops/metrics — database status, Sentry status, process uptime,
    // in-process counters — which describe the API process, are identical for
    // every tenant on the instance, and no tenant can act on any of them.
    // They live on /admin/platform/observability.
    //
    // The property under test is unchanged: one source failing must not blank
    // the others. It now covers the three sources this route DOES read.
    expect(src).toContain("SourceState");
    expect(src).toContain("setSummary({ kind: \"error\"");
    expect(src).toContain("setIncidents({");
    expect(src).toContain("setDetail({ kind: \"error\"");
    // And the two retired ones are genuinely gone, not merely unrendered.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toContain("healthPanel");
    expect(code).not.toContain("metricsPanel");
  });

  it("uses bounded UX wording (no forbidden vocabulary)", () => {
    assertNoForbiddenVocab("ops/page.tsx", src);
  });
});

describe("Phase 32.6.4 — Verification-package status-code handling", () => {
  const src = readWebSource("app/(app)/evidence/[id]/page.tsx");

  it("downloadVerificationPackage inspects bounded error codes", () => {
    // The handler must distinguish at least these bounded backend
    // signals.
    expect(src).toContain("verification_package_pending");
    expect(src).toContain("verification_package_blocked");
    expect(src).toContain("verification_package_unavailable");
    expect(src).toContain("verification_package_not_found");
    expect(src).toContain("PACKAGE_BLOCKED_BY_POLICY");
    expect(src).toContain("GOVERNANCE_CHECK_FAILED");
  });

  it("downloadVerificationPackage inspects HTTP status codes for fallback", () => {
    // Locate the verification-package handler region (between its
    // declaration and the next sibling helper) to ensure these
    // checks live inside the handler, not somewhere else in the
    // file.
    const handlerStart = src.indexOf("const downloadVerificationPackage");
    expect(handlerStart).toBeGreaterThan(-1);
    const handlerEnd = src.indexOf("\n  };", handlerStart);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    const handler = src.slice(handlerStart, handlerEnd);
    expect(handler).toMatch(/statusCode/);
    expect(handler).toMatch(/case 202|case 409|case 410|case 503/);
  });

  it("downloadVerificationPackage does NOT silently swallow non-url 2xx", () => {
    // The previous defect: `if (!data.url) addToast("not available")`
    // — collapsing 202 pending and 410 unavailable into the same
    // generic message. The new code must distinguish at least the
    // pending case before any catch-all message.
    const idx = src.indexOf("verification_package_pending");
    const fallback = src.indexOf(
      "Verification package is temporarily unavailable",
    );
    expect(idx).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(idx);
  });

  it("does not surface raw storage internals (signed URL / bucket / key) in toast", () => {
    // The user-facing toast must NEVER include the words "bucket",
    // "storage key", "signed url" — those are internal details.
    const handlerStart = src.indexOf("const downloadVerificationPackage");
    const handlerEnd = src.indexOf("\n  };", handlerStart);
    const handler = src.slice(handlerStart, handlerEnd).toLowerCase();
    expect(handler).not.toMatch(/addtoast\([^)]*bucket/);
    expect(handler).not.toMatch(/addtoast\([^)]*signed.?url/);
    expect(handler).not.toMatch(/addtoast\([^)]*storage.?key/);
  });
});

describe("Phase 32.6.4 — Global runtime state clear-on-null + generation guard", () => {
  const src = readWebSource("lib/useGlobalRuntimeState.ts");

  it("explicitly clears state when teamId becomes null", () => {
    // The null-teamId branch must set readiness/incidents/escalations
    // to their empty equivalents, not just stop polling.
    const nullBranchStart = src.indexOf("if (!teamId) {");
    expect(nullBranchStart).toBeGreaterThan(-1);
    const nullBranchEnd = src.indexOf("return;", nullBranchStart);
    const branch = src.slice(nullBranchStart, nullBranchEnd);
    expect(branch).toMatch(/setReadiness\(null\)/);
    expect(branch).toMatch(/setIncidents\(\[\]\)/);
    expect(branch).toMatch(/setEscalations\(\[\]\)/);
  });

  it("uses a request-generation counter to drop stale in-flight responses", () => {
    expect(src).toContain("generationRef");
    expect(src).toMatch(/generationRef\.current !== myGeneration/);
  });

  it("resets state on every teamId transition (not only null)", () => {
    // Look for an explicit clear OUTSIDE the null branch — i.e.
    // after `const myGeneration = ++generationRef.current;` we
    // expect to see setReadiness(null) again.
    const ackIdx = src.indexOf("const myGeneration = ++generationRef.current");
    expect(ackIdx).toBeGreaterThan(-1);
    const tickOnceIdx = src.indexOf("async function tickOnce", ackIdx);
    expect(tickOnceIdx).toBeGreaterThan(ackIdx);
    const between = src.slice(ackIdx, tickOnceIdx);
    expect(between).toMatch(/setReadiness\(null\)/);
    expect(between).toMatch(/setLoading\(true\)/);
  });
});

describe("Phase 32.6.4 — Diagnostic runbook ships and is read-only", () => {
  const doc = readApiSource("docs/phase-32-6-4-governance-503-diagnosis.md");

  it("documents only read-only SQL", () => {
    // No DDL / DML statements in the runbook content.
    expect(doc).not.toMatch(/\bDROP\s+(TABLE|COLUMN|TYPE|INDEX)/i);
    expect(doc).not.toMatch(/\bTRUNCATE\b/i);
    expect(doc).not.toMatch(/\bUPDATE\s+["a-z]/i);
    expect(doc).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(doc).not.toMatch(/\bALTER\s+TABLE\b/i);
  });

  it("explicitly states no auto-apply", () => {
    expect(doc).toMatch(/does NOT auto-apply/i);
  });

  it("references the bounded 503 emitter", () => {
    expect(doc).toContain("runGovernanceHandler");
    expect(doc).toContain("governance_schema_unavailable");
  });
});
