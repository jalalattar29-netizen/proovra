/**
 * PHASE 13 §2 — the 17-family SECURITY classification, DERIVED.
 *
 * This is not a new analyzer. It is a pure derivation over facts the canonical
 * AST engine already produces per route — `authorizationClass`, `gates`,
 * `method`, `path` — so there is no second source of truth to drift. The AST
 * engine decides HOW a route is enforced by following guards to their terminal
 * markers (the constant-time cron compare, the SCIM bearer authority, the
 * `authorizeOrFail` evaluator, the session cookie); this module only NAMES the
 * result in the vocabulary the closure gate reports.
 *
 * PRIMARY vs SECONDARY
 * ---------------------------------------------------------------------------
 * Every production route gets exactly ONE `primarySecurityFamily` — its
 * enforcement authority — chosen by a fixed precedence. The precedence prefers
 * the MOST SPECIFIC mechanism, because a route that reaches, say, the SCIM
 * bearer authority is a SCIM route whatever else its path looks like.
 *
 * Domain families that describe WHAT a route touches rather than HOW it is
 * guarded — BILLING_OR_PAYMENT, UPLOAD_DOWNLOAD_EXPORT_SHARE — are recorded as
 * SECONDARY tags. They are compositional by nature (a billing webhook is
 * WEBHOOK_SIGNATURE-enforced and BILLING-domain at once), so forcing them to be
 * a primary would either lie about the enforcement or double-count.
 *
 * A route is not "secure" because it has a session. `SESSION_AUTHENTICATED`
 * means exactly that and no more; `WORKSPACE_AUTHORIZED` /
 * `ORGANIZATION_AUTHORIZED` are the ones that reached the tenant-binding
 * evaluator. Keeping them distinct is the point — it is what makes a
 * session-only route on tenant data visible instead of hidden inside a generic
 * "authenticated" bucket.
 */

/** The 17 families the mandate enumerates, in report order. */
export const SECURITY_FAMILIES = Object.freeze([
  "PUBLIC_READ",
  "PUBLIC_WRITE",
  "SESSION_AUTHENTICATED",
  "WORKSPACE_AUTHORIZED",
  "ORGANIZATION_AUTHORIZED",
  "PLATFORM_ADMIN",
  "API_KEY_SCOPED",
  "CRON_OR_MACHINE_SECRET",
  "WEBHOOK_SIGNATURE",
  "SAML",
  "OIDC",
  "SCIM_BEARER",
  "PORTAL_OR_REVIEWER_TOKEN",
  "INTAKE_OR_EVIDENCE_REQUEST_TOKEN",
  "BILLING_OR_PAYMENT",
  "UPLOAD_DOWNLOAD_EXPORT_SHARE",
  "OPERATIONAL_HEALTH_METRICS_DEBUG_SEED",
]);

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Path predicates. Deliberately anchored to the real route vocabulary so a
// substring accident (e.g. "billing" inside another word) cannot mis-tag.
const isOperationalPath = (p) =>
  /^\/(healthz|readyz|health|metrics)(\/|$)/.test(p) ||
  /^\/v1\/(ops|internal|runtime|reliability|observability)(\/|$)/.test(p) ||
  /(^|\/)(debug|seed)(\/|$)/.test(p);
/**
 * THE ORGANIZATION SURFACE, spelled the way this API actually spells it.
 *
 * The previous predicate was `/^\/v1\/organizations(\/|$)/` — a path this
 * repository registers exactly zero routes at. The real surface is `/v1/orgs`,
 * plus the organization-owned provisioning surfaces (SCIM, SSO connections).
 * The consequence was not a cosmetic mislabel: `ORGANIZATION_AUTHORIZED` came
 * out 0 and `ORGANIZATION_SCOPED` came out 0, so the report showed an
 * organization-tier product with no organization-scoped routes at all, and
 * every organization route that DOES reach the canonical evaluator was filed
 * under the workspace family where nobody would look for it.
 */
const isOrganizationPath = (p) =>
  /^\/v1\/orgs(\/|$)/.test(p) ||
  /^\/v1\/organizations(\/|$)/.test(p) ||
  /^\/v[12]\/scim(\/|$)/.test(p) ||
  /^\/v1\/organization-/.test(p);

const isSamlPath = (p) => /^\/v1\/auth\/saml(\/|$)/.test(p);
const isOidcPath = (p) =>
  /^\/v1\/auth\/oidc(\/|$)/.test(p) || /^\/v1\/auth\/sso\//.test(p);
const isBillingPath = (p) =>
  /^\/v1\/(billing|payments?|subscriptions?|checkout|invoices?)(\/|$)/.test(p) ||
  /(^|\/)(stripe|paypal)(\/|$)/.test(p);
const isUploadPath = (p) =>
  /(^|\/)(upload|uploads|download|downloads|export|exports|share|shares|attachments?|files?|objects?)(\/|$)/.test(
    p,
  ) || /(^|\/)(evidence|reports?|packages?)\/[^/]+\/(download|export|share)(\/|$)/.test(p);

/**
 * The ONE primary family for a route, by precedence. `authClass` is the AST
 * engine's terminal-marker verdict; `method`/`path` refine it.
 *
 * Returns null only for a route the engine could not classify at all
 * (`AUTHORIZATION_UNRESOLVED`), which the engine separately gates to zero — a
 * null here is a genuine "unclassified", never a silent default.
 */
