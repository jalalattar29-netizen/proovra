/**
 * Phase Final-D5-PT2 — contract test: legacy personal-security surface
 * is retired.
 *
 * The audit closure ledger marked D-5 CLOSED in the previous session
 * but left the OLD personal-security surface alive alongside the new
 * canonical one. This file pins the Phase Final-D5-PT2 closure:
 *
 *   - `/v1/users/me/sessions` (GET / DELETE) and
 *     `/v1/users/me/password/change` (POST) are wired to 410 Gone
 *     responders that emit a SecurityEvent on every attempt.
 *   - The frontend `AccountSecurityCard` is deleted; `/settings`
 *     points operators at `/security-center` (the canonical surface).
 *   - The 5 explicit `/v1/api-keys*` 410 handlers are collapsed into
 *     two `app.all(...)` wildcards.
 *   - The retired `/dashboard/api-keys` page + registry entry are
 *     gone; `next.config.js` redirects to `/integrations`.
 *   - The legacy `/reviewer-ops` index page is gone;
 *     `next.config.js` redirects to `/review`.
 *   - 7 confirmed dead frontend / backend files no longer exist.
 *
 * Regression of any pin here = the closure is broken.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}
function apiPath(rel: string): string {
  return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}
function readApi(rel: string): string {
  return readFileSync(apiPath(rel), "utf8");
}
function readRepo(rel: string): string {
  return readFileSync(repoPath(rel), "utf8");
}

// ============================================================================
// Backend — legacy personal-security endpoints return HTTP 410
// ============================================================================

describe("Phase Final-D5-PT2 — legacy /v1/users/me personal-security endpoints retired", () => {
  it("users.routes.ts no longer contains the legacy password / session handler bodies", () => {
    const file = readApi("src/routes/users.routes.ts");
    // The closure-handler constant + a 410 reply must be present.
    expect(file).toMatch(/PERSONAL_SECURITY_LEGACY_RETIRED/);
    expect(file).toMatch(/reply\.code\(410\)/);
    expect(file).toMatch(/emitPersonalSecurityLegacyEvent/);
    // The original handlers wrote SQL via prisma and called the
    // password-hash helpers. Those code paths MUST be gone.
    expect(file).not.toMatch(/prisma\.authenticatedSession\.findMany/);
    expect(file).not.toMatch(/prisma\.user\.update\(\s*\{[\s\S]{0,200}passwordHash/);
    expect(file).not.toMatch(/\bhashPassword\s*\(/);
    expect(file).not.toMatch(/\bverifyPassword\s*\(/);
    expect(file).not.toMatch(/\brevokeActiveSession\s*\(/);
  });

  it("users.routes.ts still registers the legacy paths (so callers get a deliberate 410 + audit)", () => {
    const file = readApi("src/routes/users.routes.ts");
    expect(file).toMatch(/"\/v1\/users\/me\/sessions"/);
    expect(file).toMatch(/"\/v1\/users\/me\/sessions\/:id"/);
    expect(file).toMatch(/"\/v1\/users\/me\/password\/change"/);
  });

  it("the canonical identity-security surface still ships", () => {
    const file = readApi("src/routes/identity-security.routes.ts");
    expect(file).toMatch(/"\/v1\/identity-security\/password"/);
    expect(file).toMatch(/"\/v1\/identity-security\/my-sessions"/);
    expect(file).toMatch(/"\/v1\/identity-security\/my-sessions\/revoke-others"/);
    expect(file).toMatch(/"\/v1\/identity-security\/security-events"/);
  });
});

// ============================================================================
// Frontend — AccountSecurityCard gone; legacy endpoints not called
// ============================================================================

describe("Phase Final-D5-PT2 — AccountSecurityCard deleted, /settings links to /security-center", () => {
  it("AccountSecurityCard.tsx no longer exists", () => {
    const file = fileURLToPath(
      new URL(
        "../../../apps/web/app/(app)/settings/components/AccountSecurityCard.tsx",
        import.meta.url,
      ),
    );
    expect(existsSync(file)).toBe(false);
  });

  it("/settings page.tsx no longer imports AccountSecurityCard and renders a Security Center link card", () => {
    const file = readRepo("apps/web/app/(app)/settings/page.tsx");
    expect(file).not.toMatch(
      /^import[^\n]*\bAccountSecurityCard\b/m,
    );
    expect(file).not.toMatch(/<AccountSecurityCard/);
    // The replacement gated Security Center link survives the 2026-07-17
    // IA refactor as the sentence under the unified Security section.
    expect(file).toMatch(/data-cc-security-link-card/);
    expect(file).toMatch(/\/security-center/);
    expect(file).toMatch(/Identity &amp; Security/);
  });

  it("no apps/web source file calls the retired /v1/users/me legacy endpoints", () => {
    // Walk apps/web for raw string occurrences of the retired paths.
    const targets = [
      "/v1/users/me/password/change",
      "/v1/users/me/sessions",
    ];
    const root = fileURLToPath(new URL("../../../apps/web", import.meta.url));
    const offenders: string[] = [];

    const exts = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
    const skipDirs = new Set([
      "node_modules",
      ".next",
      "dist",
      "out",
      "coverage",
    ]);

    function walk(dir: string) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const path = require("node:path") as typeof import("node:path");
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (skipDirs.has(name)) continue;
        const full = path.join(dir, name);
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          walk(full);
          continue;
        }
        const dot = name.lastIndexOf(".");
        if (dot < 0 || !exts.has(name.slice(dot))) continue;
        let content: string;
        try {
          content = fs.readFileSync(full, "utf8");
        } catch {
          continue;
        }
        for (const t of targets) {
          // Skip comment-only mentions: a line where the first
          // non-whitespace chars are `//` / `*` / `/*` is treated as
          // a doc comment.
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i] ?? "";
            const trimmed = line.trimStart();
            if (
              trimmed.startsWith("//") ||
              trimmed.startsWith("*") ||
              trimmed.startsWith("/*")
            ) {
              continue;
            }
            if (line.includes(t)) {
              offenders.push(`${full}:${i + 1} contains ${t}`);
            }
          }
        }
      }
    }

    walk(root);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

// ============================================================================
// Routing — /dashboard/api-keys retired; /reviewer-ops index gone
// ============================================================================

describe("Phase Final-A3-PT2 — /dashboard/api-keys retired", () => {
  it("the page file no longer exists", () => {
    const file = fileURLToPath(
      new URL(
        "../../../apps/web/app/(app)/dashboard/api-keys/page.tsx",
        import.meta.url,
      ),
    );
    expect(existsSync(file)).toBe(false);
  });

  it("the routeRegistry no longer surfaces dashboard.api_keys", () => {
    const registry = readRepo("apps/web/lib/navigation/routeRegistry.ts");
    expect(registry).not.toMatch(/id:\s*"dashboard\.api_keys"/);
    expect(registry).not.toMatch(/href:\s*"\/dashboard\/api-keys"/);
  });

  it("next.config.js redirects /dashboard/api-keys → /integrations", () => {
    const cfg = readRepo("apps/web/next.config.js");
    expect(cfg).toMatch(
      /source:\s*["']\/dashboard\/api-keys["'][\s\S]{0,150}destination:\s*["']\/integrations["']/,
    );
  });
});

describe("Phase Final-Vocab-Alignment — /reviewer-ops index retired", () => {
  it("the legacy index page is gone", () => {
    const file = fileURLToPath(
      new URL(
        "../../../apps/web/app/(app)/reviewer-ops/page.tsx",
        import.meta.url,
      ),
    );
    expect(existsSync(file)).toBe(false);
  });

  it("/review/[reviewId] inspector page is preserved (canonical mutation surface)", () => {
    const dir = fileURLToPath(
      new URL(
        "../../../apps/web/app/(app)/reviewer-ops/[reviewId]",
        import.meta.url,
      ),
    );
    expect(existsSync(dir)).toBe(true);
  });

  it("next.config.js redirects /reviewer-ops → /review", () => {
    const cfg = readRepo("apps/web/next.config.js");
    expect(cfg).toMatch(
      /source:\s*["']\/reviewer-ops["'][\s\S]{0,150}destination:\s*["']\/review["']/,
    );
  });
});

// ============================================================================
// Dead-code purge — 7 files confirmed absent
// ============================================================================

describe("Phase Final-Dead-Code — 7 dead frontend/backend files removed", () => {
  const DEAD_FILES = [
    "apps/web/components/app-shell.tsx",
    "apps/web/components/AppFooter.tsx",
    "apps/web/components/EvidenceViewer.tsx",
    "apps/web/components/LegalGate.tsx",
    "apps/web/components/analytics-tracker.tsx",
    "apps/web/components/cases-experience/CaseWorkspace.tsx",
    "services/api/src/services/ai.service.ts",
  ];

  for (const rel of DEAD_FILES) {
    it(`${rel} no longer exists`, () => {
      const f = fileURLToPath(
        new URL(`../../../${rel}`, import.meta.url),
      );
      expect(existsSync(f)).toBe(false);
    });
  }
});

// ============================================================================
// Middleware APP_PREFIXES brought in line with live route tree
// ============================================================================

describe("Phase Final-Vocab-Alignment — middleware APP_PREFIXES coverage", () => {
  it("middleware.ts APP_PREFIXES lists every live (app)-tree prefix", () => {
    // Phase Final-Closure-Remediation — `/identity` was removed from
    // APP_PREFIXES because the route was deleted from the live (app)
    // tree (folded into `/admin/identity` via next.config.js redirect).
    // Hitting www.proovra.com/identity should 404 cleanly rather than
    // bouncing through the app host first.
    const m = readRepo("apps/web/middleware.ts");
    const required = [
      "/home",
      "/capture",
      "/cases",
      "/teams",
      "/reports",
      "/billing",
      "/settings",
      "/admin",
      "/ops",
      "/operations",
      "/review",
      "/reviewer-ops",
      "/governance",
      "/integrations",
      "/intelligence",
      "/investigation",
      "/security-center",
      "/intake-links",
      "/search",
      "/communications",
      "/collaboration",
      "/notifications",
      "/inbox",
      "/organizations",
      "/workflows",
      "/evidence",
      "/evidence-requests",
      "/workspaces",
      "/tools",
      "/persona",
      "/dashboard",
    ];
    for (const p of required) {
      expect(m, `APP_PREFIXES must include ${p}`).toMatch(
        new RegExp(`["']${p.replace(/\//g, "\\/")}["']`),
      );
    }
  });

  it("middleware.ts APP_PREFIXES does NOT include the retired /identity prefix", () => {
    // Phase Final-Closure-Remediation — the `/identity` legacy console
    // was deleted; the URL is now a `next.config.js` redirect to
    // `/admin/identity`. Removing it from APP_PREFIXES ensures the
    // www-host hit 404s cleanly instead of routing through the app
    // host.
    const m = readRepo("apps/web/middleware.ts");
    expect(m).not.toMatch(/^\s*"\/identity",\s*$/m);
  });
});
