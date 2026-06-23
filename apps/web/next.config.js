/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: process.env.NEXT_STANDALONE === "false" ? undefined : "standalone",
  transpilePackages: ["@proovra/shared", "@proovra/ui"],

  // ✅ لا نضع CSP هنا لأن middleware.ts هو المصدر الوحيد للهيدرز الأمنية
  // (حتى ما يصير تضارب/تكرار ويطلع unsafe-eval بالغلط)

  // CR1 Part 2 — canonical Phase-32.8B backward-compat redirects.
  // Previously each route had its own JSX page that called
  // `next/navigation`.redirect(). The pages were single-purpose, 14-line
  // files. Moving them here makes routing the source of truth and keeps
  // app/(app)/ clean. End-user behavior is identical (308 permanent
  // redirect to the same destination, queries preserved as-is).
  async redirects() {
    return [
      { source: "/dashboard", destination: "/home", permanent: true },
      {
        source: "/archive",
        destination: "/evidence?filter=archived",
        permanent: true,
      },
      {
        source: "/deleted",
        destination: "/evidence?filter=deleted",
        permanent: true,
      },
      {
        source: "/locked",
        destination: "/evidence?filter=locked",
        permanent: true,
      },
      { source: "/operations", destination: "/ops", permanent: true },
      // Phase B — removed the legacy `/review → /reviewer-ops` redirect.
      // Phase C0 made `/review` the canonical reviewer console, but the
      // legacy redirect was intercepting navigation and bouncing
      // operators away from it. The page at `app/(app)/review/page.tsx`
      // is now the canonical landing surface.
      // Phase B — alias `/ops/reliability` to the existing
      // `/operations/reliability` page so the operations URL family
      // appears consistent (`/ops/*`). A future phase may rename the
      // filesystem path; for now the redirect masks the inconsistency
      // without breaking the actual route.
      {
        source: "/ops/reliability",
        destination: "/operations/reliability",
        permanent: true,
      },
      {
        source: "/reviewer-ops/policy",
        destination: "/governance/policy",
        permanent: true,
      },
      // CR1 Part 2 — `/security` → `/security-center` (the canonical
      // operator-facing security overview behind the `(app)` auth wall).
      { source: "/security", destination: "/security-center", permanent: true },
      // Marketing — the standalone /security-overview marketing page was
      // retired; the canonical public security destination is the
      // /legal/security responsible-disclosure & security policy page.
      { source: "/security-overview", destination: "/legal/security", permanent: true },
      // Marketing — the standalone /technology/verification-methodology
      // page was retired; the canonical public methodology destination
      // is the legal-styled /legal/verification-methodology document.
      {
        source: "/technology/verification-methodology",
        destination: "/legal/verification-methodology",
        permanent: true,
      },
      // Marketing — the five Technology detail subpages were retired in
      // favor of the single, in-depth /technology architecture page.
      // Anchors on the destination preserve deep-link semantics:
      //   * hashing / signatures / timestamps / OTS  → #verification-architecture
      //   * chain of custody                          → #governance-architecture
      // Old indexed URLs continue to resolve via permanent redirects.
      {
        source: "/technology/cryptographic-hashing",
        destination: "/technology#verification-architecture",
        permanent: true,
      },
      {
        source: "/technology/digital-signatures",
        destination: "/technology#verification-architecture",
        permanent: true,
      },
      {
        source: "/technology/trusted-timestamps",
        destination: "/technology#verification-architecture",
        permanent: true,
      },
      {
        source: "/technology/opentimestamps",
        destination: "/technology#verification-architecture",
        permanent: true,
      },
      {
        source: "/technology/chain-of-custody",
        destination: "/technology#governance-architecture",
        permanent: true,
      },
      // Marketing — the six /solutions/* industry pages were retired in
      // favor of the canonical /for-* industry pages driven by the
      // shared UseCasePage component (apps/web/components/use-case-page.tsx).
      // Old indexed URLs continue to resolve via permanent redirects.
      {
        source: "/solutions/legal-ediscovery",
        destination: "/for-lawyers",
        permanent: true,
      },
      { source: "/solutions/insurance", destination: "/for-insurance", permanent: true },
      {
        source: "/solutions/corporate-investigations",
        destination: "/for-investigations",
        permanent: true,
      },
      { source: "/solutions/government", destination: "/for-government", permanent: true },
      {
        source: "/solutions/compliance-audit",
        destination: "/for-compliance",
        permanent: true,
      },
      { source: "/solutions/journalism", destination: "/for-journalism", permanent: true },
      // Phase Final-A3-PT2 — `/dashboard/api-keys` retired (the legacy
      // in-memory user-scoped API key store was removed in A-3). The
      // canonical, team-scoped, durable surface is `/integrations`.
      {
        source: "/dashboard/api-keys",
        destination: "/integrations",
        permanent: true,
      },
      // Phase Final-Vocab-Alignment — `/reviewer-ops` (the legacy
      // queue index) was confusing operators vs `/review` (the
      // canonical reviewer console, C0). Index now redirects to
      // `/review`. The `/reviewer-ops/[reviewId]` mutation inspector
      // stays — it is a different surface.
      {
        source: "/reviewer-ops",
        destination: "/review",
        permanent: true,
      },
      // Phase Final-Closure-Remediation — five additional redirect/
      // duplicate pages were collapsed into this `redirects()` block:
      //   * `/cases/:id/classic` was a pure server-redirect to the
      //     canonical Matter Workspace (Phase G4.2 classic retirement).
      //   * `/settings/security/scim` was a pure server-redirect to
      //     the canonical SCIM Operations Center (Phase P1.2).
      //   * `/settings/security/audit` was a pure server-redirect to
      //     the canonical Identity Audit Center (Phase P1.3).
      //   * `/teams` was a duplicate of `/workspaces`; the canonical
      //     `admin.teams` route id now resolves to `/workspaces` and
      //     the legacy `/teams` URL redirects there (Phase G0 B0.5
      //     canonical move).
      //   * `/identity` was the legacy workspace-internal identity
      //     console (Phase 17); folded into `/admin/identity` (the
      //     enterprise operator control plane).
      // The destination of each redirect is the canonical surface the
      // deleted page already pointed at; behaviour parity is exact.
      {
        source: "/cases/:id/classic",
        destination: "/cases/:id",
        permanent: true,
      },
      {
        source: "/settings/security/scim",
        destination: "/admin/identity/scim",
        permanent: true,
      },
      {
        source: "/settings/security/audit",
        destination: "/admin/identity/timeline",
        permanent: true,
      },
      // Phase HOME-DATA-OWNERSHIP — the `/teams` → `/workspaces`
      // redirect (Phase Final-Closure-Remediation) is REMOVED. Phase
      // IA-self-serve-completion later shipped a real self-serve
      // landing page at app/(app)/teams/page.tsx, but this server
      // redirect fired first, so the page was unreachable: Home's
      // "Invite a teammate" → /teams → /workspaces → PageRouteGate
      // (admin.teams, TEAM_VIEW) → BLANK page for every personal-space
      // user. /teams is now canonical for self-serve team management;
      // the reverse mapping (/workspaces → /teams for self-serve) is
      // handled by the surface-tier rule in lib/surface/tiers.ts.
      {
        source: "/identity",
        destination: "/admin/identity",
        permanent: true,
      },
      // Phase 1A — Legacy /dashboard/* paths folded into canonical home +
      // operations pillar. /dashboard without a sub-path already redirects
      // to /home above.
      //
      // Phase 1A IA reset — the canonical Operations pillar URL family
      // is `/operations/*`. The legacy `/ops/*` and `/dashboard/{batch-
      // analysis,quotas}` URLs now redirect to their canonical homes.
      // The destinations are thin wrapper pages under
      // `app/(app)/operations/{...}` that re-export the original content
      // (preserved at `app/(app)/ops/...` and `app/(app)/dashboard/...`
      // to avoid churning every internal import in this iteration).
      {
        source: "/dashboard/insights",
        destination: "/home",
        permanent: true,
      },
      {
        source: "/ops/observability",
        destination: "/operations/observability",
        permanent: true,
      },
      {
        source: "/ops/runbooks",
        destination: "/operations/runbooks",
        permanent: true,
      },
      {
        source: "/ops/media-graph",
        destination: "/operations/media-graph",
        permanent: true,
      },
      {
        source: "/ops/automation",
        destination: "/operations/automation",
        permanent: true,
      },
      {
        source: "/ops/analytics",
        destination: "/operations/analytics",
        permanent: true,
      },
      {
        source: "/dashboard/batch-analysis",
        destination: "/operations/batch-analysis",
        permanent: true,
      },
      {
        source: "/dashboard/quotas",
        destination: "/operations/quotas",
        permanent: true,
      },
      // Phase IA-collapse — /collaboration is retired as a standalone
      // product surface. The capabilities it exposed (assigned-to-me,
      // unread mentions, discussion attention queue) are already covered
      // by /inbox (which surfaces `discussion_mention` + `discussion_assigned`
      // items and deep-links straight to the evidence detail discussion
      // tab where threads actually live). The /collaboration page file +
      // backend service + DiscussionThread / DiscussionMessage models +
      // /v1/collaboration/threads/* routes all remain intact — they
      // continue to power the evidence detail discussion panel. This
      // redirect only retires the standalone front-end entry point.
      {
        source: "/collaboration",
        destination: "/inbox",
        permanent: true,
      },
      // Marketing — Platform mega-menu consolidation. The eight legacy
      // /platform/<sub> pages were collapsed into anchored sections on
      // the unified /platform overview page. Each old URL 308s to the
      // overview so existing bookmarks / external links still resolve.
      // The old page.tsx files have been removed from app/platform/<sub>.
      { source: "/platform/capture", destination: "/platform", permanent: true },
      {
        source: "/platform/evidence-records",
        destination: "/platform",
        permanent: true,
      },
      {
        source: "/platform/verification",
        destination: "/platform",
        permanent: true,
      },
      { source: "/platform/reports", destination: "/platform", permanent: true },
      {
        source: "/platform/verification-packages",
        destination: "/platform",
        permanent: true,
      },
      { source: "/platform/cases", destination: "/platform", permanent: true },
      {
        source: "/platform/teams-workspaces",
        destination: "/platform",
        permanent: true,
      },
      {
        source: "/platform/integrations",
        destination: "/platform",
        permanent: true,
      },
      {
        source: "/platform/governance",
        destination: "/platform",
        permanent: true,
      },
      // Legal Center IA restructure — Trust Center promoted to a
      // top-level destination (`/trust`) so it reads as a primary
      // trust/legal pillar rather than an About sub-page. The legacy
      // `/about/trust` URL 308s to the canonical path so external
      // links, indexed URLs, and old Help-menu deep links continue
      // to resolve.
      {
        source: "/about/trust",
        destination: "/trust",
        permanent: true,
      },
      // Legal Center IA restructure — the standalone Privacy Matrix
      // page was retired because its content is already covered in
      // the Privacy Policy. Any indexed Matrix URL 308s to the
      // canonical destination so external references continue to
      // resolve.
      {
        source: "/legal/privacy-matrix",
        destination: "/legal/privacy",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
