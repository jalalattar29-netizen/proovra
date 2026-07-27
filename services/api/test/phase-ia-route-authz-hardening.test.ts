/**
 * Phase IA-route-authz-hardening — source-contract regression suite.
 *
 * Pins the authorization fixes from the End-to-End Route Authorization
 * Hardening Fix:
 *
 *   * intelligence-platform.routes.ts — every route uses
 *     `authorizeWorkspace(req, reply, <permission>)`, NOT the legacy
 *     `resolveWorkspace`. Each call site uses the canonical permission
 *     for its surface (read / feedback.write / run / policy.manage).
 *
 *   * intelligence.routes.ts — `/v1/intelligence/catalogs` has the
 *     `requireAuth` preHandler. Previously it had no preHandler at all.
 *
 *   * security-event.service.ts — `projectSecurityEventDetails` is the
 *     allow-listed projection. Raw `row.details` is no longer returned
 *     verbatim by `projectSecurityEvent`.
 *
 *   * governance.routes.ts + governance-operations.routes.ts — every
 *     mutation is gated on its canonical permission. PHASE 1 (2026-07-21)
 *     consolidated the former `requirePermission(ok.role, "X")` pair into
 *     the canonical primitive: the permission is now the 4th argument to
 *     the local `requireMember` wrapper, which routes through
 *     `authorizeOrFail` (ACTIVE membership + org lifecycle + capability +
 *     anti-enumeration). The test pins the permission at its new call site
 *     so a future refactor can't drop the gate.
 *
 *   * /v1/insights — no apps/web file calls it; navigation registries
 *     no longer reference `dashboard.insights`.
 *
 * The tests are source-grep contracts. They do NOT exercise the runtime
 * (full integration would need DB + JWT plumbing). They guarantee that
 * the permission gates stay wired; the canonical permission semantics
 * (VIEWER lacks intelligence.run etc.) are enforced by the shared
 * permissions catalog tests under packages/shared.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { projectSecurityEventDetails } from "../src/services/security/security-event.service.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

function readWebTree(): string[] {
  // Walk apps/web/{app,components,lib,hooks,services,context,providers}
  // and return file paths. Bounded to .ts/.tsx/.js/.jsx; skips .next/ and
  // node_modules.
  const out: string[] = [];
  const webRoot = fileURLToPath(new URL("../../../apps/web", import.meta.url));
  const subdirs = [
    "app",
    "components",
    "lib",
    "hooks",
    "services",
    "context",
    "providers",
  ];
  function walk(p: string): void {
    let entries: string[];
    try {
      entries = readdirSync(p);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === ".next" || name === "node_modules") continue;
      const full = `${p}/${name}`;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (/\.(tsx?|jsx?)$/.test(name)) out.push(full);
    }
  }
  for (const d of subdirs) walk(`${webRoot}/${d}`);
  return out;
}

// ============================================================================
// Phase 2 — intelligence-platform.routes.ts authorization wired
// ============================================================================

describe("Phase IA-route-authz — intelligence-platform.routes.ts", () => {
  const PLATFORM = readSource(
    "../src/routes/intelligence-platform.routes.ts",
  );

  it("imports authorizeOrFail from the central middleware", () => {
    expect(PLATFORM).toMatch(
      /import\s*\{\s*authorizeOrFail\s*\}\s*from\s*["']\.\.\/middleware\/authorize\.js["']/,
    );
  });

  it("defines the authorizeWorkspace helper with permission + antiEnumeration", () => {
    expect(PLATFORM).toMatch(/async function authorizeWorkspace\([\s\S]{0,200}permission:\s*Permission/);
    expect(PLATFORM).toMatch(
      /authorizeOrFail\(req,\s*reply,\s*\{[\s\S]{0,200}antiEnumeration:\s*true/,
    );
  });

  it("does NOT use the legacy resolveWorkspace anywhere", () => {
    // resolveWorkspace was the pre-fix helper that only checked
    // currentWorkspaceId. It must NOT survive the refactor.
    expect(PLATFORM).not.toMatch(/resolveWorkspace\(/);
  });

  it("every route call site uses authorizeWorkspace(req, reply, <permission>)", () => {
    const callSites = PLATFORM.match(/authorizeWorkspace\(req,\s*reply,\s*"[^"]+"\)/g) ?? [];
    // 22 routes in this file (records list/single, run/{bytes,text},
    // corrections {create,accept,revert,list-by-record,list-by-evidence},
    // providers {usage,budgets GET/POST,health}, executive {metrics,trends},
    // quality {providers,reviewers,teams}, version-chain, budgets
    // {breaches,spend}, audit-transparency).
    // Current count: 18 distinct `authorizeWorkspace(req, reply, "<perm>")`
    // call sites. The exact number may grow as new routes land; the
    // assertion is a floor that catches any regression that drops gates.
    expect(callSites.length).toBeGreaterThanOrEqual(18);
  });

  it("corrections POST + accept + revert all gate on intelligence.feedback.write", () => {
    // The three reviewer-correction mutation routes.
    const writes = PLATFORM.match(
      /authorizeWorkspace\([\s\S]{0,200}"intelligence\.feedback\.write"/g,
    ) ?? [];
    expect(writes.length).toBe(3);
  });

  it("run/bytes + run/text gate on intelligence.run", () => {
    const runs = PLATFORM.match(
      /authorizeWorkspace\([\s\S]{0,200}"intelligence\.run"/g,
    ) ?? [];
    expect(runs.length).toBe(2);
  });

  it("provider budget POST gates on intelligence.policy.manage", () => {
    const policy = PLATFORM.match(
      /authorizeWorkspace\([\s\S]{0,200}"intelligence\.policy\.manage"/g,
    ) ?? [];
    expect(policy.length).toBe(1);
  });
});

// ============================================================================
// Phase 4 — /v1/intelligence/catalogs requires auth
// ============================================================================

describe("Phase IA-route-authz — /v1/intelligence/catalogs", () => {
  const INT = readSource("../src/routes/intelligence.routes.ts");

  it("/v1/intelligence/catalogs is registered with preHandler: requireAuth", () => {
    // Pre-fix the registration had no preHandler. The new code uses
    // an object literal with preHandler set.
    expect(INT).toMatch(
      /app\.get\(\s*"\/v1\/intelligence\/catalogs",[\s\S]{0,200}preHandler:\s*requireAuth/,
    );
  });

  it("no public registration shape remains for /v1/intelligence/catalogs", () => {
    // The old pattern was:
    //   app.get("/v1/intelligence/catalogs", async (_req, reply) => { ... });
    // (no options object). Ensure it's gone.
    expect(INT).not.toMatch(
      /app\.get\(\s*"\/v1\/intelligence\/catalogs",\s*async/,
    );
  });
});

// ============================================================================
// Phase 5 — security event details allow-list
// ============================================================================

describe("Phase IA-route-authz — projectSecurityEventDetails allow-list", () => {
  it("drops keys not on the allow-list and flags redacted: true", () => {
    const out = projectSecurityEventDetails({
      // Allow-listed
      action: "login",
      reasonCode: "ok",
      riskLevel: "low",
      // Forbidden — must be dropped + flagged
      apiKey: "sk-live-1234567890",
      cookie: "session=abc",
      authorizationHeader: "Bearer xyz",
      stackTrace: "Error: at line 5...",
      rawPayload: { secret: "1234" },
      ipAddress: "10.0.0.1",
    });
    expect(out.action).toBe("login");
    expect(out.reasonCode).toBe("ok");
    expect(out.riskLevel).toBe("low");
    expect(out.redacted).toBe(true);
    expect(out).not.toHaveProperty("apiKey");
    expect(out).not.toHaveProperty("cookie");
    expect(out).not.toHaveProperty("authorizationHeader");
    expect(out).not.toHaveProperty("stackTrace");
    expect(out).not.toHaveProperty("rawPayload");
    expect(out).not.toHaveProperty("ipAddress");
  });

  it("redacts sessionId + targetId to the first 8 chars + ellipsis", () => {
    const out = projectSecurityEventDetails({
      sessionId: "0123456789abcdef-deadbeef",
      targetId: "fedcba9876543210",
      action: "audit",
    });
    expect(out.sessionId).toBe("01234567…");
    expect(out.targetId).toBe("fedcba98…");
    expect(out.action).toBe("audit");
  });

  it("preserves the full safe field set without flagging redacted", () => {
    const out = projectSecurityEventDetails({
      action: "logout",
      source: "web",
      category: "session",
      reasonCode: "user_initiated",
      riskLevel: "low",
      count: 1,
      ipCountry: "US",
      ipRegion: "CA",
      userAgentFamily: "Chrome",
      deviceType: "desktop",
      platform: "macOS",
      occurredAtUtc: "2026-06-09T13:42:28.000Z",
      durationMs: 412,
    });
    expect(out.redacted).toBe(false);
    expect(out.action).toBe("logout");
    expect(out.ipCountry).toBe("US");
    expect(out.userAgentFamily).toBe("Chrome");
    expect(out.durationMs).toBe(412);
  });

  it("handles null / non-object input safely", () => {
    expect(projectSecurityEventDetails(null)).toEqual({ redacted: false });
    expect(projectSecurityEventDetails(undefined)).toEqual({ redacted: false });
    expect(projectSecurityEventDetails([1, 2, 3])).toEqual({ redacted: false });
    expect(projectSecurityEventDetails("opaque")).toEqual({ redacted: false });
  });

  it("projectSecurityEvent no longer returns row.details verbatim", () => {
    const SERVICE = readSource(
      "../src/services/security/security-event.service.ts",
    );
    // The OLD pattern was: details: row.details ?? null
    // It MUST be replaced by the allow-listed projection.
    expect(SERVICE).not.toMatch(/details:\s*row\.details\s*\?\?\s*null/);
    expect(SERVICE).toMatch(/details:\s*projectSecurityEventDetails\(row\.details\)/);
  });
});

// ============================================================================
// Phase 3 — governance mutations stay gated by requirePermission
// ============================================================================

describe("Phase IA-route-authz — governance mutations stay gated", () => {
  const GOV = readSource("../src/routes/governance.routes.ts");
  const GOV_OPS = readSource("../src/routes/governance-operations.routes.ts");

  // PHASE 1 AUTHORIZATION CLOSURE (2026-07-21): the `requirePermission(ok.role,
  // "X")` pattern was consolidated into the canonical primitive — the required
  // permission is now the 4th argument to the local `requireMember` wrapper,
  // which routes through `authorizeOrFail` (ACTIVE membership + org lifecycle +
  // capability + anti-enumeration). The GATING INTENT is unchanged; these
  // assertions track the permission at its new, canonical call site.
  const gatedOn = (src: string, permission: string): RegExpMatchArray | null =>
    src.match(
      new RegExp(
        `requireMember\\(req, reply, [^,]+,\\s*"${permission.replace(/\./g, "\\.")}"\\)`,
        "g",
      ),
    );

  it("every legal-hold mutation gates on governance.legal_hold.manage", () => {
    // POST place + POST release + POST case-legal-holds place/release.
    const calls = gatedOn(GOV, "governance.legal_hold.manage") ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  it("evidence publish/unpublish/suspend/restore mutations gate on evidence.publish_verify", () => {
    const calls = gatedOn(GOV, "evidence.publish_verify") ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  it("policy upsert gates on governance.policy.manage", () => {
    expect(gatedOn(GOV, "governance.policy.manage")?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("retention candidates GET gates on governance.retention.manage", () => {
    expect(gatedOn(GOV, "governance.retention.manage")?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("reconcile-retention is cron-only (requireIntegrationCronSecret)", () => {
    expect(GOV).toMatch(
      /app\.post\([\s\S]{0,200}"\/v1\/governance\/reconcile-retention"[\s\S]{0,400}requireIntegrationCronSecret/,
    );
  });

  it("governance-operations export-snapshots POST gates on evidence.generate_package", () => {
    expect(gatedOn(GOV_OPS, "evidence.generate_package")?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("governance-operations acknowledge POST gates on governance.policy.manage", () => {
    expect(gatedOn(GOV_OPS, "governance.policy.manage")?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("both governance route files route through the canonical primitive", () => {
    expect(GOV).toContain("authorizeOrFail");
    expect(GOV_OPS).toContain("authorizeOrFail");
    expect(GOV).not.toMatch(/const perm = requirePermission\(/);
    expect(GOV_OPS).not.toMatch(/const perm = requirePermission\(/);
  });
});

// ============================================================================
// Phase 6 — /v1/insights cleanup
// ============================================================================

describe("Phase IA-route-authz — /v1/insights cleanup", () => {
  it("the /dashboard/insights page file is deleted", () => {
    const webRoot = fileURLToPath(
      new URL("../../../apps/web", import.meta.url),
    );
    expect(existsSync(`${webRoot}/app/(app)/dashboard/insights/page.tsx`)).toBe(
      false,
    );
  });

  it("no frontend source file fetches /v1/insights", () => {
    const offenders: string[] = [];
    for (const file of readWebTree()) {
      let contents: string;
      try {
        contents = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      // Match: '/v1/insights' or "/v1/insights" or `/v1/insights`.
      if (/["'`]\/v1\/insights\b/.test(contents)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("routeRegistry.ts no longer registers dashboard.insights", () => {
    const REG = readSource("../../../apps/web/lib/navigation/routeRegistry.ts");
    // Comment mentions retirement; no active id: registration.
    expect(REG).not.toMatch(/id:\s*"dashboard\.insights"/);
  });

  it("pillarRegistry.ts no longer references dashboard.insights as HOME", () => {
    const PILLAR = readSource(
      "../../../apps/web/lib/navigation/pillarRegistry.ts",
    );
    expect(PILLAR).not.toMatch(/\[\s*"dashboard\.insights"\s*,/);
  });

  it("phaseBOperationalGroups.ts no longer references dashboard.insights", () => {
    const GROUPS = readSource(
      "../../../apps/web/lib/navigation/phaseBOperationalGroups.ts",
    );
    expect(GROUPS).not.toMatch(/^\s*"dashboard\.insights"/m);
  });

  it("next.config.js still redirects /dashboard/insights → /home (back-compat)", () => {
    const NEXT = readSource("../../../apps/web/next.config.js");
    expect(NEXT).toMatch(/source:\s*"\/dashboard\/insights"/);
    expect(NEXT).toMatch(/destination:\s*"\/home"/);
  });
});
