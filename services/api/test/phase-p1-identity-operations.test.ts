/**
 * Phase P1 — Enterprise Identity Operations contract suite.
 *
 * Phase P1 builds the canonical procurement entry point for enterprise
 * identity operations. The contracts below verify:
 *
 *   1. The canonical `/settings/security` hub exists + lists the three
 *      primary procurement surfaces (SAML / SCIM / Audit) + the
 *      operational surfaces + an explicit honest-scope disclosure.
 *
 *   2. The canonical `/settings/security/saml`, `/settings/security/scim`,
 *      and `/settings/security/audit` routes exist and either redirect
 *      to the existing procurement-grade surfaces or render them
 *      directly (no fork in the active codebase).
 *
 *   3. Step-up gating is wired on the two most dangerous admin
 *      mutations: SCIM token revoke + SAML certificate promotion.
 *      Backend's `enforceStepUpIfFlagged` returns 401 STEP_UP_REQUIRED
 *      when the workspace flag is set; the frontend's
 *      `runStepUpAction` wrapper handles modal+retry.
 *
 *   4. The hub honestly discloses the bounded follow-ups (SCIM
 *      reconciliation engine, SSO health-monitoring dashboard,
 *      step-up exemption rules, visual SAML attribute builder,
 *      historical session replay).
 *
 *   5. The existing identity admin surfaces survive — no
 *     `/admin/identity/*` page was deleted or hollowed.
 *
 * Style: source-contract. Reads source files, asserts regex/string
 * contracts. Same pattern as every phase contract from A0 onward.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

function exists(rel: string): boolean {
  const url = new URL(rel, import.meta.url);
  return existsSync(fileURLToPath(url));
}

// ---------------------------------------------------------------------------
// 1. Canonical hub at /settings/security
// ---------------------------------------------------------------------------

describe("Phase P1 — Identity operations canonical hub", () => {
  // Phase IA-collapse — the identity-operations canonical hub moved
  // from `/settings/security` to `/admin/identity`. `/settings/security`
  // is now the personal Account Security home (route id
  // `account.security`). Every assertion below reads the hub at its
  // new canonical location.
  const HUB = readSource(
    "../../../apps/web/app/(app)/admin/identity/page.tsx",
  );

  it("renders an Identity operations title + procurement-grade subtitle", () => {
    expect(HUB).toContain("Identity operations");
    expect(HUB).toContain("procurement-grade");
    // JSX wraps lines; whitespace-tolerant regex.
    expect(HUB).toMatch(/audited\s+backend\s+endpoint/);
    expect(HUB).toMatch(/workspace\s+step-up\s+policy/);
  });

  it("surfaces SAML / SCIM / Audit as the three primary cards", () => {
    expect(HUB).toContain('"/settings/security/saml"');
    expect(HUB).toContain("SAML configuration");
    expect(HUB).toContain('"/settings/security/scim"');
    expect(HUB).toContain("SCIM operations");
    expect(HUB).toContain('"/settings/security/audit"');
    expect(HUB).toContain("Identity audit center");
  });

  it("surfaces the operational secondary surfaces (sessions / runtime / access reviews / RBAC / MFA / recovery)", () => {
    expect(HUB).toContain('"/admin/identity/sessions"');
    expect(HUB).toContain('"/admin/identity/runtime"');
    expect(HUB).toContain('"/admin/identity/access-reviews"');
    expect(HUB).toContain('"/admin/identity/permission-matrix"');
    expect(HUB).toContain('"/security-center"');
    expect(HUB).toContain('"/security-center/mfa-recovery"');
  });

  it("renders the honest-scope disclosure for remaining bounded follow-ups (post-P1.1)", () => {
    expect(HUB).toContain("Honest scope disclosure");
    // Phase P1.1 closed four of the five P1 follow-ups (SCIM drift,
    // SSO health, visual SAML mapping, session replay). Only the
    // step-up exemption rules item should remain in the disclosure.
    // We assert on the `<strong>…</strong>` wrappers (i.e. *rendered*
    // list items) so that closure-explainer comments containing the
    // old names don't false-positive the regression.
    expect(HUB).toMatch(/<strong>Step-up exemption rules<\/strong>/);
    expect(HUB).not.toMatch(
      /<strong>SCIM drift reconciliation engine<\/strong>/,
    );
    expect(HUB).not.toMatch(
      /<strong>SSO connection health monitoring dashboard<\/strong>/,
    );
    expect(HUB).not.toMatch(
      /<strong>Visual SAML attribute mapping builder<\/strong>/,
    );
    expect(HUB).not.toMatch(/<strong>Historical session replay<\/strong>/);
  });

  it("is gated behind PageRouteGate(admin.identity)", () => {
    expect(HUB).toContain("PageRouteGate");
    expect(HUB).toContain('routeId="admin.identity"');
  });

  it("carries a stable mount marker for E2E", () => {
    // Phase IA-collapse — marker renamed to match the new mount URL.
    expect(HUB).toContain('data-testid="admin-identity-hub"');
  });
});

// ---------------------------------------------------------------------------
// 1A. Phase IA-collapse — Account Security home at /settings/security
// ---------------------------------------------------------------------------

describe("Phase IA-collapse — Account Security home (unified /settings Security section)", () => {
  // Settings IA refactor (2026-07-17): the standalone /settings/security
  // page merged into the SINGLE unified /settings workspace; personal
  // account security is its Security section (same components, same
  // gating; /settings/security 308-redirects to /settings#security).
  const ACCOUNT_SECURITY = readSource(
    "../../../apps/web/app/(app)/settings/page.tsx",
  );

  it("is gated behind PageRouteGate(account.settings)", () => {
    expect(ACCOUNT_SECURITY).toContain("PageRouteGate");
    expect(ACCOUNT_SECURITY).toContain('routeId="account.settings"');
  });

  it("renders the Security section and mounts PersonalSecuritySections", () => {
    // SETTINGS PANE ARCHITECTURE (2026-09-03) — re-expressed, as in
    // `phase-7c-internal-ux` and `phase-ia-self-serve-completion`.
    //
    // A destination used to be a DOM anchor because Settings was one
    // scrolling console: `id="security"` existed so `/settings#security`
    // could SCROLL to the section. Panes mount one destination at a time, so
    // the anchor pointed at an element that is not in the document, and it
    // was removed with the scroll it served. Re-adding it would put a dead
    // attribute in the page to satisfy a third regex.
    //
    // What it protected — that the hash still lands on personal security, on
    // the canonical surface — is asserted against the current architecture.
    expect(ACCOUNT_SECURITY).toContain("resolvePaneFromHash");
    expect(ACCOUNT_SECURITY).toContain('pane === "security"');
    expect(ACCOUNT_SECURITY).toContain("PersonalSecuritySections");
  });

  it("links the operator-facing Identity & Security workspace console", () => {
    expect(ACCOUNT_SECURITY).toContain('href="/security-center"');
    expect(ACCOUNT_SECURITY).toContain("Identity &amp; Security");
  });

  it("carries a stable E2E mount marker", () => {
    expect(ACCOUNT_SECURITY).toContain('data-testid="account-settings-page"');
  });
});

// ---------------------------------------------------------------------------
// 1B. Phase IA-collapse — /collaboration redirected to /inbox
// ---------------------------------------------------------------------------

describe("Phase IA-collapse — standalone /collaboration retired", () => {
  it("next.config.js redirects /collaboration → /notifications", () => {
    const cfg = readSource("../../../apps/web/next.config.js");
    expect(cfg).toMatch(
      /source:\s*["']\/collaboration["'][\s\S]{0,900}destination:\s*["']\/notifications["']/,
    );
  });

  it("the workspace.collaboration registry entry is gone entirely", () => {
    // Phase 12 Point 4 (Pass E) — strengthened from "hidden from every
    // discovery surface" to "absent". The entry's own comment conceded it
    // was "preserved so the route id, href, and existing contract tests
    // stay green" — a route row kept alive for its tests, pointing at a
    // page the redirect made unreachable. The page is deleted and the row
    // with it; three visibility flags set to false is a weaker guarantee
    // than the row not existing.
    //
    // The backend is untouched: DiscussionThread / DiscussionMessage and
    // the per-thread `/v1/collaboration/threads/*` routes still power the
    // evidence-detail Discussion surface.
    const registry = readSource(
      "../../../apps/web/lib/navigation/routeRegistry.ts",
    );
    expect(registry.indexOf('id: "workspace.collaboration"')).toBe(-1);
    expect(registry).not.toMatch(/href:\s*["']\/collaboration["']/);
  });
});

// ---------------------------------------------------------------------------
// 1C. Phase IA-collapse — workspace.communications + workspace.security_center demoted
// ---------------------------------------------------------------------------

describe("Phase IA-collapse — Communications + Security Center demoted from sidebar", () => {
  const registry = readSource(
    "../../../apps/web/lib/navigation/routeRegistry.ts",
  );

  it("workspace.communications is renamed Messaging operations and not sidebar-eligible", () => {
    const idx = registry.indexOf('id: "workspace.communications"');
    expect(idx, "workspace.communications not found").toBeGreaterThan(-1);
    const block = registry.slice(idx, idx + 3000);
    expect(block).toMatch(/label:\s*"Messaging operations"/);
    expect(block).toMatch(/sidebarEligible:\s*false/);
    // Still discoverable via cmd-K + All Tools (it's a real operator
    // surface, just not a primary sidebar entry for normal users).
    expect(block).toMatch(/commandPaletteVisible:\s*true/);
    expect(block).toMatch(/allToolsVisible:\s*true/);
  });

  it('workspace.security_center is renamed "Identity & Security" and not sidebar-eligible', () => {
    const idx = registry.indexOf('id: "workspace.security_center"');
    expect(idx, "workspace.security_center not found").toBeGreaterThan(-1);
    const block = registry.slice(idx, idx + 3000);
    expect(block).toMatch(/label:\s*"Identity & Security"/);
    expect(block).toMatch(/sidebarEligible:\s*false/);
    expect(block).toMatch(/commandPaletteVisible:\s*true/);
    expect(block).toMatch(/allToolsVisible:\s*true/);
  });

  it("account.security entry exists and is ACCOUNT-tier", () => {
    expect(registry).toMatch(/id:\s*"account\.security"/);
    const idx = registry.indexOf('id: "account.security"');
    const block = registry.slice(idx, idx + 3000);
    // Settings IA refactor (2026-07-17): the entry deep-links to the
    // Security section of the unified /settings workspace.
    expect(block).toMatch(/href:\s*"\/settings#security"/);
    expect(block).toMatch(/domain:\s*"ACCOUNT"/);
    expect(block).toMatch(/requiredActiveSpace:\s*"NONE"/);
  });

  it("admin.identity now lives at /admin/identity (moved from /settings/security)", () => {
    const idx = registry.indexOf('id: "admin.identity"');
    expect(idx).toBeGreaterThan(-1);
    const block = registry.slice(idx, idx + 3000);
    expect(block).toMatch(/href:\s*"\/admin\/identity"/);
  });
});

// ---------------------------------------------------------------------------
// 2. Canonical sub-paths exist and resolve to the procurement-grade surfaces
// ---------------------------------------------------------------------------

describe("Phase P1 — canonical sub-paths resolve to procurement-grade surfaces", () => {
  it("/settings/security/saml redirects to /security-center/sso (the R8.2.x SAML console)", () => {
    expect(
      exists("../../../apps/web/app/(app)/settings/security/saml/page.tsx"),
    ).toBe(true);
    const src = readSource(
      "../../../apps/web/app/(app)/settings/security/saml/page.tsx",
    );
    expect(src).toContain('import { redirect }');
    expect(src).toContain('redirect("/security-center/sso")');
  });

  // Phase Final-Closure-Remediation — the `/settings/security/scim`
  // and `/settings/security/audit` redirect-only page files were
  // deleted and their behaviour was moved into `next.config.js`
  // `redirects()` as permanent 308s. The destination surfaces
  // (`/admin/identity/scim` and `/admin/identity/timeline`) are
  // unchanged and still backed by the same audited endpoints.
  it("/settings/security/scim redirects to /admin/identity/scim via next.config.js (the SCIM token console)", () => {
    const cfg = readSource("../../../apps/web/next.config.js");
    expect(cfg).toMatch(
      /source:\s*["']\/settings\/security\/scim["'][\s\S]{0,200}destination:\s*["']\/admin\/identity\/scim["']/,
    );
    // The redirect page file is intentionally absent — routing layer
    // is the single source of truth.
    expect(
      exists("../../../apps/web/app/(app)/settings/security/scim/page.tsx"),
    ).toBe(false);
  });

  it("/settings/security/audit redirects to /admin/identity/timeline via next.config.js (the unified event feed)", () => {
    const cfg = readSource("../../../apps/web/next.config.js");
    expect(cfg).toMatch(
      /source:\s*["']\/settings\/security\/audit["'][\s\S]{0,200}destination:\s*["']\/admin\/identity\/timeline["']/,
    );
    expect(
      exists("../../../apps/web/app/(app)/settings/security/audit/page.tsx"),
    ).toBe(false);
  });

  it("the SAML redirect docstring still names the backend endpoints it consumes", () => {
    const saml = readSource(
      "../../../apps/web/app/(app)/settings/security/saml/page.tsx",
    );
    // SAML page docstring must name the metadata + cert + health endpoints.
    // Canonical route is /v1/admin/identity/providers (admin-identity.routes.ts);
    // the page consumes it. (The "/sso/providers" spelling was never registered.)
    expect(saml).toContain("/v1/admin/identity/providers");
    expect(saml).toContain("/v1/auth/saml/");
    expect(saml).toContain("test-connection");
    expect(saml).toContain("certificate-next");
    expect(saml).toContain("ingest-metadata");

    // SCIM + Audit no longer have a page-level docstring (the page was
    // deleted). The destination surfaces own their own runbook /
    // observability narrative. We assert the canonical destinations
    // resolve to the SCIM + Audit backend services via the existing
    // /admin/identity/* pages.
    const scimDest = readSource(
      "../../../apps/web/app/(app)/admin/identity/scim/page.tsx",
    );
    expect(scimDest).toContain("/v1/admin/identity/scim/tokens");

    const timelineDest = readSource(
      "../../../apps/web/app/(app)/admin/identity/timeline/page.tsx",
    );
    expect(timelineDest).toContain("/v1/admin/identity/timeline");
  });
});

// ---------------------------------------------------------------------------
// 3. Step-up gating on dangerous admin mutations
// ---------------------------------------------------------------------------

describe("Phase P1 — step-up gating on dangerous identity admin mutations", () => {
  const SCIM_PAGE = readSource(
    "../../../apps/web/app/(app)/admin/identity/scim/page.tsx",
  );
  const SSO_PAGE = readSource(
    "../../../apps/web/app/(app)/security-center/sso/page.tsx",
  );

  it("SCIM token create + revoke route through useStepUpAction", () => {
    expect(SCIM_PAGE).toContain("useStepUpAction");
    expect(SCIM_PAGE).toContain("runStepUpAction");
    expect(SCIM_PAGE).toContain("StepUpModal");
    // The revoke handler wraps the API call in stepUp.runStepUpAction.
    expect(SCIM_PAGE).toMatch(
      /revoke[\s\S]*?stepUp\.runStepUpAction/,
    );
  });

  it("SCIM token revoke surfaces STEP_UP_CANCEL as a visible state, not a silent failure", () => {
    expect(SCIM_PAGE).toContain("STEP_UP_CANCEL");
    expect(SCIM_PAGE).toContain("token remains active");
  });

  it("SAML certificate promotion routes through useStepUpAction", () => {
    expect(SSO_PAGE).toContain("useStepUpAction");
    expect(SSO_PAGE).toContain("runStepUpAction");
    expect(SSO_PAGE).toContain("StepUpModal");
    // The promote handler explicitly wraps the DELETE call.
    expect(SSO_PAGE).toMatch(
      /handlePromoteNextCert[\s\S]*?stepUp\.runStepUpAction/,
    );
  });

  it("SAML cert promotion surfaces STEP_UP_CANCEL as a visible state", () => {
    expect(SSO_PAGE).toContain("STEP_UP_CANCEL");
    expect(SSO_PAGE).toContain("certificate was not promoted");
  });
});

// ---------------------------------------------------------------------------
// 4. Backend still owns the audit + tenancy + step-up authority
// ---------------------------------------------------------------------------

describe("Phase P1 — backend authority preserved (no frontend-only authorization)", () => {
  const SCIM_ROUTES = readSource("../src/routes/scim.routes.ts");
  const SAML_ROUTES = readSource("../src/routes/saml-auth.routes.ts");
  const SCIM_SERVICE = readSource(
    "../src/services/access-control/scim.service.ts",
  );
  const SESSION_INVENTORY = readSource(
    "../src/services/access-control/session-inventory.service.ts",
  );

  it("SCIM routes require authentication on every endpoint", () => {
    // The handler factory wraps requests with bearer-token auth via
    // `authenticateScimRequest` from the SCIM service.
    expect(SCIM_ROUTES).toContain("authenticateScimRequest");
  });

  it("SAML routes emit security events for every login + assertion outcome", () => {
    expect(SAML_ROUTES).toContain("safeEmitSecurityEvent");
    // Event types the audit center timeline consumes.
    expect(SAML_ROUTES).toMatch(/saml_login_(succeeded|failed)/);
  });

  it("SCIM token mutations emit audit events from the service layer", () => {
    // Events live in scim.service.ts (the canonical mutation site),
    // not the routes file. The routes call into the service.
    expect(SCIM_SERVICE).toContain("scim_token_created");
    expect(SCIM_SERVICE).toContain("scim_token_revoked");
  });

  it("session revocation emits the audit event from the service layer", () => {
    expect(SESSION_INVENTORY).toContain("session_revoked_admin");
  });
});

// ---------------------------------------------------------------------------
// 5. Existing identity admin surfaces are not deleted or hollowed
// ---------------------------------------------------------------------------

describe("Phase P1 — existing identity admin surfaces preserved", () => {
  const EXISTING_PAGES = [
    "../../../apps/web/app/(app)/admin/identity/page.tsx",
    "../../../apps/web/app/(app)/admin/identity/providers/page.tsx",
    "../../../apps/web/app/(app)/admin/identity/scim/page.tsx",
    "../../../apps/web/app/(app)/admin/identity/sessions/page.tsx",
    "../../../apps/web/app/(app)/admin/identity/timeline/page.tsx",
    "../../../apps/web/app/(app)/admin/identity/access-reviews/page.tsx",
    "../../../apps/web/app/(app)/admin/identity/permission-matrix/page.tsx",
    "../../../apps/web/app/(app)/admin/identity/runtime/page.tsx",
    "../../../apps/web/app/(app)/security-center/page.tsx",
    "../../../apps/web/app/(app)/security-center/sso/page.tsx",
    "../../../apps/web/app/(app)/security-center/mfa-recovery/page.tsx",
  ];

  for (const path of EXISTING_PAGES) {
    it(`${path.split("/").slice(-3).join("/")} exists + is non-empty`, () => {
      expect(exists(path)).toBe(true);
      const src = readSource(path);
      // A redirect file is < 500 bytes; a full procurement surface is
      // > 1 KB. Either is acceptable for hub/redirect; but the existing
      // pages are NOT permitted to shrink below the hollow-out
      // threshold.
      expect(src.length).toBeGreaterThan(500);
    });
  }
});

// ---------------------------------------------------------------------------
// 6. Vocabulary discipline — no fake claims
// ---------------------------------------------------------------------------

describe("Phase P1 — no fake identity claims", () => {
  // Phase IA-collapse — hub moved to /admin/identity.
  const HUB = readSource(
    "../../../apps/web/app/(app)/admin/identity/page.tsx",
  );

  it("does not claim BYO-KMS, FedRAMP, SOC2, ISO 27001 readiness", () => {
    // These are procurement claims that are NOT shipped in P1 and
    // therefore must not appear on the canonical hub.
    expect(HUB).not.toMatch(/\bBYO-?KMS\b/i);
    expect(HUB).not.toMatch(/\bFedRAMP\b/i);
    expect(HUB).not.toMatch(/\bSOC ?2\b/i);
    expect(HUB).not.toMatch(/\bISO ?27001\b/i);
  });

  it("does not claim destructive operations are guaranteed safe", () => {
    expect(HUB).not.toMatch(/\bguaranteed\b/i);
    expect(HUB).not.toMatch(/\bcannot fail\b/i);
  });

  it("frames step-up as a workspace-flag-driven gate (not a frontend choice)", () => {
    // The hub does not promise step-up will fire; it names it as a
    // conditional gate. This is honest because backend
    // `enforceStepUpIfFlagged` only fires when the workspace flag is
    // set.
    expect(HUB).toMatch(/require\s+step-up\s+where\s+flagged/);
  });
});
