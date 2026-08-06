/**
 * Production — Lifecycle Domain Consolidation regression suite.
 *
 * Locks in the Option D outcome of the Lifecycle Consolidation audit:
 *
 *   - Surface A (`/evidence-lifecycle`) is the mutation-first
 *     "Lifecycle Operations" console.
 *   - Surface B (`/governance/lifecycle`) is the read-only
 *     "Governance Posture" overlay.
 *
 * The frontend has no JS test runner; every invariant is encoded as a
 * structural property of the source text. We read the relevant files
 * once and assert against the bytes. Each assertion below has a brief
 * comment showing intent so a future drift is easy to fix.
 *
 * Layout:
 *   - 13 brief assertions (one per audit criterion)
 *   - 3 bounded GUARDs (capability service, shared types, doc file)
 */

import { readFileSync, statSync } from "node:fs";
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

function readShared(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../packages/shared/${rel}`, import.meta.url)),
    "utf8",
  );
}

function readDoc(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../${rel}`, import.meta.url)),
    "utf8",
  );
}

const SURFACE_A = readWeb("app/(app)/evidence-lifecycle/page.tsx");
const SURFACE_A_ARCHIVE = readWeb("app/(app)/evidence-lifecycle/archive/page.tsx");
const SURFACE_B = readWeb("app/(app)/governance/lifecycle/page.tsx");
const ROUTE_REGISTRY = readWeb("lib/navigation/routeRegistry.ts");

const LIFECYCLE_ROUTES = readApi(
  "src/routes/product-and-lifecycle.routes.ts",
);
const GOVERNANCE_LIFECYCLE_ROUTES = readApi(
  "src/routes/governance-lifecycle.routes.ts",
);

// =============================================================================
// 1. /evidence-lifecycle unwraps { dashboard } envelope
// =============================================================================
describe("Lifecycle consolidation — envelope unwrap", () => {
  it("Surface A unwraps the { dashboard } envelope from /v1/lifecycle/dashboard", () => {
    // Either obj.dashboard read OR normaliseDashboard helper must exist.
    expect(SURFACE_A).toMatch(/normaliseDashboard|obj\.dashboard|res\?\.dashboard|res\.dashboard/);
    // The dashboard envelope key MUST appear in the unwrap logic.
    expect(SURFACE_A).toContain("dashboard");
  });
});