export function derivePrimarySecurityFamily(row) {
  const authClass = row.authorizationClass;
  const method = String(row.method || "").toUpperCase();
  const path = String(row.path || "");

  // Operational/health/metrics/debug/seed is primary when the PATH says so,
  // regardless of whether it also carries a machine secret — it is the family
  // that describes the surface an operator or scraper reaches.
  if (isOperationalPath(path)) return "OPERATIONAL_HEALTH_METRICS_DEBUG_SEED";

  switch (authClass) {
    case "WEBHOOK_SIGNATURE":
      return "WEBHOOK_SIGNATURE";
    case "SCIM_BEARER":
      return "SCIM_BEARER";
    case "CRON_SECRET":
    case "INTERNAL_SERVICE":
      return "CRON_OR_MACHINE_SECRET";
    case "API_KEY_SCOPED":
      return "API_KEY_SCOPED";
    case "PORTAL_TOKEN":
      return "PORTAL_OR_REVIEWER_TOKEN";
    case "INVITATION_TOKEN":
      return "INTAKE_OR_EVIDENCE_REQUEST_TOKEN";
    case "ADMIN_GATED":
      return "PLATFORM_ADMIN";
    case "ORGANIZATION_GATED":
      // The organization evaluator names the family outright; the path is not
      // consulted, because the authority reached is the fact that matters.
      return "ORGANIZATION_AUTHORIZED";
    case "CAPABILITY_GATED":
      // The tenant-binding evaluator. Organization-scoped when the path is an
      // organization surface; otherwise workspace-scoped.
      return isOrganizationPath(path) ? "ORGANIZATION_AUTHORIZED" : "WORKSPACE_AUTHORIZED";
    case "AUTHENTICATED":
      // Session established, no tenant-binding gate reached. Named honestly.
      return "SESSION_AUTHENTICATED";
    case "PUBLIC_UNGUARDED":
      // SAML/OIDC endpoints are public by protocol (login/ACS/metadata) but are
      // their own security family — the assertion/signature IS the control.
      if (isSamlPath(path)) return "SAML";
      if (isOidcPath(path)) return "OIDC";
      return WRITE_METHODS.has(method) ? "PUBLIC_WRITE" : "PUBLIC_READ";
    case "MULTI_GATE": {
      // Resolve the strongest specific gate the engine recorded, mirroring its
      // own precedence (specific machine/token gates outrank session).
      const g = new Set(row.gates || []);
      if (g.has("WEBHOOK_SIGNATURE")) return "WEBHOOK_SIGNATURE";
      if (g.has("SCIM_BEARER")) return "SCIM_BEARER";
      if (g.has("CRON_SECRET") || g.has("INTERNAL_SERVICE")) return "CRON_OR_MACHINE_SECRET";
      if (g.has("API_KEY_SCOPED")) return "API_KEY_SCOPED";
      if (g.has("PORTAL_TOKEN")) return "PORTAL_OR_REVIEWER_TOKEN";
      if (g.has("INVITATION_TOKEN")) return "INTAKE_OR_EVIDENCE_REQUEST_TOKEN";
      if (g.has("ADMIN_GATED")) return "PLATFORM_ADMIN";
      if (g.has("ORGANIZATION_GATED")) return "ORGANIZATION_AUTHORIZED";
      if (g.has("CAPABILITY_GATED")) {
        return isOrganizationPath(path) ? "ORGANIZATION_AUTHORIZED" : "WORKSPACE_AUTHORIZED";
      }
      if (isSamlPath(path)) return "SAML";
      if (isOidcPath(path)) return "OIDC";
      return "SESSION_AUTHENTICATED";
    }
    default:
      return null; // AUTHORIZATION_UNRESOLVED and any unforeseen class.
  }
}

/** Domain tags that apply IN ADDITION to the primary enforcement family. */
export function deriveSecondarySecurityFamilies(row, primary) {
  const path = String(row.path || "");
  const out = new Set();
  if (isBillingPath(path)) out.add("BILLING_OR_PAYMENT");
  if (isUploadPath(path)) out.add("UPLOAD_DOWNLOAD_EXPORT_SHARE");
  if (isSamlPath(path)) out.add("SAML");
  if (isOidcPath(path)) out.add("OIDC");
  if (isOperationalPath(path)) out.add("OPERATIONAL_HEALTH_METRICS_DEBUG_SEED");
  out.delete(primary); // never list the primary as its own secondary
  return [...out];
}

/**
 * The authorities behind the decision, named for the row. These are derived
 * from the engine's evidence, not re-discovered, so they cannot disagree with
 * the classification they accompany.
 */
export function deriveSecurityAuthorities(row) {
  const authClass = row.authorizationClass;
  const gates = row.gates || [];
  const orgBound =
    authClass === "ORGANIZATION_GATED" ||
    (authClass === "MULTI_GATE" && gates.includes("ORGANIZATION_GATED"));
  const tenantBound =
    authClass === "CAPABILITY_GATED" ||
    (authClass === "MULTI_GATE" && gates.includes("CAPABILITY_GATED"));
  return {
    authenticationAuthority: authClass,
    authorizationAuthority: authClass,
    tenantBindingAuthority: orgBound
      ? "checkOrgAccess (org lifecycle + ACTIVE org membership + role precedence)"
      : tenantBound
        ? "authorizeOrFail (ACTIVE membership + tenant + capability)"
        : null,
  };
}

/** Attach the full security classification to a route row (mutates a copy). */
export function classifyRouteSecurity(row) {
  const primarySecurityFamily = derivePrimarySecurityFamily(row);
  const secondarySecurityFamilies = primarySecurityFamily
    ? deriveSecondarySecurityFamilies(row, primarySecurityFamily)
    : [];
  return {
    ...row,
    primarySecurityFamily,
    secondarySecurityFamilies,
    ...deriveSecurityAuthorities(row),
  };
}
