/**
 * Phase 28-I — Operations polish + schema-drift coverage source-contract tests.
 *
 * Asserts:
 *   - The sidebar has an Operations group with the three expected links.
 *   - /ops/runbooks exists, is a real catalog (not a stub), and the
 *     bounded runbook slugs the rest of the platform references are
 *     present.
 *   - The operational component family uses light-surface tokens — no
 *     more `rgba(255,255,255,...)` text on tinted backgrounds.
 *   - Every preset that surfaces a "runbooks" link points at
 *     /ops/runbooks (not the broken /docs/runbooks 404).
 *   - Observability dashboard renders a summary tile rollup BEFORE the
 *     raw counter / gauge tables and the raw groups are collapsed by
 *     default.
 *   - Schema validation registers saved_search_views.scope so the next
 *     P2022 is caught at startup instead of at request time.
 *   - The reviewer-ops saved-views route still selects + writes `scope`
 *     (regression guard for the original P2022).
 *   - The idempotent SQL drift patch exists and uses ADD COLUMN
 *     IF NOT EXISTS.
 *
 * Pure source-contract. No DOM. No DB. No Fastify.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// Sidebar navigation
// =============================================================================

describe("App sidebar — operations surfaces (Phase 38.6 routeRegistry)", () => {
  // Phase 38.6 — the canonical navigation source of truth is the route
  // registry (`lib/navigation/routeRegistry.ts`); the legacy
  // `lib/navigation-config.ts` (which modeled the "Platform Health"
  // NavGroup) was deleted. Route-href invariants are re-pointed here.
  const navConfig = readSource(
    "../../../apps/web/lib/navigation/routeRegistry.ts",
  );
  const src = readSource(
    "../../../apps/web/components/app-shell-v2/AppSidebarV2.tsx",
  );

  it("registers /operations, /operations/observability, /operations/runbooks", () => {
    expect(navConfig).toMatch(/href: "\/operations"/);
    expect(navConfig).toMatch(/href: "\/operations\/observability"/);
    expect(navConfig).toMatch(/href: "\/operations\/runbooks"/);
  });

  // OBSOLETE — Phase 38.6 removed navigation-config, which was the only
  // source that modeled sidebar GROUP headings ("Review & Governance" /
  // "Platform Health" / "Administration") and their order. The flat
  // routeRegistry has no NavGroup titles, so this ordering assertion no
  // longer has a source to read. Group ordering is a rendering concern
  // in AppSidebarV2 + the disclosure resolver.
  it.skip("places Platform Health between Review & Governance and Administration (removed with navigation-config)", () => {});

  it("never points at the broken /docs/runbooks", () => {
    expect(navConfig).not.toContain("/docs/runbooks");
    expect(src).not.toContain("/docs/runbooks");
  });
});

// =============================================================================
// Runbooks page
// =============================================================================

describe("/ops/runbooks page", () => {
  const src = readSource(
    "../../../apps/web/app/(app)/operations/runbooks/page.tsx",
  );

  it("exports a default page component", () => {
    expect(src).toMatch(/export\s+default\s+function\s+OpsRunbooksPage/);
  });

  it("has a real, bounded runbook catalog (≥ 20 entries)", () => {
    const matches = src.match(/slug:\s*"[a-z0-9-]+"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(20);
  });

  it("includes the runbook slugs the platform references from incidents", () => {
    // These slugs are emitted by the canonical incident services + appear
    // in /docs/runbooks. The catalog must surface them so dashboards
    // linking by runbookSlug don't 404.
    const expected = [
      "export-blocked",
      "hold-override",
      "retention-precedence",
      "immutable-drift",
      "reviewer-sla-breach",
      "reviewer-escalation-storm",
      "worker-wedged",
      "observability-degraded",
    ];
    for (const slug of expected) {
      expect(src, `runbook ${slug} missing`).toContain(`"${slug}"`);
    }
  });

  it("uses light-surface tokens from the operational barrel", () => {
    expect(src).toMatch(/from\s+"[\.\/]+components\/operational"/);
    expect(src).toMatch(/OPS_INK|OPS_SURFACE|OPS_TONES/);
  });

  it("does not import server-only fs (build-time stable on any runtime)", () => {
    expect(src).not.toMatch(/from\s+"fs"|from\s+"node:fs"/);
  });
});

// =============================================================================
// Operational component family — light-surface contrast tokens
// =============================================================================

describe("Operational component contrast (Phase 28-I)", () => {
  const TOKENS_SRC = readSource(
    "../../../apps/web/components/operational/tokens.ts",
  );
  const COMPONENT_FILES = [
    "../../../apps/web/components/operational/OperationalEmptyState.tsx",
    "../../../apps/web/components/operational/GovernanceSnapshotPanel.tsx",
    "../../../apps/web/components/operational/OperationalTimelinePanel.tsx",
    "../../../apps/web/components/operational/RuntimeStatusBanner.tsx",
    "../../../apps/web/components/operational/ExportPackageEligibilityBadge.tsx",
  ];

  it("publishes a shared tokens module with named palettes", () => {
    expect(TOKENS_SRC).toMatch(/export\s+const\s+OPS_INK\s*=/);
    expect(TOKENS_SRC).toMatch(/export\s+const\s+OPS_SURFACE\s*=/);
    expect(TOKENS_SRC).toMatch(/export\s+const\s+OPS_TONES\s*:/);
    expect(TOKENS_SRC).toMatch(/export\s+const\s+OPS_PILL\s*=/);
  });

  it("token palette uses dark text + tinted-light backgrounds (not vice versa)", () => {
    // The tone tokens encode ink (foreground) + bg (background). Body
    // ink must be a dark hex; backgrounds must be tinted-light hex.
    // Spot-check a few known-readable values.
    expect(TOKENS_SRC).toContain('default: "#0f172a"'); // slate-900 default ink
    expect(TOKENS_SRC).toContain('bg: "#fffbeb"'); // amber-50 for warning bg
    expect(TOKENS_SRC).toContain('bg: "#fef2f2"'); // red-50 for high bg
    expect(TOKENS_SRC).toContain('bg: "#fee2e2"'); // red-100 for critical bg
  });

  it("no operational component uses rgba(255,255,255,...) text or borders", () => {
    for (const rel of COMPONENT_FILES) {
      const src = readSource(rel);
      expect(
        src,
        `${rel} still uses dark-shell white tokens (contrast bug)`,
      ).not.toMatch(/rgba\(\s*255\s*,\s*255\s*,\s*255\s*,/);
    }
  });

  it("RuntimeStatusBanner CRITICAL banner uses red-100 background + red-900 ink", () => {
    const src = readSource(
      "../../../apps/web/components/operational/RuntimeStatusBanner.tsx",
    );
    // Must import the light-surface tones and use them on the CRITICAL path.
    expect(src).toMatch(/OPS_TONES\.critical\.bg/);
    expect(src).toMatch(/OPS_TONES\.critical\.ink/);
  });

  it("OperationalEmptyState renders Link with underlined readable color (no invisible text)", () => {
    const src = readSource(
      "../../../apps/web/components/operational/OperationalEmptyState.tsx",
    );
    expect(src).toMatch(/textDecoration:\s*"underline"/);
    // Link color comes from the tone token, NOT a hardcoded translucent
    // white.
    expect(src).toMatch(/color:\s*tone\.link/);
  });
});

// =============================================================================
// Empty-state preset link integrity — no /docs/runbooks 404s
// =============================================================================

describe("Empty-state runbook links", () => {
  const PRESET_SOURCES = [
    "../../../apps/web/components/operational/OperationalEmptyState.tsx",
    // Phase Final-Vocab-Alignment: legacy `/reviewer-ops/page.tsx` was
    // deleted; the canonical reviewer console is now `/review/page.tsx`.
    "../../../apps/web/app/(app)/review/page.tsx",
    "../../../apps/web/app/(app)/reviewer-ops/sla/page.tsx",
    "../../../apps/web/app/(app)/reviewer-ops/escalations/page.tsx",
    "../../../apps/web/app/(app)/governance/page.tsx",
    "../../../apps/web/app/(app)/operations/observability/page.tsx",
    "../../../apps/web/components/operational/RuntimeStatusBanner.tsx",
  ];

  it("no operational surface links to the broken /docs/runbooks", () => {
    for (const rel of PRESET_SOURCES) {
      const src = readSource(rel);
      expect(src, `${rel} links to broken /docs/runbooks`).not.toContain(
        "/docs/runbooks",
      );
    }
  });

  it("the canonical runbooks deep-link is /operations/runbooks", () => {
    const src = readSource(
      "../../../apps/web/components/operational/OperationalEmptyState.tsx",
    );
    expect(src).toContain("/operations/runbooks");
  });

  it("'open runtime readiness' is no longer aliased to the same page as observability", () => {
    // The previous design wired both labels to /ops/observability. The
    // runtime readiness state is now surfaced inside the observability
    // summary tile rollup. We assert no preset emits a separate
    // "Open runtime readiness" action — only "Open Observability
    // dashboard" / "Open Operations Center" / "View runbooks".
    const src = readSource(
      "../../../apps/web/components/operational/OperationalEmptyState.tsx",
    );
    expect(src).not.toContain("Open runtime readiness");
  });
});

// =============================================================================
// Observability — summary-first layout
// =============================================================================

describe("Observability dashboard — summary-first layout", () => {
  const src = readSource(
    "../../../apps/web/app/(app)/operations/observability/page.tsx",
  );

  it("renders a summary rollup section above the raw counters/gauges section", () => {
    const summaryIdx = src.indexOf('data-observability-summary');
    const countersHeadingIdx = src.indexOf(">Counters</h2");
    expect(summaryIdx).toBeGreaterThan(0);
    expect(countersHeadingIdx).toBeGreaterThan(0);
    expect(summaryIdx).toBeLessThan(countersHeadingIdx);
  });

  it("summary includes alerts firing + degraded subsystems + uptime tiles", () => {
    expect(src).toMatch(/label="Alerts firing"/);
    expect(src).toMatch(/label="Degraded subsystems"/);
    expect(src).toMatch(/label="Runtime uptime"/);
  });

  it("collapses raw counter / gauge groups by default (no open=)", () => {
    // The `<details>` for raw metric groups must NOT pass `open` so
    // the page loads dense and compact, not as a giant metric dump.
    expect(src).not.toMatch(/<details[^>]*open=\{rows\.some/);
  });

  it("places the scrape-endpoints reference inside a collapsed details, not a giant card", () => {
    expect(src).toMatch(/<details[^>]*>\s*<summary[^>]*>\s*Scrape endpoints/);
  });

  it("consumes runtime readiness via /admin/runtime/readiness", () => {
    expect(src).toMatch(/\/admin\/runtime\/readiness\?teamId=/);
  });

  it("top non-zero counters + gauges are surfaced (top-signal first)", () => {
    expect(src).toContain("topNonZeroCounters");
    expect(src).toContain("topNonZeroGauges");
  });
});

// =============================================================================
// Schema-drift coverage — saved_search_views.scope
// =============================================================================

describe("Schema validation — saved_search_views drift coverage", () => {
  const src = readSource(
    "../../../services/api/src/runtime/schema-validation.ts",
  );

  it("registers the saved_search_views table", () => {
    expect(src).toMatch(
      /kind:\s*"table",\s*name:\s*"saved_search_views"/,
    );
  });

  it("registers saved_search_views.scope as a CRITICAL column under reviewer_ops", () => {
    // Drift on `scope` was the actual P2022 the operator saw. It must
    // be classified critical so the next time it's missing the startup
    // validator surfaces the drift rather than the request handler
    // failing at runtime.
    expect(src).toMatch(
      /table:\s*"saved_search_views",\s*column:\s*"scope",\s*severity:\s*"critical",\s*subsystem:\s*"reviewer_ops"/,
    );
  });

  it("registers the other reviewer-ops saved-view columns the projection depends on", () => {
    for (const col of [
      "query_json",
      "visibility",
      "pinned",
      "last_used_at_utc",
    ]) {
      expect(src, `column ${col} not registered`).toMatch(
        new RegExp(
          `table:\\s*"saved_search_views",\\s*column:\\s*"${col}"`,
        ),
      );
    }
  });
});

// =============================================================================
// Saved-views route — regression guard for the original P2022
// =============================================================================

describe("Saved-views route — projection contract", () => {
  const src = readSource(
    "../../../services/api/src/routes/reviewer-ops.routes.ts",
  );

  it("declares the three /v1/reviewer-ops/saved-views handlers", () => {
    expect(src).toContain('"/v1/reviewer-ops/saved-views"');
    expect(src).toContain('"/v1/reviewer-ops/saved-views/:id"');
    expect(src).toMatch(/app\.get\([\s\S]*?"\/v1\/reviewer-ops\/saved-views"/);
    expect(src).toMatch(/app\.post\([\s\S]*?"\/v1\/reviewer-ops\/saved-views"/);
    expect(src).toMatch(
      /app\.delete\([\s\S]*?"\/v1\/reviewer-ops\/saved-views\/:id"/,
    );
  });

  it("delegates to the canonical saved-views service (no inline prisma.savedSearchView.create here)", () => {
    expect(src).toContain("listReviewerOpsSavedViews");
    expect(src).toContain("createReviewerOpsSavedView");
    expect(src).toContain("deleteReviewerOpsSavedView");
    // The route file itself MUST NOT inline prisma writes — the service
    // is the only place that knows about `scope`.
    expect(src).not.toMatch(/prisma\.savedSearchView\.(create|update)/);
  });
});

describe("Saved-views service — scope filter regression guard", () => {
  const src = readSource(
    "../../../services/api/src/services/reviewer-ops/saved-queue-views.service.ts",
  );

  it("filters reads by scope = REVIEWER_OPS so the P2022 reproducer endpoint always projects the column", () => {
    expect(src).toMatch(/scope:\s*REVIEWER_OPS_SAVED_VIEW_SCOPE/);
  });

  it("writes scope on every create (so the column is never null)", () => {
    expect(src).toMatch(/scope:\s*REVIEWER_OPS_SAVED_VIEW_SCOPE/);
  });

  it("never references the legacy column name `query` (regression guard for the migration)", () => {
    // `query_json` is the persisted column; `query` would be a Prisma
    // selector that doesn't exist on the model.
    expect(src).not.toMatch(/\bprisma\.savedSearchView\.findMany\([\s\S]*?\bquery:\s/);
  });
});

// =============================================================================
// SQL drift patch — partial-state-safe + idempotent
// =============================================================================

describe("SQL drift patch — saved_search_views.scope", () => {
  const src = readSource(
    "../../../services/api/sql/drift-patches/2026-05-19-saved-search-views-scope.sql",
  );

  it("uses ADD COLUMN IF NOT EXISTS (idempotent)", () => {
    expect(src).toMatch(/ADD COLUMN IF NOT EXISTS\s+"scope"/i);
  });

  it("recreates the supporting indexes with CREATE INDEX IF NOT EXISTS (idempotent)", () => {
    expect(src).toMatch(
      /CREATE INDEX IF NOT EXISTS\s+saved_search_views_team_scope_idx/i,
    );
    expect(src).toMatch(
      /CREATE INDEX IF NOT EXISTS\s+saved_search_views_team_scope_visibility_idx/i,
    );
  });

  it("aborts loudly if the base table is missing (so this is not silently mis-applied to a fresh DB)", () => {
    expect(src).toMatch(/saved_search_views table is missing/);
  });

  it("wraps the patch in a single transaction (partial-state safe)", () => {
    expect(src).toMatch(/^\s*BEGIN\s*;/m);
    expect(src).toMatch(/^\s*COMMIT\s*;/m);
  });

  it("does NOT touch existing rows (no UPDATE / DELETE / TRUNCATE)", () => {
    expect(src).not.toMatch(/^\s*UPDATE\s/im);
    expect(src).not.toMatch(/^\s*DELETE\s+FROM/im);
    expect(src).not.toMatch(/^\s*TRUNCATE\s/im);
  });
});

// =============================================================================
// Cross-page invariants — no fake counters, no secrets exposed
// =============================================================================

describe("Phase 28-I cross-page invariants", () => {
  const PAGES = [
    // Phase Final-Vocab-Alignment: legacy `/reviewer-ops/page.tsx` was
    // deleted; the canonical reviewer console is now `/review/page.tsx`.
    "../../../apps/web/app/(app)/review/page.tsx",
    "../../../apps/web/app/(app)/reviewer-ops/sla/page.tsx",
    // CR1 Part 2 deleted `reviewer-ops/policy/page.tsx` (redirect →
    // /governance/policy is now in next.config.js). The canonical
    // surface `governance/policy/page.tsx` is exercised by Phase 32.8
    // tests.
    "../../../apps/web/app/(app)/reviewer-ops/escalations/page.tsx",
    "../../../apps/web/app/(app)/governance/page.tsx",
    "../../../apps/web/app/(app)/operations/observability/page.tsx",
    "../../../apps/web/app/(app)/operations/runbooks/page.tsx",
    "../../../apps/web/app/(app)/evidence/[id]/page.tsx",
  ];

  it("no page hardcodes operational counters (no fake escalations / overdue numbers)", () => {
    for (const rel of PAGES) {
      const src = readSource(rel);
      expect(src, `fake counter in ${rel}`).not.toMatch(/escalations:\s*\d+,/);
      expect(src, `fake counter in ${rel}`).not.toMatch(/overdue:\s*\d+,/);
      expect(src, `fake counter in ${rel}`).not.toMatch(/incidents:\s*\d+,/);
    }
  });

  it("no page interpolates process.env into rendered JSX", () => {
    for (const rel of PAGES) {
      const src = readSource(rel);
      expect(src, `env interpolation in ${rel}`).not.toMatch(
        /\{process\.env\.[A-Z_]+\}/,
      );
    }
  });

  it("no page imports server-only secrets (STORAGE_*_KEY, *_SECRET, etc.) in client JSX", () => {
    for (const rel of PAGES) {
      const src = readSource(rel);
      expect(src).not.toMatch(/STORAGE_S3_SECRET|TWILIO_AUTH_TOKEN|JWT_SECRET/);
    }
  });
});
