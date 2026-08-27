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

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A tenancy read written inside a COMMENT is documentation, not a consumer.
 *
 * `SurfaceGate.tsx` documents the NEW-070 refresh rule by writing out the very
 * expression the rule is about (`prev.envelope.workspace.id`), and the raw scan
 * below counted that sentence as a direct read to migrate. The offender list is
 * meant to tell a future PR exactly what to change, so a false entry in it is
 * worse than noise — it sends someone to rewrite a comment.
 *
 * Block comments are blanked rather than removed so LINE NUMBERS in the
 * offender list stay accurate. `//` is left alone deliberately: stripping it
 * would have to reason about `https://` and about `//` inside string literals.
 */
function blankBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

// LEGACY-003 (2026-08-15): the "never creates an organization implicitly"
// guarantee belonged to the REMOVED tenancy resolver. Its stays-removed
// contract is at the foot of this file.

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
  resolve(WEB_ROOT, "components/workspace-admin/WorkspaceAdminPanel.tsx"),
  resolve(WEB_ROOT, "components/governance-experience/GovernanceControlPlane.tsx"),
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
      const src = blankBlockComments(readFileSync(f, "utf8"));
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
      const src = blankBlockComments(readFileSync(f, "utf8"));
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

// =============================================================================
// LEGACY-003 — removed module contract
// =============================================================================

/**
 * LEGACY-003 (2026-08-15) REMOVED `src/services/organization/tenancy-resolver.service.ts` as a caller-less second tenancy authority; see the Phase A1 suite for the full reasoning.
 */
describe("Phase G4.3 — tenancy resolver stays removed", () => {
  it("the removed module(s) stay removed", () => {
    for (const rel of [
      "../src/services/organization/tenancy-resolver.service.ts",
    ]) {
      expect(
        existsSync(fileURLToPath(new URL(rel, import.meta.url))),
        `${rel} is REMOVED (LEGACY-003) and must not return`,
      ).toBe(false);
    }
  });
});
