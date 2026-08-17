/**
 * PHASE 13 §2 — adversarial fixtures for the 17-family security derivation.
 *
 * The derivation is a pure function of the engine's own facts, so it is tested
 * directly: a hand-built route row in, a family out. Each case is a specific
 * evasion the classification must NOT fall for — a public write mislabelled as
 * a read, a session-only route mislabelled as tenant-bound, a machine gate
 * hidden inside a MULTI_GATE, a domain path masquerading as its enforcement.
 */

import { describe, expect, it } from "vitest";

// Typed via test/capability-authority-modules.d.ts (the ambient declarations
// for the .mjs engine modules) — same pattern the Phase-12 analyzer suites use.
import {
  SECURITY_FAMILIES,
  classifyRouteSecurity,
  derivePrimarySecurityFamily,
} from "../scripts/capability-authority/security-families.mjs";

type Row = {
  routeId?: string;
  method: string;
  path: string;
  authorizationClass: string;
  gates?: string[];
};
const fam = (r: Row): string | null => derivePrimarySecurityFamily(r);

describe("PHASE 13 §2 — primary security family derivation", () => {
  it("there are exactly 17 families", () => {
    expect(SECURITY_FAMILIES).toHaveLength(17);
  });

  it("public GET → PUBLIC_READ; public write → PUBLIC_WRITE (split by method)", () => {
    expect(fam({ method: "GET", path: "/v1/billing/pricing", authorizationClass: "PUBLIC_UNGUARDED" })).toBe("PUBLIC_READ");
    expect(fam({ method: "POST", path: "/v1/contact-sales", authorizationClass: "PUBLIC_UNGUARDED" })).toBe("PUBLIC_WRITE");
    expect(fam({ method: "DELETE", path: "/v1/x", authorizationClass: "PUBLIC_UNGUARDED" })).toBe("PUBLIC_WRITE");
  });

  it("session-only is SESSION_AUTHENTICATED and NEVER silently upgraded to tenant-bound", () => {
    const f = classifyRouteSecurity({ method: "GET", path: "/v1/users/me", authorizationClass: "AUTHENTICATED", gates: ["AUTHENTICATED"] } as Row);
    expect(f.primarySecurityFamily).toBe("SESSION_AUTHENTICATED");
    // The tenant-binding authority must be null — the honest fact that no
    // tenant gate was reached.
    expect(f.tenantBindingAuthority).toBeNull();
  });

  it("the capability evaluator → WORKSPACE_AUTHORIZED, with a named tenant-binding authority", () => {
    const f = classifyRouteSecurity({ method: "POST", path: "/v1/cases", authorizationClass: "CAPABILITY_GATED", gates: ["CAPABILITY_GATED"] } as Row);
    expect(f.primarySecurityFamily).toBe("WORKSPACE_AUTHORIZED");
    expect(f.tenantBindingAuthority).toMatch(/authorizeOrFail/);
  });

  it("an organization surface under the capability evaluator → ORGANIZATION_AUTHORIZED", () => {
    expect(fam({ method: "POST", path: "/v1/organizations/:id/members", authorizationClass: "CAPABILITY_GATED" })).toBe("ORGANIZATION_AUTHORIZED");
  });

  it("machine and token gates map to their families", () => {
    expect(fam({ method: "POST", path: "/v1/reviewer-ops/reconcile", authorizationClass: "CRON_SECRET" })).toBe("CRON_OR_MACHINE_SECRET");
    expect(fam({ method: "POST", path: "/v1/scim/v2/Users", authorizationClass: "SCIM_BEARER" })).toBe("SCIM_BEARER");
    expect(fam({ method: "POST", path: "/v1/webhooks/stripe", authorizationClass: "WEBHOOK_SIGNATURE" })).toBe("WEBHOOK_SIGNATURE");
    expect(fam({ method: "GET", path: "/v1/integrations/x", authorizationClass: "API_KEY_SCOPED" })).toBe("API_KEY_SCOPED");
    expect(fam({ method: "GET", path: "/v1/portal/x", authorizationClass: "PORTAL_TOKEN" })).toBe("PORTAL_OR_REVIEWER_TOKEN");
    expect(fam({ method: "POST", path: "/v1/intake/x", authorizationClass: "INVITATION_TOKEN" })).toBe("INTAKE_OR_EVIDENCE_REQUEST_TOKEN");
    expect(fam({ method: "GET", path: "/v1/admin/x", authorizationClass: "ADMIN_GATED" })).toBe("PLATFORM_ADMIN");
  });

  it("a machine gate hidden inside a MULTI_GATE is not lost to the session fallback", () => {
    // A route that reaches BOTH a cron secret and session auth is a machine
    // route, not a session route — the specific gate wins.
    expect(
      fam({ method: "POST", path: "/v1/x", authorizationClass: "MULTI_GATE", gates: ["AUTHENTICATED", "CRON_SECRET"] }),
    ).toBe("CRON_OR_MACHINE_SECRET");
    expect(
      fam({ method: "POST", path: "/v1/x", authorizationClass: "MULTI_GATE", gates: ["AUTHENTICATED", "CAPABILITY_GATED"] }),
    ).toBe("WORKSPACE_AUTHORIZED");
  });

  it("SAML/OIDC public protocol endpoints are their own family, not PUBLIC_*", () => {
    expect(fam({ method: "POST", path: "/v1/auth/saml/acs", authorizationClass: "PUBLIC_UNGUARDED" })).toBe("SAML");
    expect(fam({ method: "GET", path: "/v1/auth/saml/:id/login", authorizationClass: "PUBLIC_UNGUARDED" })).toBe("SAML");
    expect(fam({ method: "GET", path: "/v1/auth/oidc/:id/callback", authorizationClass: "PUBLIC_UNGUARDED" })).toBe("OIDC");
  });

  it("operational/health/metrics/seed paths are OPERATIONAL even when they also carry a machine secret", () => {
    expect(fam({ method: "GET", path: "/metrics", authorizationClass: "PUBLIC_UNGUARDED" })).toBe("OPERATIONAL_HEALTH_METRICS_DEBUG_SEED");
    expect(fam({ method: "GET", path: "/healthz", authorizationClass: "PUBLIC_UNGUARDED" })).toBe("OPERATIONAL_HEALTH_METRICS_DEBUG_SEED");
    expect(fam({ method: "POST", path: "/v1/ops/seed/run", authorizationClass: "CRON_SECRET" })).toBe("OPERATIONAL_HEALTH_METRICS_DEBUG_SEED");
  });

  it("BILLING and UPLOAD are SECONDARY domain tags over the enforcement primary, never a hidden primary", () => {
    const billingWebhook = classifyRouteSecurity({ method: "POST", path: "/v1/billing/webhooks/stripe", authorizationClass: "WEBHOOK_SIGNATURE" } as Row);
    expect(billingWebhook.primarySecurityFamily).toBe("WEBHOOK_SIGNATURE");
    expect(billingWebhook.secondarySecurityFamilies).toContain("BILLING_OR_PAYMENT");

    const exportRoute = classifyRouteSecurity({ method: "GET", path: "/v1/evidence/:id/export", authorizationClass: "CAPABILITY_GATED" } as Row);
    expect(exportRoute.primarySecurityFamily).toBe("WORKSPACE_AUTHORIZED");
    expect(exportRoute.secondarySecurityFamilies).toContain("UPLOAD_DOWNLOAD_EXPORT_SHARE");
  });

  it("an unresolved authorization class yields null — a gap, never a default family", () => {
    expect(fam({ method: "GET", path: "/v1/x", authorizationClass: "AUTHORIZATION_UNRESOLVED" })).toBeNull();
  });

  it("every non-null primary family is one of the 17", () => {
    const samples: Row[] = [
      { method: "GET", path: "/a", authorizationClass: "PUBLIC_UNGUARDED" },
      { method: "POST", path: "/a", authorizationClass: "PUBLIC_UNGUARDED" },
      { method: "GET", path: "/a", authorizationClass: "AUTHENTICATED" },
      { method: "GET", path: "/a", authorizationClass: "CAPABILITY_GATED" },
      { method: "GET", path: "/v1/organizations/x", authorizationClass: "CAPABILITY_GATED" },
      { method: "GET", path: "/a", authorizationClass: "ADMIN_GATED" },
      { method: "GET", path: "/a", authorizationClass: "API_KEY_SCOPED" },
      { method: "GET", path: "/a", authorizationClass: "CRON_SECRET" },
      { method: "GET", path: "/a", authorizationClass: "WEBHOOK_SIGNATURE" },
      { method: "GET", path: "/a", authorizationClass: "SCIM_BEARER" },
      { method: "GET", path: "/a", authorizationClass: "PORTAL_TOKEN" },
      { method: "GET", path: "/a", authorizationClass: "INVITATION_TOKEN" },
    ];
    for (const s of samples) {
      const f = fam(s);
      expect(f, `${s.authorizationClass} produced ${f}`).not.toBeNull();
      expect(SECURITY_FAMILIES).toContain(f);
    }
  });
});
