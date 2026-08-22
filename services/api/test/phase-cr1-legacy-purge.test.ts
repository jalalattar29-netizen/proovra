/**
 * PHASE CR1 — Legacy & Duplicate System Purge guardrails.
 *
 * CR1 was a surgical stabilization phase. The platform was reduced to
 * one canonical operational path. This test file PINS the deletions so
 * the deleted surfaces cannot quietly come back.
 *
 * What CR1 actually removed (pinned here):
 *   Phase A — `routes/audit.routes.ts` (legacy no-op shim)
 *   Phase B — `routes/webhook.routes.ts` (per-org in-memory webhooks)
 *             + `server.ts` import + registration
 *   Phase D — `addHook("onRequest", auditMiddleware)` in server.ts
 *             + `middleware/audit.middleware.ts`
 *             + `services/audit.service.ts` (in-memory tombstone)
 *   Phase E — `services/webhook.service.ts` (in-memory orphan)
 *             + dead `getWebhookService()` import in enterprise.routes.ts
 *   Phase F — `opsSeedRoutes` registration env-guarded by
 *             OPERATIONAL_SEEDING_ENABLED.
 *   Part 2  — 8 backward-compat redirect pages folded into
 *             apps/web/next.config.js `redirects()`:
 *               /dashboard, /archive, /deleted, /locked,
 *               /operations, /review, /reviewer-ops/policy, /security.
 *
 * What CR1 explicitly did NOT touch (documented deferrals):
 *   - identity/page.tsx + review/operations/page.tsx
 *     (~600 LoC operational consoles; folding is a UX-level decision
 *     deferred to CR2).
 *   - services/api-keys.service.ts (root, in-memory) — deferral
 *     CLOSED by Phase Final-A3 (2026-05). The legacy file is now
 *     deleted and the 5 enterprise.routes.ts handlers return
 *     HTTP 410 Gone with a pointer to the canonical Phase 17
 *     surface at `/v1/integrations/api-keys`. See the A-3 pin at
 *     the bottom of this file.
 *
 * If a regression PR re-introduces any deleted surface, the matching
 * pin below FAILS — that's the forcing function.
 *
 * Full CR1 report: docs/recovery/CR1_LEGACY_PURGE.md
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function apiPath(rel: string): string {
  return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}
function webPath(rel: string): string {
  return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}
function readApi(rel: string): string {
  return readFileSync(apiPath(rel), "utf8");
}
function readWeb(rel: string): string {
  return readFileSync(webPath(rel), "utf8");
}

// =============================================================================
// PART 1 — Phase A: legacy audit.routes.ts purged
// =============================================================================

describe("CR1 Phase A — legacy audit.routes.ts purged", () => {
  it("services/api/src/routes/audit.routes.ts no longer exists", () => {
    expect(existsSync(apiPath("src/routes/audit.routes.ts"))).toBe(false);
  });

  it("server.ts has no import or registration of the legacy auditRoutes shim", () => {
    const server = readApi("src/server.ts");
    expect(server).not.toMatch(/from\s+["']\.\/routes\/audit\.routes\.js["']/);
    // The canonical admin audit route remains under a different name
    // (`adminAuditRoutes` → `routes/admin-audit.routes.ts`). The
    // negative we want is the bare legacy export.
    expect(server).not.toMatch(/\bauditRoutes\b/);
  });
});

// =============================================================================
// PART 2 — Phase B: legacy webhook.routes.ts purged
// =============================================================================

describe("CR1 Phase B — legacy webhook.routes.ts purged", () => {
  it("services/api/src/routes/webhook.routes.ts no longer exists", () => {
    expect(existsSync(apiPath("src/routes/webhook.routes.ts"))).toBe(false);
  });

  it("server.ts has no import or registration of webhookRoutes", () => {
    const server = readApi("src/server.ts");
    // Code-context matching only — explanatory deletion comments are
    // allowed to mention the symbol by name.
    expect(server).not.toMatch(/^import[^\n]*\bwebhookRoutes\b/m);
    expect(server).not.toMatch(/\bapp\.register\(webhookRoutes\)/);
    expect(server).not.toMatch(/from\s+["'][^"']*\/webhook\.routes\.js["']/);
  });
});

// =============================================================================
// PART 3 — Phase D: auditMiddleware + tombstone purged
// =============================================================================

describe("CR1 Phase D — auditMiddleware hook + audit.service.ts tombstone purged", () => {
  it("middleware/audit.middleware.ts no longer exists", () => {
    expect(existsSync(apiPath("src/middleware/audit.middleware.ts"))).toBe(
      false,
    );
  });

  it("services/audit.service.ts (in-memory tombstone) no longer exists", () => {
    expect(existsSync(apiPath("src/services/audit.service.ts"))).toBe(false);
  });

  it("server.ts has no import or onRequest hook for auditMiddleware", () => {
    const server = readApi("src/server.ts");
    // Code-context matching only — explanatory deletion comments are
    // allowed to mention the symbol by name.
    expect(server).not.toMatch(/^import[^\n]*\bauditMiddleware\b/m);
    expect(server).not.toMatch(/\bapp\.addHook\([^)]*\bauditMiddleware\b/);
    expect(server).not.toMatch(/from\s+["'][^"']*\/audit\.middleware\.js["']/);
  });

  it("canonical audit writer (platform-audit-log.service.ts) is still in place", () => {
    expect(
      existsSync(apiPath("src/services/platform-audit-log.service.ts")),
    ).toBe(true);
  });
});

// =============================================================================
// PART 4 — Phase E: legacy webhook.service.ts purged
// =============================================================================

describe("CR1 Phase E — legacy webhook.service.ts orphan purged", () => {
  it("services/webhook.service.ts (in-memory orphan) no longer exists", () => {
    expect(existsSync(apiPath("src/services/webhook.service.ts"))).toBe(false);
  });

  it("enterprise.routes.ts no longer imports the legacy getWebhookService", () => {
    const enterprise = readApi("src/routes/enterprise.routes.ts");
    // Code-context matching only — explanatory deletion comments are
    // allowed to mention the symbol by name.
    expect(enterprise).not.toMatch(/^import[^\n]*\bgetWebhookService\b/m);
    expect(enterprise).not.toMatch(/\bgetWebhookService\s*\(/);
    expect(enterprise).not.toMatch(
      /from\s+["'][^"']*\/webhook\.service\.js["']/,
    );
  });

  it("canonical webhook subsystem (integrations) is still in place", () => {
    expect(
      existsSync(apiPath("src/services/integrations/webhooks.service.ts")),
    ).toBe(true);
    expect(
      existsSync(apiPath("src/services/integrations/webhook-dispatcher.ts")),
    ).toBe(true);
  });
});

// =============================================================================
// PART 5 — Phase F: opsSeedRoutes env-guarded
// =============================================================================

describe("CR1 Phase F — opsSeedRoutes registration env-guarded", () => {
  it("server.ts wraps app.register(opsSeedRoutes) in OPERATIONAL_SEEDING_ENABLED guard", () => {
    const server = readApi("src/server.ts");
    // The registration must be inside an `if` checking the env flag.
    // We match an `if (process.env.OPERATIONAL_SEEDING_ENABLED ...)`
    // block that contains the registration call within a small window.
    expect(server).toMatch(
      /if\s*\(\s*process\.env\.OPERATIONAL_SEEDING_ENABLED\s*===\s*["']true["']\s*\)\s*\{[\s\S]{0,200}app\.register\(opsSeedRoutes\)/,
    );
  });

  it("the unconditional bare registration of opsSeedRoutes is gone", () => {
    const server = readApi("src/server.ts");
    // Find every `app.register(opsSeedRoutes)` occurrence and assert
    // none of them is at indent level 2 (i.e. unguarded top-level).
    const lines = server.split("\n");
    const offenders: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (/app\.register\(opsSeedRoutes\)/.test(line)) {
        // Expect either inside a deeper-indent block (`    `) or
        // immediately preceded by an `if (process.env...)` line above.
        const indent = line.match(/^(\s*)/)?.[1] ?? "";
        if (indent.length <= 2) offenders.push(`line ${i + 1}: ${line}`);
      }
    }
    expect(
      offenders,
      `unguarded opsSeedRoutes registration found: ${offenders.join("; ")}`,
    ).toEqual([]);
  });
});

// =============================================================================
// PART 6 — Part 2: 8 redirect pages purged + next.config.js redirects exist
// =============================================================================

describe("CR1 Part 2 — 8 backward-compat redirect pages folded into next.config.js", () => {
  // Phase G0 (B.1) — `/review` is no longer a redirect target.
  // Phase C0 re-installed the canonical Reviewer Console at the
  // same path; the CR1 purge of `app/(app)/review/page.tsx` is
  // superseded.
  const DELETED_REDIRECT_PAGES = [
    "app/(app)/dashboard/page.tsx",
    "app/(app)/archive/page.tsx",
    "app/(app)/deleted/page.tsx",
    "app/(app)/locked/page.tsx",
    // Phase 3 consolidation: /operations is now the CANONICAL page
    // (the /ops -> /operations move); it is no longer a deleted
    // redirect stub, so it is intentionally absent from this list.
    "app/(app)/reviewer-ops/policy/page.tsx",
    "app/(app)/security/page.tsx",
  ];

  for (const rel of DELETED_REDIRECT_PAGES) {
    it(`${rel} no longer exists`, () => {
      expect(existsSync(webPath(rel))).toBe(false);
    });
  }

  it("next.config.js declares a redirects() block with all canonical entries", () => {
    const cfg = readWeb("next.config.js");
    expect(cfg).toMatch(/async\s+redirects\s*\(/);
    // Phase G0 (B.1) — the `/review → /reviewer-ops` redirect is
    // explicitly retired (it was bypassing the Phase C0 canonical
    // Reviewer Console). The rest of the CR1 redirect table is
    // preserved.
    const expected: Array<[string, string]> = [
      ["/dashboard", "/home"],
      ["/archive", "/evidence?filter=archived"],
      ["/deleted", "/evidence?filter=deleted"],
      ["/locked", "/evidence?filter=locked"],
      ["/ops", "/operations"],
      ["/reviewer-ops/policy", "/governance/policy"],
      ["/security", "/security-center"],
    ];
    for (const [source, destination] of expected) {
      expect(
        cfg,
        `next.config.js must redirect ${source} → ${destination}`,
      ).toMatch(
        new RegExp(
          `source:\\s*["']${source.replace(/\//g, "\\/")}["'][\\s\\S]{0,200}destination:\\s*["']${destination.replace(/[/?=]/g, (m) => `\\${m}`)}["']`,
        ),
      );
    }
  });

  it("subroutes of consolidated paths still exist (next.config redirect is exact-match)", () => {
    // Phase 32.8B kept these working surfaces; the redirect on the
    // parent path must NOT have taken them out.
    //
    // Phase Final-A3-PT2 — `/dashboard/api-keys` was RETIRED (the
    // legacy in-memory key store was deleted; redirect now goes to
    // `/integrations`). The pin was moved to
    // `phase-final-d5-pt2-no-legacy-personal-security.test.ts`.
    //
    // Phase Final-Vocab-Alignment — `/reviewer-ops/page.tsx` (the
    // legacy index) was RETIRED; redirect goes to `/review`. Same
    // closure file holds the new pin.
    expect(
      existsSync(webPath("app/(app)/operations/batch-analysis/page.tsx")),
    ).toBe(true);
    expect(
      existsSync(webPath("app/(app)/admin/platform/reliability/page.tsx")),
    ).toBe(true);
    expect(existsSync(webPath("app/(app)/review/operations/page.tsx"))).toBe(
      true,
    );
    // `/reviewer-ops/[reviewId]` mutation inspector is preserved.
    expect(
      existsSync(webPath("app/(app)/reviewer-ops/[reviewId]")),
    ).toBe(true);
  });
});

// =============================================================================
// PART 7 — Documented deferrals stay deferred (CR1 did NOT touch UX)
// =============================================================================

describe("CR1 — documented deferrals: legacy operator pages NOT folded by CR1", () => {
  // Phase Final-Closure-Remediation CLOSED the CR1 `/identity` page
  // deferral. The Phase 17 workspace-internal identity console was
  // deleted; the legacy URL now redirects to the canonical
  // `/admin/identity` enterprise operator control plane via
  // `apps/web/next.config.js` `redirects()` (permanent 308). The pin
  // below was previously: `expect(existsSync(...identity/page.tsx)).toBe(true)`
  // — that pin is now inverted to prevent a regression that would
  // bring the legacy console back.
  it("identity/page.tsx is REMOVED (closure: legacy console folded into /admin/identity)", () => {
    expect(existsSync(webPath("app/(app)/identity/page.tsx"))).toBe(false);
  });

  it("next.config.js redirects /identity → /admin/identity (preserves deep links)", () => {
    const cfg = readWeb("next.config.js");
    expect(cfg).toMatch(
      /source:\s*["']\/identity["'][\s\S]{0,200}destination:\s*["']\/admin\/identity["']/,
    );
  });

  it("review/operations/page.tsx is preserved (UX-level folding is CR2's call)", () => {
    expect(existsSync(webPath("app/(app)/review/operations/page.tsx"))).toBe(
      true,
    );
  });

  // CR1 deferral CLOSED by Phase Final-A3. The legacy
  // services/api-keys.service.ts has been deleted and the
  // enterprise.routes.ts `/v1/api-keys*` handlers now return
  // HTTP 410 Gone. The closure pins live in the dedicated
  // section below ("PART 8 — Phase Final-A3").
});

// =============================================================================
// PART 8 — Phase Final-A3: legacy api-keys.service.ts retired
// =============================================================================

describe("Phase Final-A3 — legacy api-keys.service.ts retired", () => {
  it("services/api-keys.service.ts no longer exists", () => {
    expect(existsSync(apiPath("src/services/api-keys.service.ts"))).toBe(false);
  });

  it("enterprise.routes.ts no longer imports the legacy apiKeyService", () => {
    const enterprise = readApi("src/routes/enterprise.routes.ts");
    // Code-context matching only — explanatory deletion / closure
    // comments are allowed to mention the symbol by name.
    expect(enterprise).not.toMatch(
      /^import[^\n]*\bapiKeyService\b/m,
    );
    expect(enterprise).not.toMatch(
      /from\s+["'][^"']*\/api-keys\.service\.js["']/,
    );
    // No invocation of the legacy service in code.
    expect(enterprise).not.toMatch(/\bapiKeyService\.(createKey|listKeys|revokeKey|rotateKey|updateRateLimit|validateKey)\b/);
  });

  it("the legacy /v1/api-keys surface returns HTTP 410 via the wildcard closure handler", () => {
    const enterprise = readApi("src/routes/enterprise.routes.ts");
    // The closure body and the 410 reply must be in place.
    expect(enterprise).toMatch(/API_KEYS_LEGACY_RETIRED/);
    expect(enterprise).toMatch(/reply\.code\(410\)/);
    expect(enterprise).toMatch(/emitLegacyEndpointAuditAndRespond/);
    // Phase Final-A3-PT2 — the 5 explicit handlers are now collapsed
    // into 2 wildcard registrations (`app.all("/v1/api-keys", ...)` +
    // `app.all("/v1/api-keys/*", ...)`). Both registrations are
    // required: Fastify's wildcard pattern does NOT match the bare
    // root path, so the root + subpath pair covers every request shape
    // that used to hit the 5 explicit handlers.
    expect(enterprise).toMatch(/app\.all\(\s*["']\/v1\/api-keys["']/);
    expect(enterprise).toMatch(/app\.all\(\s*["']\/v1\/api-keys\/\*["']/);
    // No leftover typed handlers (POST/GET/DELETE/POST rotate/PATCH).
    expect(enterprise).not.toMatch(/app\.(post|get|delete|patch)<[^>]*>\s*\(\s*["']\/v1\/api-keys/);
  });

  it("canonical Phase 17 surface (services/integrations/api-keys.service.ts) is still in place", () => {
    expect(
      existsSync(apiPath("src/services/integrations/api-keys.service.ts")),
    ).toBe(true);
  });

  it("enterprise.routes.ts quota counter reads from the canonical ApiCredential model (no in-memory key store)", () => {
    const enterprise = readApi("src/routes/enterprise.routes.ts");
    // Two call-sites: usage stats + quota. Both must read from
    // Prisma's `apiCredential` (canonical) — never from `apiKeyService`.
    const matches = enterprise.match(/prisma\.apiCredential\.count/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
