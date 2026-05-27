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
 *   - services/api-keys.service.ts (root, in-memory) — has live
 *     consumers via enterprise.routes.ts that feed dashboard/api-keys
 *     and dashboard/batch-analysis. Deletion requires migration which
 *     CR1 forbids. Deferred to R8 / R9.
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
    "app/(app)/operations/page.tsx",
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
      ["/operations", "/ops"],
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
    expect(existsSync(webPath("app/(app)/dashboard/api-keys/page.tsx"))).toBe(
      true,
    );
    expect(
      existsSync(webPath("app/(app)/dashboard/batch-analysis/page.tsx")),
    ).toBe(true);
    expect(
      existsSync(webPath("app/(app)/operations/reliability/page.tsx")),
    ).toBe(true);
    expect(existsSync(webPath("app/(app)/review/operations/page.tsx"))).toBe(
      true,
    );
    expect(existsSync(webPath("app/(app)/reviewer-ops/page.tsx"))).toBe(true);
  });
});

// =============================================================================
// PART 7 — Documented deferrals stay deferred (CR1 did NOT touch UX)
// =============================================================================

describe("CR1 — documented deferrals: legacy operator pages NOT folded by CR1", () => {
  it("identity/page.tsx is preserved (UX-level folding is CR2's call)", () => {
    expect(existsSync(webPath("app/(app)/identity/page.tsx"))).toBe(true);
  });

  it("review/operations/page.tsx is preserved (UX-level folding is CR2's call)", () => {
    expect(existsSync(webPath("app/(app)/review/operations/page.tsx"))).toBe(
      true,
    );
  });

  it("services/api-keys.service.ts deletion is deferred — file remains because enterprise.routes.ts still consumes it", () => {
    // This is an HONEST PIN: the file is in-memory and dead long-term,
    // but it has a live consumer chain (enterprise.routes.ts →
    // dashboard/api-keys page). Removing it requires migration which
    // CR1 forbids. The pin asserts that no one quietly deleted it
    // without first migrating the consumer (which would 500 the page).
    expect(existsSync(apiPath("src/services/api-keys.service.ts"))).toBe(true);
    const enterprise = readApi("src/routes/enterprise.routes.ts");
    expect(enterprise).toMatch(/apiKeyService/);
  });
});
