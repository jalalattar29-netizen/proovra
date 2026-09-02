import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Let a dev server and a build coexist in one checkout.
  //
  // Both write to `.next`. A `next build` running beside `next dev` replaces
  // routes-manifest.json underneath the dev server, which then answers 500 to
  // every request with an ENOENT that names a file the developer never touched
  // — an error that reads as a broken app rather than as two processes sharing
  // one directory.
  //
  // Unset, this is exactly the previous behaviour.
  distDir: process.env.NEXT_DIST_DIR || ".next",
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
      // ======================================================================
      // ADM-033 (2026-08-27) — PLATFORM ADMIN VOCABULARY.
      //
      // `/admin/organizations` became `/admin/customers`. The page's population
      // is `Organization.kind = 'CUSTOMER'`, which EXCLUDES the internal 1:1
      // bootstrap container every workspace owns — and calling the surface
      // "Organizations" is precisely what made counting those containers look
      // reasonable for as long as it did. The word is the fix, so the word
      // changes and the old path forwards rather than lingering as a second
      // implementation.
      // ======================================================================
      {
        source: "/admin/organizations",
        destination: "/admin/customers",
        permanent: true,
      },
      {
        source: "/admin/organizations/:id",
        destination: "/admin/customers/:id",
        permanent: true,
      },
      // ======================================================================
      // ATTENTION ARCHITECTURE PHASE 5 (2026-08-22) — NOTIFICATION ROUTES.
      //
      // Two routes swapped meaning, and both old URLs keep working:
      //
      //   /inbox  ->  /notifications
      //       The personal notification centre's canonical URL. The old path
      //       is a PERMANENT compatibility redirect, because shipped emails,
      //       digests and collaboration links point at it and always will.
      //
      //   /notifications/deliveries  ->  /settings/notifications/deliveries
      //       The OUTBOUND DELIVERY LOG that used to own /notifications. It is
      //       an admin debugging surface — provider errors and resend buttons
      //       — and a user guessing "where are my notifications?" landed on
      //       it. It moved intact; only its address changed.
      //
      // Ordering matters: the more specific deliveries rule is declared before
      // the bare /inbox rule, and no source here is also a destination, so
      // there is no redirect loop.
      // ======================================================================
      {
        source: "/notifications/deliveries",
        destination: "/settings/notifications/deliveries",
        permanent: true,
      },
      { source: "/inbox", destination: "/notifications", permanent: true },
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
      // Phase 3 (ops canonicalization) — /operations is now the ONE
      // canonical operations namespace. The 6 real /ops/* impls were moved
      // into /operations/*, /ops was deleted, and the bare /ops hub URL
      // 308s here. Combined with the /ops/*→/operations/* subtree redirects
      // below, every /ops* source now points one-way to /operations* — no
      // loop (no source is also a destination).
      { source: "/ops", destination: "/operations", permanent: true },
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
      // PHASE 4A (2026-08-22) — ATTENTION ARCHITECTURE.
      //
      // `/operations` becomes the TENANT Operations Center. The
      // PROOVRA-internal consoles that lived under it are PLATFORM
      // surfaces and now live under `/admin/platform/*`, where the
      // `requiredActiveSpace: "PLATFORM_ADMIN"` gate they always carried
      // matches the name of the namespace.
      //
      // `/admin/*` — not a bare `/platform/*` — because `/platform` is
      // already a PUBLIC marketing page (`app/platform/page.tsx`), and
      // `/admin/*` is the established platform-admin family under `(app)`
      // with its own layout. Consumer inventory chose the namespace.
      //
      // This ordering is deliberate and non-negotiable: the platform
      // children were moved and re-gated BEFORE `/operations` itself was
      // opened to tenants, so no window exists in which a tenant-reachable
      // parent sits above a platform console.
      //
      // `/operations/quotas` and `/operations/batch-analysis` are NOT here
      // — they are already `PERSONAL_OR_ORG` tenant surfaces and stay.
      {
        source: "/operations/runbooks",
        destination: "/admin/platform/runbooks",
        permanent: true,
      },
      {
        source: "/operations/observability",
        destination: "/admin/platform/observability",
        permanent: true,
      },
      {
        source: "/operations/reliability",
        destination: "/admin/platform/reliability",
        permanent: true,
      },
      {
        source: "/operations/queues",
        destination: "/admin/platform/queues",
        permanent: true,
      },
      {
        source: "/operations/media-graph",
        destination: "/admin/platform/media-graph",
        permanent: true,
      },
      {
        source: "/operations/automation",
        destination: "/admin/platform/automation",
        permanent: true,
      },
      {
        source: "/operations/analytics",
        destination: "/admin/platform/analytics",
        permanent: true,
      },
      {
        source: "/operations/readiness",
        destination: "/admin/platform/readiness",
        permanent: true,
      },
      {
        source: "/operations/signers",
        destination: "/admin/platform/signers",
        permanent: true,
      },
      {
        source: "/operations/exports",
        destination: "/admin/platform/exports",
        permanent: true,
      },
      {
        source: "/operations/recovery",
        destination: "/admin/platform/recovery",
        permanent: true,
      },
      // Legacy `/ops/reliability` now lands on the platform route in one
      // hop rather than chaining through `/operations/reliability`.
      {
        source: "/ops/reliability",
        destination: "/admin/platform/reliability",
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
      // Legal cleanup 2026-07-19 — the legacy in-app legal renderer at
      // /app-legal/[slug] is deleted; /settings/legal/[slug] is the ONE
      // authenticated legal reader. Slug-preserving compatibility 308.
      { source: "/app-legal/:slug", destination: "/settings/legal/:slug", permanent: true },
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
      // Settings IA refactor (2026-07-17) — the six Settings child pages
      // were merged into the SINGLE unified /settings workspace. Old
      // deep links land on the matching section anchor. `/settings/
      // security/{scim,audit,saml}` keep their earlier canonical
      // redirects (exact-match sources; unaffected).
      {
        source: "/settings/profile",
        destination: "/settings#overview",
        permanent: true,
      },
      {
        source: "/settings/security",
        destination: "/settings#security",
        permanent: true,
      },
      {
        source: "/settings/preferences",
        destination: "/settings#preferences",
        permanent: true,
      },
      {
        source: "/settings/privacy",
        destination: "/settings#privacy",
        permanent: true,
      },
      {
        source: "/settings/notifications",
        destination: "/settings#notifications",
        permanent: true,
      },
      {
        source: "/settings/ai",
        destination: "/settings#ai",
        permanent: true,
      },
      {
        source: "/settings/security/audit",
        destination: "/admin/identity/timeline",
        permanent: true,
      },
      // Phase 2B (Teams/Workspace consolidation) — the parallel
      // self-serve `/teams` landing page (app/(app)/teams/page.tsx) was
      // DELETED. It duplicated the canonical Teams product at
      // `/collaboration-teams`. The bare `/teams` URL now 308s to that
      // canonical Teams surface so old bookmarks / "Invite a teammate"
      // deep links keep working. This is an EXACT match: `/teams/[id]`
      // (the legacy team-detail on `/v1/teams`, deferred to the backend
      // migration phase) is NOT matched and continues to render. The
      // `/workspaces` self-serve redirect target was repointed from
      // `/teams` to `/collaboration-teams` (lib/surface/tiers.ts) so no
      // redirect loop can form.
      {
        source: "/teams",
        destination: "/collaboration-teams",
        permanent: true,
      },
      // Phase 2B (Intelligence consolidation) — the standalone
      // `/intelligence-platform` page was DELETED and its provider /
      // cost / budget content merged into the canonical `/intelligence`
      // surface (components/intelligence/ProviderBudgetPanel.tsx). The
      // backend `intelligence-platform.routes.ts` is unchanged. Old deep
      // links 308 to the canonical Intelligence surface.
      {
        source: "/intelligence-platform",
        destination: "/intelligence",
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
        destination: "/admin/platform/observability",
        permanent: true,
      },
      {
        source: "/ops/runbooks",
        destination: "/admin/platform/runbooks",
        permanent: true,
      },
      {
        source: "/ops/media-graph",
        destination: "/admin/platform/media-graph",
        permanent: true,
      },
      {
        source: "/ops/automation",
        destination: "/admin/platform/automation",
        permanent: true,
      },
      {
        source: "/ops/analytics",
        destination: "/admin/platform/analytics",
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
      // PHASE 5 (2026-08-22) — retargeted from /inbox to /notifications.
      //
      // /inbox is itself now a redirect to /notifications, so leaving this
      // pointing there would send a visitor through two hops AND make one
      // redirect's destination another's source — the chain the loop gate
      // above forbids, and the shape that turns into an actual loop the first
      // time somebody adds a rule in the other direction. Every compatibility
      // route points at the CANONICAL destination, not at another alias.
      {
        source: "/collaboration",
        destination: "/notifications",
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
      // Trust Hub removal (2026-07-15) — the authenticated static Trust Hub
      // (`/trust-hub`, id `workspace.trust`) was deleted as redundant. It was
      // shipped (sidebar + org-admin deep link), so durable authenticated
      // bookmarks may exist; this TEMPORARY compatibility redirect resolves
      // them to the canonical public Trust Center. No query params are
      // preserved (the hub carried none). SUNSET: remove this redirect once
      // one release cycle has elapsed with no `/trust-hub` hits in access logs.
      {
        source: "/trust-hub",
        destination: "/trust",
        permanent: false,
      },
      // Phase 2 (dead-code deletion) — the `/security/trust-center/*`
      // page tree was a byte-identical duplicate of the canonical
      // `/trust-center/*` surface. The duplicate pages were deleted;
      // these 308s keep any external/indexed/bookmarked
      // `/security/trust-center` deep links resolving to the canonical
      // Trust Center. (In-app deep links were repointed at the source.)
      {
        source: "/security/trust-center",
        destination: "/trust-center",
        permanent: true,
      },
      {
        source: "/security/trust-center/:path*",
        destination: "/trust-center/:path*",
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

  /**
   * PHASE 12 — POINT 7 (final pass): the font strategy is chosen HERE, at
   * resolve time, so the choice is made before the `next/font/google` loader
   * can run.
   *
   * `next/font/google` downloads its families at BUILD time. That is a real
   * network dependency of the build, and under the Point-7 outbound guard the
   * twelve resulting requests were refused and the build failed — correctly,
   * since `next/font` will not silently ship a family it could not fetch.
   *
   * `FONT_STRATEGY=system` swaps the module that owns the fonts for its
   * hermetic sibling, which sets the same three CSS variables from the
   * design's own fallback stack. Nothing downstream changes: `app/fonts.ts`
   * still exports the same names, `layout.tsx` still applies the same
   * variables, and there is still exactly one presentation authority.
   *
   * Unset — the deployed default — nothing here applies and typography is
   * byte-for-byte what it was.
   */
  webpack(config) {
    if ((process.env.FONT_STRATEGY ?? "").trim().toLowerCase() === "system") {
      config.resolve = config.resolve ?? {};
      config.resolve.alias = {
        ...(config.resolve.alias ?? {}),
        [resolve(dirname(fileURLToPath(import.meta.url)), "app/fonts.google.ts")]:
          resolve(dirname(fileURLToPath(import.meta.url)), "app/fonts.system.ts"),
      };
    }
    return config;
  },
};

export default nextConfig;
