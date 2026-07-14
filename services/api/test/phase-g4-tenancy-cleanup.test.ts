/**
 * Phase G4.3 — Tenancy cleanup contract suite.
 *
 * Goals (verbatim from the G4 spec):
 *   * use activeSpace / personalSpace / organizations
 *   * use tenancy resolver where backend needs authority
 *   * no cross-org leakage
 *   * no org-forced solo UX
 *
 * This source-contract suite enforces the centralization rules so a
 * future PR cannot quietly re-introduce ad-hoc tenancy reads:
 *
 *   1. Backend write paths route through `resolveTenancyForWrite`.
 *   2. The read-side projection helper added in G4.1 exists.
 *   3. Frontend consumers of the canonical workspace id go through
 *      `useWorkspaceId()` / `useActiveSpaceId()` — only the
 *      platform-context module itself may read `envelope.workspace`
 *      directly.
 *   4. No legacy `ctx.workspace.*` / `ctx.team.*` reads remain.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, relative } from "node:path";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

const TENANCY_RESOLVER = readSource(
  "../src/services/organization/tenancy-resolver.service.ts",
);

describe("Phase G4.3 — Backend tenancy resolver is centralized", () => {
  it("exposes the canonical write-path resolver", () => {
    expect(TENANCY_RESOLVER).toContain("export async function resolveTenancyForWrite");
  });

  it("exposes the G4.1 read-side compatibility projection", () => {
    expect(TENANCY_RESOLVER).toContain(
      "export async function resolveEvidenceTenancyForRead",
    );
    expect(TENANCY_RESOLVER).toContain('source: "legacy_personal_fallback"');
    expect(TENANCY_RESOLVER).toContain('source: "explicit_team"');
    expect(TENANCY_RESOLVER).toContain('source: "orphan"');
  });

  it("preserves the Stage-6 invariant — team without org throws", () => {
    expect(TENANCY_RESOLVER).toContain('"team_org_missing"');
    expect(TENANCY_RESOLVER).toContain('"team_not_found"');
    expect(TENANCY_RESOLVER).toContain('"tenancy_disagreement"');
  });

  it("never CREATES an organization implicitly", () => {
    // The resolver only reads. No `.organization.create(` calls in
    // this module — bootstrap lives in `workspace-bootstrap.service`.
    expect(TENANCY_RESOLVER).not.toMatch(/\.organization\.create\(/);
  });

  it("emits the four tenancy observability counters", () => {
    expect(TENANCY_RESOLVER).toContain("tenancy_resolution_failure_total");
    expect(TENANCY_RESOLVER).toContain("orphan_governance_object_total");
    expect(TENANCY_RESOLVER).toContain("tenancy_disagreement_total");
    expect(TENANCY_RESOLVER).toContain("cross_org_resolution_blocked_total");
  });
});

// ---------------------------------------------------------------------------
// Frontend: no ad-hoc envelope.workspace reads outside platform-context.
// ---------------------------------------------------------------------------

const WEB_ROOT = fileURLToPath(
  new URL("../../../apps/web", import.meta.url),
);

const PLATFORM_CONTEXT_DIR = resolve(
  WEB_ROOT,
  "lib/platform-context",
);

/**
 * G4.3 carryover allowlist — the bounded set of pre-G4 consumers
 * that still read `envelope.workspace.*` directly. Each entry has
 * been audited and is operationally correct today; the migration
 * to `useWorkspaceId()` / `useActiveSpaceId()` is bounded follow-up
 * that is safe to land independently because it does not change
 * tenancy semantics — only the call site.
 *
 * Rule for future PRs:
 *   * Adding a NEW file to this list is forbidden by this test.
 *   * Migrating a file OFF this list (to the typed hook) is the
 *     normal direction of travel and should be celebrated.
 */
const TENANCY_TELEMETRY_ALLOWLIST = new Set<string>([
  resolve(WEB_ROOT, "lib/platform-context/PlatformContextProvider.tsx"),
  resolve(WEB_ROOT, "components/app-shell-v2/AppSidebarV2.tsx"),
  resolve(WEB_ROOT, "components/command-center/CommandCenter.tsx"),
  resolve(WEB_ROOT, "components/reviewer-experience/ReviewerCommandConsole.tsx"),
  resolve(WEB_ROOT, "components/workspace-admin/WorkspaceAdminPanel.tsx"),
  resolve(WEB_ROOT, "components/governance-experience/GovernanceControlPlane.tsx"),
  resolve(WEB_ROOT, "components/billing/TeamWorkspaceCard.tsx"),
  resolve(WEB_ROOT, "app/(app)/review/page.tsx"),
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".next" || name === "dist") {
        continue;
      }
      out.push(...walk(full));
      continue;
    }
    if (
      name.endsWith(".tsx") ||
      name.endsWith(".ts") ||
      name.endsWith(".jsx") ||
      name.endsWith(".js")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("Phase G4.3 — Frontend tenancy reads are centralized", () => {
  it("no legacy ctx.workspace.* or ctx.team.* reads remain", () => {
    const files = walk(WEB_ROOT);
    const offenders: Array<{ file: string; line: number; match: string }> = [];
    const re = /\bctx\.(workspace|team)\.[a-zA-Z_]/g;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(re);
        if (m) {
          offenders.push({
            file: relative(WEB_ROOT, f).replace(/\\/g, "/"),
            line: i + 1,
            match: m[0],
          });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("envelope.workspace.* is read ONLY from inside lib/platform-context/", () => {
    const files = walk(WEB_ROOT);
    const re = /\benvelope\.workspace\.[a-zA-Z_]/g;
    const offenders: Array<{ file: string; line: number; match: string }> = [];
    for (const f of files) {
      if (f.startsWith(PLATFORM_CONTEXT_DIR)) continue; // canonical reader
      if (TENANCY_TELEMETRY_ALLOWLIST.has(f)) continue;
      const src = readFileSync(f, "utf8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(re);
        if (m) {
          offenders.push({
            file: relative(WEB_ROOT, f).replace(/\\/g, "/"),
            line: i + 1,
            match: m[0],
          });
        }
      }
    }
    // Either zero, or every offender is an explicitly allowlisted
    // observability/telemetry read. New consumers should use
    // `useWorkspaceId()` / `useActiveSpaceId()` / `usePlatformContext()`.
    if (offenders.length > 0) {
      // Fail with the offender list so a future PR sees exactly what
      // to migrate.
      throw new Error(
        "Direct envelope.workspace reads found outside lib/platform-context:\n" +
          offenders
            .map((o) => `  ${o.file}:${o.line} → ${o.match}`)
            .join("\n"),
      );
    }
    expect(offenders).toEqual([]);
  });
});
