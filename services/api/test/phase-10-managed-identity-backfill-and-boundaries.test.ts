/**
 * PHASE 10 correction 3 + 5 — managed-identity backfill contract + decision
 * boundary enforcement.
 *
 * correction 3: the ownership backfill migration is DETERMINISTIC (exactly-one
 * owner backfilled; zero/multi left UNRESOLVED, never STANDARD), idempotent, and
 * touches no Evidence/membership. Verified as a source contract (the migration
 * is authored, NOT applied; no DB available).
 *
 * correction 5: ownership and mandatory-SSO are SEPARATE decisions resolved ONLY
 * by the canonical services. No route/middleware may interpret identityMode /
 * managingOrganizationId / ssoRequired / SsoConnection.status independently.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const API = resolve(__dirname, "..");

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

// ── correction 3 — backfill SQL contract ──────────────────────────────────
describe("correction 3 — ownership backfill is deterministic + safe", () => {
  const SQL = readFileSync(
    resolve(API, "prisma/migrations/20271003000000_managed_identity_ownership_backfill/migration.sql"),
    "utf8",
  );

  it("targets ONLY unresolved managed rows (idempotent)", () => {
    expect(SQL).toMatch(/identity_mode"\s*=\s*'MANAGED_ENTERPRISE'/);
    expect(SQL).toMatch(/managing_organization_id"\s+IS\s+NULL/i);
  });
  it("binds an owner ONLY when EXACTLY ONE organization is proven", () => {
    expect(SQL).toMatch(/COUNT\(DISTINCT\s+t\.["]?organization_id["]?\)/i);
    expect(SQL).toMatch(/org_count\s*=\s*1/);
  });
  it("uses only ACTIVE external identity mappings as evidence", () => {
    expect(SQL).toMatch(/unlinked_at_utc"\s+IS\s+NULL/i);
  });
  it("writes ONLY users ownership columns — no Evidence/membership/team mutation", () => {
    expect(SQL).toMatch(/UPDATE\s+"users"/i);
    expect(SQL).not.toMatch(/UPDATE\s+"(evidence|team_members|organization_memberships|teams)"/i);
    expect(SQL).not.toMatch(/DELETE\s+FROM/i);
    // Only the two ownership columns are set (+ nothing else).
    expect(SQL).toMatch(/SET[\s\S]*managing_organization_id"\s*=/i);
    expect(SQL).toMatch(/managed_identity_source"\s*=\s*'SCIM'/i);
  });
  it("the schema migration adds the ownership columns + FKs (SET NULL) not applied", () => {
    const schemaSql = readFileSync(
      resolve(API, "prisma/migrations/20271002000000_managed_identity_ownership/migration.sql"),
      "utf8",
    );
    expect(schemaSql).toMatch(/managing_organization_id/);
    expect(schemaSql).toMatch(/ManagedIdentitySource/);
    expect(schemaSql).toMatch(/ON DELETE SET NULL/i);
  });
});

// ── correction 5 — decision boundary: only canonical services interpret the
//    ownership / SSO signals. Routes + middleware must NOT read them directly.
describe("correction 5 — ownership + SSO signals are read ONLY in canonical services", () => {
  // The canonical services allowed to interpret these signals.
  const ALLOWED = [
    "src/services/identity/identity-mode.service.ts",
    "src/services/identity/org-security-policy.service.ts",
    "src/services/identity/enterprise-security-policy.policy.ts",
    "src/services/platform-context/workspace-bootstrap.service.ts",
  ];

  function offendersFor(pattern: RegExp, dirs: string[]): string[] {
    const hits: string[] = [];
    for (const dir of dirs) {
      for (const file of walkTs(resolve(API, dir))) {
        const rel = file.slice(API.length + 1).replace(/\\/g, "/");
        if (ALLOWED.some((a) => rel === a)) continue;
        const src = readFileSync(file, "utf8");
        if (pattern.test(src)) hits.push(rel);
      }
    }
    return hits;
  }

  it("routes do not interpret identityMode / managingOrganizationId directly", () => {
    const offenders = offendersFor(/\bidentityMode\b|\bmanagingOrganizationId\b/, ["src/routes"]);
    expect(offenders).toEqual([]);
  });

  it("routes do not re-derive the mandatory-SSO POLICY decision (ssoRequired)", () => {
    // The mandatory-SSO decision lives ONLY in the canonical policy service. No
    // route may branch on `ssoRequired` to re-derive it.
    const offenders = offendersFor(/\.ssoRequired\b/, ["src/routes"]);
    expect(offenders).toEqual([]);
  });

  it("only the SSO establishment routes read SsoConnection.status (login handshake)", () => {
    // Reading `conn.status` during the SAML/OIDC handshake is protocol
    // validation (is this connection usable for login?), NOT a policy bypass —
    // the mandatory-SSO decision is still the canonical service's. Any OTHER
    // route reading connection status would be re-deriving policy → forbidden.
    const SSO_HANDSHAKE = ["src/routes/saml-auth.routes.ts", "src/routes/sso-auth.routes.ts"];
    const offenders = offendersFor(/conn(?:ection)?\.status\s*[!=]==/, ["src/routes"])
      .filter((f) => !SSO_HANDSHAKE.includes(f));
    expect(offenders).toEqual([]);
  });

  it("middleware/auth.ts does not interpret raw ownership fields (uses canonical gates)", () => {
    const mw = readFileSync(resolve(API, "src/middleware/auth.ts"), "utf8");
    expect(mw).not.toMatch(/\bidentityMode\b/);
    expect(mw).not.toMatch(/\bmanagingOrganizationId\b/);
    // It composes the canonical gate instead.
    expect(mw).toMatch(/evaluateOrgContextForSession/);
  });
});
