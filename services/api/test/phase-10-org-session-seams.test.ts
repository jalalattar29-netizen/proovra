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
    "src/services/identity/sso-session-completion.service.ts", // §2.1/§2.2 SAML + OIDC return, IDENT-011
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

  it("no route implements its own concurrent-session ENFORCEMENT", () => {
    // The invariant is about the DECISION, not about the word: a route may
    // never decide whether a session is allowed, because that decision lives
    // in `establishOrganizationSessionContext`.
    //
    // `/v1/identity-security/session-policy-impact` legitimately READS the
    // configured limit to render a read-only "who would be affected if you
    // changed this" projection. It gates nothing — it is the admin preview of
    // a decision the authority will make. Reading a policy value for display
    // is not re-implementing the policy, so the check below bans the
    // enforcement shapes rather than the mention.
    const PROJECTION_ONLY = new Set(["identity-security.routes.ts"]);
    for (const f of walkTs(resolve(API, "src/routes"))) {
      const src = readFileSync(f, "utf8");
      const base = f.split(/[\\/]/).pop() ?? "";
      // Nobody counts sessions to decide anything.
      expect(src, base).not.toMatch(/authenticatedSession\.count\(/);
      // Nobody turns the limit into an allow/deny.
      expect(src, base).not.toMatch(
        /concurrentSessionLimit[\s\S]{0,120}(reply\.code\(4\d\d\)|throw new)/,
      );
      if (!PROJECTION_ONLY.has(base)) {
        expect(src, base).not.toMatch(/\.concurrentSessionLimit\b/);
      }
    }
  });
});

// IDENT-011 — the establishment moved out of both SSO routes into the one
// completion routine, which the MFA routes also run. The route keeps the
// inventory write, the bounce and the cookie; the routine keeps the rest.
const COMPLETION = read("src/services/identity/sso-session-completion.service.ts");

describe("SSO session completion — the establishment both SSO returns share", () => {
  it("resolves the org from the connection's workspace and hashes the session's sid", () => {
    expect(COMPLETION).toMatch(/establishOrganizationSessionContext\(/);
    expect(COMPLETION).toMatch(/organizationIdForPolicy\(input\.teamId/);
    expect(COMPLETION).toMatch(/sessionIdHash:\s*hashSessionId\(input\.sid\)/);
  });

  it("a denial deletes the just-created orphan session and refuses with the reason", () => {
    expect(COMPLETION).toMatch(
      /dropSession = \(\) =>\s*client\.authenticatedSession\.delete\(\{ where: \{ id: input\.sessionId \} \}\)/,
    );
    expect(COMPLETION).toMatch(
      /if \(!seat\.allowed\) \{\s*await dropSession\(\);\s*return \{ allowed: false, reason: seat\.reason \};/,
    );
  });

  it("the establishment does not re-sign or reset authAt", () => {
    expect(COMPLETION).not.toMatch(/authAt/);
  });
});

// ── §2.1 SAML return wiring + ordering ──────────────────────────────────────
describe("§2.1 — SAML return establishes org context before returning workspace context", () => {
  const SAML = read("src/routes/saml-auth.routes.ts");

  it("calls the completion with the SAML connection's workspace + the session's sid", () => {
    expect(SAML).toMatch(
      /completeSsoSession\(\s*\{[\s\S]{0,160}teamId: conn\.teamId,[\s\S]{0,160}sessionId: session\.id,\s*sid,/,
    );
  });

  it("records the session (inventory) BEFORE establishing context, and bounces on denial", () => {
    const recordIdx = SAML.indexOf("recordAuthenticatedSession(");
    const completeIdx = SAML.indexOf("completeSsoSession(");
    const cookieIdx = SAML.lastIndexOf("setSessionCookie(req, reply, token)");
    expect(recordIdx).toBeGreaterThan(-1);
    expect(recordIdx).toBeLessThan(completeIdx); // inventory first
    expect(completeIdx).toBeLessThan(cookieIdx); // context/limit before returning session
    // §2.1 — denial bounces; the completion has already deleted the orphan row.
    expect(SAML).toMatch(/if \(!completion\.allowed\)/);
    expect(SAML).toMatch(/bounceToSamlError\(reply, completion\.reason/);
  });

  it("preserves SAML provenance + original authAt (no reset at establishment)", () => {
    expect(SAML).toMatch(/authMethod:\s*"SAML"/);
    expect(SAML).toMatch(/authAt:\s*issuedAt/);
    // The establishment does not re-sign or reset authAt.
    expect(SAML).not.toMatch(/completeSsoSession\([\s\S]{0,200}authAt:/);
  });
});

// ── §2.2 OIDC return wiring + ordering ──────────────────────────────────────
describe("§2.2 — OIDC return establishes org context before returning workspace context", () => {
  const OIDC = read("src/routes/sso-auth.routes.ts");

  it("calls the completion with the OIDC session's workspace + sid", () => {
    expect(OIDC).toMatch(
      /completeSsoSession\(\s*\{[\s\S]{0,160}teamId: result\.teamId,[\s\S]{0,160}sessionId: session\.id,\s*sid,/,
    );
  });

  it("records session BEFORE establishing context; denial bounces before the cookie", () => {
    const recordIdx = OIDC.indexOf("recordAuthenticatedSession(");
    const completeIdx = OIDC.indexOf("completeSsoSession(");
    const cookieIdx = OIDC.lastIndexOf("setSessionCookie(req, reply, token)");
    expect(recordIdx).toBeLessThan(completeIdx);
    expect(completeIdx).toBeLessThan(cookieIdx);
    expect(OIDC).toMatch(/if \(!completion\.allowed\)/);
    expect(OIDC).toMatch(/bounceToAuthError\(reply, completion\.reason/);
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
