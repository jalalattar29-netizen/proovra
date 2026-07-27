/**
 * PHASE 10 §2 — Organization session-context establishment seams.
 *
 * `establishOrganizationSessionContext` (the ONE advisory-locked concurrent
 * authority) is wired into EVERY org-context establishment seam. This suite
 * machine-locks the caller set and pins the wiring + ordering at each seam.
 * Behavioral limit/idempotency/cross-org logic is proven by the service suite
 * (phase-10-concurrent-session) + the live gate.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const API = resolve(__dirname, "..");
const read = (rel: string) => readFileSync(resolve(API, rel), "utf8");

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) out.push(...walkTs(full));
    else if (e.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

// ── §2.9 — caller lock ──────────────────────────────────────────────────────
describe("§2.9 — establishOrganizationSessionContext callers are LOCKED", () => {
  // The ONLY production files permitted to call the establishment authority.
  const ALLOWED = new Set([
    "src/services/identity/concurrent-session.service.ts", // the authority itself (definition)
    "src/routes/platform-context.routes.ts", // switch-workspace + deep-link/session-restore open
    "src/routes/saml-auth.routes.ts", // §2.1 SAML return
    "src/routes/sso-auth.routes.ts", // §2.2 OIDC return
    "src/routes/organizations.routes.ts", // §2.2 invitation accept → governance-only open
  ]);

  it("no route/service outside the locked set calls establishOrganizationSessionContext", () => {
    const offenders: string[] = [];
    for (const f of walkTs(resolve(API, "src"))) {
      const rel = f.slice(API.length + 1).replace(/\\/g, "/");
      if (ALLOWED.has(rel)) continue;
      if (/establishOrganizationSessionContext\s*\(/.test(readFileSync(f, "utf8"))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("no route implements its own concurrent-session count/limit logic", () => {
    for (const f of walkTs(resolve(API, "src/routes"))) {
      const src = readFileSync(f, "utf8");
      // Routes must delegate to the authority, never read the limit or count sessions themselves.
      expect(src).not.toMatch(/\.concurrentSessionLimit\b/);
      expect(src).not.toMatch(/authenticatedSession\.count\(/);
    }
  });
});

// ── §2.1 SAML return wiring + ordering ──────────────────────────────────────
describe("§2.1 — SAML return establishes org context before returning workspace context", () => {
  const SAML = read("src/routes/saml-auth.routes.ts");

  it("calls the establishment authority with the SAML session's org + sessionId", () => {
    expect(SAML).toMatch(/establishOrganizationSessionContext\(/);
    expect(SAML).toMatch(/organizationIdForPolicy\(conn\.teamId/);
    expect(SAML).toMatch(/sessionIdHash:\s*hashSessionId\(sid\)/);
  });

  it("records the session (inventory) BEFORE establishing context, and bounces on denial", () => {
    const recordIdx = SAML.indexOf("recordAuthenticatedSession(");
    const establishIdx = SAML.indexOf("establishOrganizationSessionContext(");
    const cookieIdx = SAML.lastIndexOf("setSessionCookie(req, reply, token)");
    expect(recordIdx).toBeGreaterThan(-1);
    expect(recordIdx).toBeLessThan(establishIdx); // inventory first
    expect(establishIdx).toBeLessThan(cookieIdx); // context/limit before returning session
    // §2.1 — denial deletes the just-created orphan session, then bounces.
    expect(SAML).toMatch(/if \(!seat\.allowed\)/);
    expect(SAML).toMatch(/bounceToSamlError\(reply, seat\.reason/);
    expect(SAML).toMatch(/authenticatedSession\.delete\(\{ where: \{ id: session\.id \} \}\)/);
  });

  it("preserves SAML provenance + original authAt (no reset at establishment)", () => {
    expect(SAML).toMatch(/authMethod:\s*"SAML"/);
    expect(SAML).toMatch(/authAt:\s*issuedAt/);
    // The establishment does not re-sign or reset authAt.
    expect(SAML).not.toMatch(/establishOrganizationSessionContext[\s\S]{0,200}authAt:/);
  });
});

// ── §2.2 OIDC return wiring + ordering ──────────────────────────────────────
describe("§2.2 — OIDC return establishes org context before returning workspace context", () => {
  const OIDC = read("src/routes/sso-auth.routes.ts");

  it("calls the establishment authority with the OIDC session's org + sessionId", () => {
    expect(OIDC).toMatch(/establishOrganizationSessionContext\(/);
    expect(OIDC).toMatch(/organizationIdForPolicy\(result\.teamId/);
    expect(OIDC).toMatch(/sessionIdHash:\s*hashSessionId\(sid\)/);
  });

  it("records session BEFORE establishing context; denial bounces before the cookie", () => {
    const recordIdx = OIDC.indexOf("recordAuthenticatedSession(");
    const establishIdx = OIDC.indexOf("establishOrganizationSessionContext(");
    const cookieIdx = OIDC.lastIndexOf("setSessionCookie(req, reply, token)");
    expect(recordIdx).toBeLessThan(establishIdx);
    expect(establishIdx).toBeLessThan(cookieIdx);
    expect(OIDC).toMatch(/if \(!seat\.allowed\)/);
    expect(OIDC).toMatch(/bounceToAuthError\(reply, seat\.reason\)/);
    // §2.1 — denial deletes the just-created orphan session.
    expect(OIDC).toMatch(/authenticatedSession\.delete\(\{ where: \{ id: session\.id \} \}\)/);
  });

  it("preserves OIDC provenance + original authAt", () => {
    expect(OIDC).toMatch(/authMethod:\s*"OIDC"/);
    expect(OIDC).toMatch(/authAt:\s*issuedAt/);
  });
});

// ── §2.2 invitation return governance-only success ──────────────────────────
describe("§2.2 — invitation accept composes governance-only success", () => {
  const ORG = read("src/routes/organizations.routes.ts");
  it("accept attempts establishment and returns invitationAccepted + workspaceOpened", () => {
    // Acceptance (Membership Orchestrator) precedes the establishment attempt.
    const acceptIdx = ORG.indexOf("acceptOrganizationInvite(");
    const establishIdx = ORG.indexOf("establishOrganizationSessionContext(");
    expect(acceptIdx).toBeGreaterThan(-1);
    expect(acceptIdx).toBeLessThan(establishIdx);
    expect(ORG).toMatch(/invitationAccepted:\s*true/);
    expect(ORG).toMatch(/workspaceOpened/);
    expect(ORG).toMatch(/CONCURRENT_SESSION_LIMIT_REACHED/);
    // The accepted membership STANDS on limit denial — the establishment failure
    // only sets workspaceOpened=false; it does not revoke the just-created grant.
    const establishBlock = ORG.slice(ORG.indexOf("establishOrganizationSessionContext("), ORG.indexOf("invitationAccepted:"));
    expect(establishBlock).not.toMatch(/revoke|rollback|delete/i);
  });
});

// ── §2.6 middleware context healing (continuous enforcement, no Personal fallback)
describe("§2.6 — middleware denies invalid org context (no silent Personal fallback)", () => {
  const MW = read("src/middleware/auth.ts");
  it("requireAuth re-evaluates org context and denies (401/503) — never falls back to Personal", () => {
    expect(MW).toMatch(/evaluateOrgContextForSession/);
    expect(MW).toMatch(/SECURITY_CONTEXT_UNAVAILABLE/);
    // No Personal-scope fallback on org-context denial.
    expect(MW).not.toMatch(/currentWorkspaceId:\s*null/);
  });
});