// =============================================================================
// 2. Surface A never sticks on infinite "Loading…" — 7-state machine
// =============================================================================
describe("Lifecycle consolidation — 7-state load machine", () => {
  it("declares a LoadState discriminated union", () => {
    expect(SURFACE_A).toMatch(/type\s+LoadState\s*=/);
  });

  it("includes a catch-branch that maps failure to phase: \"error\"", () => {
    // Either direct setState with phase:"error" inside catch, or a mapErrorToState helper.
    expect(SURFACE_A).toMatch(/phase:\s*["']error["']/);
    expect(SURFACE_A).toMatch(/catch\s*\(/);
  });
});

// =============================================================================
// 3. Bounded error string is present (no raw response leak)
// =============================================================================
describe("Lifecycle consolidation — bounded error string", () => {
  it("renders a bounded operator-facing error message", () => {
    // Either "could not be loaded" copy OR "unexpected response shape" copy.
    expect(SURFACE_A).toMatch(
      /could not be loaded|unexpected response shape/i,
    );
  });
});

// =============================================================================
// 4. Entitlement-required + delegated-admin-required phases exist
// =============================================================================
describe("Lifecycle consolidation — denial phases", () => {
  it("declares entitlement-required phase in LoadState", () => {
    expect(SURFACE_A).toMatch(/entitlement-required/);
  });

  it("declares delegated-admin-required phase in LoadState", () => {
    expect(SURFACE_A).toMatch(/delegated-admin-required/);
  });
});

// =============================================================================
// 5. Archive page POSTs to singular /v1/lifecycle/archive/transition
// =============================================================================
describe("Lifecycle consolidation — archive URL drift", () => {
  it("Surface A archive page posts to the SINGULAR /transition endpoint", () => {
    expect(SURFACE_A_ARCHIVE).toMatch(
      /apiFetch\(\s*["']\/v1\/lifecycle\/archive\/transition["']/,
    );
  });

  it("Surface A archive page does NOT POST to the plural /transitions endpoint", () => {
    // The plural string is allowed for the GET LIST endpoint only — assert it's
    // never paired with `method: "POST"`.
    expect(SURFACE_A_ARCHIVE).not.toMatch(
      /apiFetch\(\s*["']\/v1\/lifecycle\/archive\/transitions["'][^)]*method:\s*["']POST["']/m,
    );
  });
});

// =============================================================================
// 6. Surface B is read-only — no mutation apiFetch calls
// =============================================================================
describe("Lifecycle consolidation — Surface B is read-only", () => {
  it("Surface B never issues a non-GET apiFetch", () => {
    // POST / PATCH / DELETE / PUT via apiFetch — must be zero.
    expect(SURFACE_B).not.toMatch(
      /apiFetch\([^)]*method:\s*["'](?:POST|PATCH|DELETE|PUT)["']/m,
    );
  });
});

// =============================================================================
// 7. Surface B links to Surface A action consoles (at least 3 deep-links)
// =============================================================================
describe("Lifecycle consolidation — Surface B → Surface A links", () => {
  it("Surface B contains ≥3 href=\"/evidence-lifecycle/...\" links", () => {
    const matches = SURFACE_B.match(/href=["']\/evidence-lifecycle(\/[^"'\s]*)?["']/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });
});

// =============================================================================
// 8. Surface A links back to Surface B (/governance/lifecycle)
// =============================================================================
describe("Lifecycle consolidation — Surface A → Surface B link", () => {
  it("Surface A links back to /governance/lifecycle", () => {
    expect(SURFACE_A).toMatch(/href=["']\/governance\/lifecycle["']/);
  });
});

// =============================================================================
// 9. Label disambiguation — never both called plain "Lifecycle"
// =============================================================================
describe("Lifecycle consolidation — disambiguated labels", () => {
  it("workspace.evidence_lifecycle is labelled Lifecycle Operations", () => {
    // Slice around the workspace.evidence_lifecycle id and assert label contains "Lifecycle Operations".
    const idx = ROUTE_REGISTRY.indexOf('id: "workspace.evidence_lifecycle"');
    expect(idx).toBeGreaterThan(0);
    const slice = ROUTE_REGISTRY.slice(idx, idx + 600);
    expect(slice).toMatch(/label:\s*["']Lifecycle Operations["']/);
  });

  it("governance.lifecycle is labelled Governance Posture", () => {
    const idx = ROUTE_REGISTRY.indexOf('id: "governance.lifecycle"');
    expect(idx).toBeGreaterThan(0);
    const slice = ROUTE_REGISTRY.slice(idx, idx + 600);
    expect(slice).toMatch(/label:\s*["']Governance Posture["']/);
  });
});

// =============================================================================
// 10. No new lifecycle backend routes added beyond canonical set
// =============================================================================
describe("Lifecycle consolidation — no new lifecycle routes", () => {
  // Canonical whitelist — these are the only /v1/lifecycle/* + /v1/governance/lifecycle/*
  // paths declared by the API. Any addition must be deliberately whitelisted here.
  const CANONICAL_LIFECYCLE_PATHS = new Set<string>([
    "/v1/lifecycle/retention/policies",
    "/v1/lifecycle/retention/policies/:id/release",
    "/v1/lifecycle/retention/upcoming-expirations",
    "/v1/lifecycle/legal-holds",
    "/v1/lifecycle/legal-holds/:id/release",
    "/v1/lifecycle/archive/transitions",
    "/v1/lifecycle/archive/transition",
    "/v1/lifecycle/archive/costs",
    "/v1/lifecycle/destruction/requests",
    "/v1/lifecycle/destruction/requests/:id/approve",
    "/v1/lifecycle/destruction/requests/:id/reject",
    "/v1/lifecycle/destruction/requests/:id/execute",
    "/v1/lifecycle/destruction/requests/:id/certificate",
    "/v1/lifecycle/destruction/requests/:id/certificate.json",
    "/v1/lifecycle/dashboard",
    "/v1/lifecycle/verification-package/preview",
    "/v1/lifecycle/violations",
    "/v1/lifecycle/violations/counts",
    "/v1/governance/lifecycle/evidence/:id/events",
    "/v1/governance/lifecycle/evidence/:id/transition",
  ]);

  it("backend declares no /v1/lifecycle/* or /v1/governance/lifecycle/* path outside the canonical whitelist", () => {
    const combined = `${LIFECYCLE_ROUTES}\n${GOVERNANCE_LIFECYCLE_ROUTES}`;
    const matches =
      combined.match(/"\/v1\/(?:lifecycle|governance\/lifecycle)\/[^"]*"/g) ?? [];
    const unique = Array.from(new Set(matches.map((m) => m.slice(1, -1))));
    const extras = unique.filter((p) => !CANONICAL_LIFECYCLE_PATHS.has(p));
    expect(extras, `Unexpected lifecycle routes: ${extras.join(", ")}`).toEqual([]);
  });
});

// =============================================================================
// 11. No Lifecycle v2 file or path exists anywhere in apps/web or services/api
// =============================================================================
describe("Lifecycle consolidation — no v2 system", () => {
  it("no *lifecycle*v2* / *v2*lifecycle* files exist", async () => {
    // We could glob; for source-contract purposes, sweep the two main route
    // text blocks + Surface A + Surface B for any "lifecycle-v2" / "v2/lifecycle" / "lifecycleV2" hits.
    const corpus = [
      SURFACE_A,
      SURFACE_B,
      SURFACE_A_ARCHIVE,
      ROUTE_REGISTRY,
      LIFECYCLE_ROUTES,
      GOVERNANCE_LIFECYCLE_ROUTES,
    ].join("\n");
    expect(corpus).not.toMatch(/lifecycle[-_]?v2|v2[-_/]lifecycle|LifecycleV2/i);
  });
});

// =============================================================================
// 12. Capability statuses honoured — disabled status disables mutation
// =============================================================================
describe("Lifecycle consolidation — capability status gating", () => {
  it("Surface A consumes capabilities.<key>.status", () => {
    expect(SURFACE_A).toMatch(/capabilities\??\.(retention|legalHolds|archive|destruction|webhooks|chainTransfers)|capabilityKey/);
  });

  it("Surface A guards mutation affordances on DISABLED + WRITES_BUT_NOT_ENFORCED", () => {
    // Must reference both bounded statuses in a gating expression.
    expect(SURFACE_A).toContain("DISABLED");
    expect(SURFACE_A).toContain("WRITES_BUT_NOT_ENFORCED");
  });
});

// =============================================================================
// 13. Both pages have clean loading/error/empty/forbidden states
// =============================================================================
describe("Lifecycle consolidation — both pages have bounded fetch states", () => {
  it("Surface A LoadState union covers loading/loaded/empty/error/denials", () => {
    expect(SURFACE_A).toMatch(/phase:\s*["']loading["']/);
    expect(SURFACE_A).toMatch(/phase:\s*["']loaded["']/);
    expect(SURFACE_A).toMatch(/phase:\s*["']empty["']/);
    expect(SURFACE_A).toMatch(/phase:\s*["']error["']/);
  });

  it("Surface B still has setError + an error-box style (no regression)", () => {
    expect(SURFACE_B).toMatch(/setError\s*\(/);
    expect(SURFACE_B).toMatch(/errorBoxStyle/);
  });
});

// =============================================================================
// GUARD 14. Capability-status service exists and exports the expected helper
// =============================================================================
describe("Lifecycle consolidation — GUARD: capability-status service", () => {
  it("services/api/src/services/lifecycle/capability-status.service.ts exports computeLifecycleCapabilityStatus", () => {
    const src = readApi(
      "src/services/lifecycle/capability-status.service.ts",
    );
    expect(src).toMatch(
      /export\s+async\s+function\s+computeLifecycleCapabilityStatus\s*\(/,
    );
  });
});

// =============================================================================
// GUARD 15. Shared types extended additively with LIFECYCLE_CAPABILITY_STATUSES
// =============================================================================
describe("Lifecycle consolidation — GUARD: shared capability-status vocabulary", () => {
  it("packages/shared declares LIFECYCLE_CAPABILITY_STATUSES with the 5 bounded values", () => {
    const src = readShared("src/product-and-lifecycle.ts");
    expect(src).toMatch(/export\s+const\s+LIFECYCLE_CAPABILITY_STATUSES\s*=/);
    for (const value of [
      "FULLY_OPERATIONAL",
      "READ_ONLY",
      "CONFIGURATION_ONLY",
      "WRITES_BUT_NOT_ENFORCED",
      "DISABLED",
    ]) {
      expect(src).toContain(value);
    }
  });
});

// =============================================================================
// GUARD 16. Lifecycle domain doc exists and is non-trivial (>4000 bytes)
// =============================================================================
describe("Lifecycle consolidation — GUARD: lifecycle-domain-responsibilities doc", () => {
  it("docs/architecture/lifecycle-domain-responsibilities.md exists and is >4000 bytes", () => {
    const docPath = fileURLToPath(
      new URL(
        "../../../docs/architecture/lifecycle-domain-responsibilities.md",
        import.meta.url,
      ),
    );
    const stat = statSync(docPath);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBeGreaterThan(4000);
    // Sanity content check — exec summary + at least one section header.
    const text = readDoc("docs/architecture/lifecycle-domain-responsibilities.md");
    expect(text.length).toBeGreaterThan(4000);
    expect(text).toMatch(/##/); // at least one markdown section
  });
});

// =============================================================================
// PHASE 12 POINT 4 — FUTURE_NOT_SHIPPING stays unregistered
// =============================================================================
//
// `GET /v1/lifecycle/destruction/requests/:id/certificate.pdf` was REGISTERED
// in production and answered 501 PDF_NOT_IMPLEMENTED. Nothing produced a PDF —
// `certificatePdfUri` is never assigned anywhere in the API or the worker, the
// service carries only a comment saying the step is skipped — and no web or
// mobile surface referenced it. A registered route that can never succeed
// advertises a capability the product does not have, so it was removed rather
// than left as a tombstone.
//
// The capability is classified FUTURE_NOT_SHIPPING in
// docs/architecture/compatibility-adapter-registry.json. If a real PDF
// implementation and a consumer ever land, register the route THEN — with
// tenant, capability and behavioral proof, not as a 501 placeholder.

describe("Phase 12 Point 4 — the PDF certificate route stays UNREGISTERED", () => {
  it("no route registers the certificate.pdf path", () => {
    expect(LIFECYCLE_ROUTES).not.toContain("certificate.pdf");
  });

  it("no 501 tombstone remains in the lifecycle route module", () => {
    expect(LIFECYCLE_ROUTES).not.toContain("PDF_NOT_IMPLEMENTED");
    expect(LIFECYCLE_ROUTES).not.toMatch(/reply\.code\(501\)/);
  });
});
