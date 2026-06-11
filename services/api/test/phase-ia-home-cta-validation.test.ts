/**
 * Phase IA-home-final — Home CTA route validation.
 *
 * Every CTA the Home emits must point at a route that actually
 * renders. This test enumerates the static href targets in the Home
 * components + view model and asserts each one resolves to:
 *   - a real Next.js page file under app/(app)/, OR
 *   - the public verify page (app/verify/[token]), OR
 *   - a backend API download URL (/v1/evidence/:id/...), OR
 *   - a query-param variant of an existing page.
 *
 * It also FAILS on the known-bad targets the brief banned:
 *   - bare /evidence-requests (list page does not ship)
 *   - /workspaces (hidden/empty for self-serve)
 *   - /v/:id (wrong public-verify path — must be /verify/:id)
 */

import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function webPath(rel: string): string {
  return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}
function readWeb(rel: string): string {
  return readFileSync(webPath(rel), "utf8");
}
function pageExists(route: string): boolean {
  // Strip query string + leading slash; map dynamic :id → [id]-style dir.
  const clean = route.split("?")[0].replace(/^\//, "");
  if (clean === "") return existsSync(webPath("app/(app)/home/page.tsx"));
  // /verify lives outside the (app) group.
  if (clean === "verify" || clean.startsWith("verify/")) {
    return existsSync(webPath("app/verify/[token]/page.tsx"));
  }
  // Dynamic segment: first path part is the dir, the rest is [id].
  const parts = clean.split("/");
  const base = parts[0];
  if (parts.length === 1) {
    return existsSync(webPath(`app/(app)/${base}/page.tsx`));
  }
  // e.g. evidence/:id → app/(app)/evidence/[id]/page.tsx
  return (
    existsSync(webPath(`app/(app)/${base}/[id]/page.tsx`)) ||
    existsSync(webPath(`app/(app)/${base}/[token]/page.tsx`))
  );
}

// ============================================================================
// The complete CTA map the Home emits (static targets + dynamic templates).
// Each entry: { label, route, kind }.
// ============================================================================

type Cta = { label: string; route: string; kind: "page" | "page-dynamic" | "api" | "verify" };

const HOME_CTAS: Cta[] = [
  { label: "Needs Attention (capture)", route: "/capture", kind: "page" },
  { label: "Needs Attention (reports)", route: "/reports", kind: "page" },
  { label: "Needs Attention (intake)", route: "/intake-links", kind: "page" },
  { label: "Needs Attention (evidence)", route: "/evidence", kind: "page" },
  { label: "Needs Attention (cases)", route: "/cases", kind: "page" },
  { label: "Submissions — All submissions", route: "/inbox", kind: "page" },
  { label: "Submissions — Review (per row)", route: "/evidence-requests/r-1", kind: "page-dynamic" },
  { label: "Request&Collect — manage", route: "/intake-links", kind: "page" },
  { label: "Request&Collect — create (?new=1)", route: "/intake-links?new=1", kind: "page" },
  { label: "Request&Collect — open link (?linkId=)", route: "/intake-links?linkId=lk-1", kind: "page" },
  { label: "Recent Evidence — row", route: "/evidence/ev-1", kind: "page-dynamic" },
  { label: "Recent Evidence — all", route: "/evidence", kind: "page" },
  { label: "Recent Reports — open", route: "/evidence/ev-1", kind: "page-dynamic" },
  { label: "Recent Reports — PDF", route: "/v1/evidence/ev-1/report/latest", kind: "api" },
  { label: "Recent Reports — package", route: "/v1/evidence/ev-1/verification-package", kind: "api" },
  { label: "Recent Reports — verify page", route: "/verify/ev-1", kind: "verify" },
  { label: "Trust State — capture first", route: "/capture", kind: "page" },
  { label: "Trust State — view evidence", route: "/evidence", kind: "page" },
  { label: "Case Health — open case", route: "/cases/c-1", kind: "page-dynamic" },
  { label: "Case Health — all cases", route: "/cases", kind: "page" },
  { label: "Activity — fallback", route: "/inbox", kind: "page" },
  { label: "Storage — billing", route: "/billing", kind: "page" },
  { label: "Team Work — manage teams", route: "/teams", kind: "page" },
];

describe("Phase IA-home-final — every Home CTA resolves to a real route", () => {
  for (const cta of HOME_CTAS) {
    it(`${cta.label} → ${cta.route}`, () => {
      if (cta.kind === "api") {
        // Backend download routes — assert the route family exists.
        const ROUTES = readFileSync(
          fileURLToPath(new URL("../src/routes/evidence.routes.ts", import.meta.url)),
          "utf8",
        );
        if (cta.route.endsWith("/report/latest")) {
          expect(ROUTES).toMatch(/\/v1\/evidence\/:id\/report\/latest/);
        } else {
          expect(ROUTES).toMatch(/\/v1\/evidence\/:id\/verification-package/);
        }
        return;
      }
      if (cta.kind === "verify") {
        expect(pageExists("/verify/x"), `${cta.route} must resolve to /verify/[token]`).toBe(true);
        return;
      }
      expect(pageExists(cta.route), `${cta.route} page must exist`).toBe(true);
    });
  }
});

// ============================================================================
// Banned targets — the Home must NEVER link to these.
// ============================================================================

describe("Phase IA-home-final — banned CTA targets are absent", () => {
  const FILES = [
    "components/home-experience/HomeSections.tsx",
    "components/home-experience/home-view-model.ts",
    "components/home-experience/SelfServeHomeDashboard.tsx",
  ];
  const sources = FILES.map((f) => readWeb(f)).join("\n");

  it("never links to the bare /evidence-requests list (only the per-id detail ships)", () => {
    // Allow /evidence-requests/<id> (comes through inbox item href), but
    // not a literal "/evidence-requests" target in our own components.
    expect(sources).not.toMatch(/["'`]\/evidence-requests["'`]/);
  });

  it("never links to /workspaces (hidden/empty for self-serve)", () => {
    expect(sources).not.toMatch(/\/workspaces/);
  });

  it("never uses the broken /v/:id verify path (must be /verify/:id)", () => {
    expect(sources).not.toMatch(/["'`]\/v\/\$\{/);
    expect(sources).not.toMatch(/`\/v\/\$\{encodeURIComponent/);
  });

  it("verify links use the canonical /verify/ path", () => {
    const VM = readWeb("components/home-experience/home-view-model.ts");
    expect(VM).toMatch(/\/verify\/\$\{encodeURIComponent\(evidenceId\)\}/);
  });
});

// ============================================================================
// No nav-duplicate launcher row (Phase 1 + Phase 15).
// ============================================================================

describe("Phase IA-home-final — no nav-duplicate button row", () => {
  it("the dashboard header has no WorkflowLaunchers / button row", () => {
    const DASH = readWeb("components/home-experience/SelfServeHomeDashboard.tsx");
    expect(DASH).not.toMatch(/WorkflowLaunchers/);
    // The header is title + subtitle only — no <Link> button row.
    const header = DASH.match(/<header[\s\S]*?<\/header>/)?.[0] ?? "";
    expect(header).not.toMatch(/<Link/);
    expect(header).not.toMatch(/<button/);
  });

  it("WorkflowLaunchers component + type are fully removed", () => {
    const SECTIONS = readWeb("components/home-experience/HomeSections.tsx");
    const VM = readWeb("components/home-experience/home-view-model.ts");
    expect(SECTIONS).not.toMatch(/export function WorkflowLaunchers/);
    expect(VM).not.toMatch(/WorkflowLauncher/);
  });
});

// ============================================================================
// Intake page opens real flows from the Home deep links.
// ============================================================================

describe("Phase IA-home-final — intake deep-links open real flows", () => {
  const PAGE = readWeb("app/(app)/intake-links/page.tsx");

  it("reads ?new=1 to auto-open the create-intake-link modal", () => {
    expect(PAGE).toMatch(/useSearchParams/);
    expect(PAGE).toMatch(/searchParams\.get\("new"\) === "1"/);
    expect(PAGE).toMatch(/setShowCreate\(true\)/);
  });

  it("reads ?linkId= to auto-open the delivery drawer", () => {
    expect(PAGE).toMatch(/searchParams\.get\("linkId"\)/);
    expect(PAGE).toMatch(/setDeliveryDrawerLinkId\(linkId\)/);
  });
});

// ============================================================================
// Empty-state design — no dead-end placeholder cards (Phase 12).
// ============================================================================

describe("Phase IA-home-final — empty states carry a real next action", () => {
  const SECTIONS = readWeb("components/home-experience/HomeSections.tsx");

  it("Trust State empty state has a Capture-first CTA, not just text", () => {
    expect(SECTIONS).toMatch(/data-trust-cta="capture-first"/);
    expect(SECTIONS).toMatch(/Trust state appears after your first evidence record/);
  });

  it("Request & Collect empty state has a Create-intake-link CTA", () => {
    expect(SECTIONS).toMatch(/data-collection-cta="create-intake-link"/);
    expect(SECTIONS).toMatch(/href="\/intake-links\?new=1"/);
  });

  it("Case Health empty state has a Create-case CTA", () => {
    expect(SECTIONS).toMatch(/data-case-cta="create-case"/);
  });
});
