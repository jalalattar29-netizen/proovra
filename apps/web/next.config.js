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
      {
        source: "/security",
        destination: "/security-center",
        permanent: true,
      },
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
      {
        source: "/teams",
        destination: "/workspaces",
        permanent: true,
      },
      {
        source: "/identity",
        destination: "/admin/identity",
        permanent: true,
      },
      // Phase 1A — Legacy /dashboard/* paths folded into canonical home +
      // operations pillar. /dashboard without a sub-path already redirects
      // to /home above.
      //
      // Stage 2 cleanup — removed dead redirects whose destinations never
      // existed on disk: /ops/{observability,runbooks,media-graph,
      // automation,analytics} and /dashboard/{batch-analysis,quotas}. The
      // canonical pages live at the SOURCE paths (e.g.
      // app/(app)/ops/observability/page.tsx); the /operations/* and
      // /operations/{batch-analysis,quotas} destinations are not implemented,
      // so the redirects were 308-ing real pages into 404s. /ops/reliability
      // is kept — its /operations/reliability destination genuinely exists.
      {
        source: "/dashboard/insights",
        destination: "/home",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
