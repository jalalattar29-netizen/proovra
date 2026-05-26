/**
 * PHASE R1 — Product State Recovery acceptance tests.
 *
 * R1 fixed two root-cause product-state bugs diagnosed in CR1.5:
 *
 *   Bug A — CommandCenter (`apps/web/components/command-center/
 *     CommandCenter.tsx`) used `useTeamWorkspaceGate()` which returns
 *     `no-workspace` for Personal Space users. The dashboard then
 *     rendered "No workspace selected" while the topbar correctly
 *     showed "Personal Space" — same envelope, two state-source
 *     readers, different conclusions. R1 migrated CommandCenter to
 *     `useActiveSpace()` + `usePlatformContext()` and removed the
 *     legacy early-return.
 *
 *   Bug B — Persona save (`apps/web/app/(app)/settings/persona/
 *     page.tsx`) PATCHed `/v1/workspaces/:teamId/persona` and then
 *     only flipped `setSaved(true)`. The envelope stayed stale until
 *     manual reload. R1 calls `usePlatformContext().refresh()` after
 *     PATCH succeeds; sidebar/dashboard/density/persona-banner all
 *     re-render automatically.
 *
 * This file is the R1 acceptance pin. The matching CR1.5 inverse pins
 * (tests 9, 10, 11) were flipped in the same R1 PR.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function webPath(rel: string): string {
  return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}
function readWeb(rel: string): string {
  return readFileSync(webPath(rel), "utf8");
}

const CC = readWeb("components/command-center/CommandCenter.tsx");
const PERSONA = readWeb("app/(app)/settings/persona/page.tsx");
const PROVIDER = readWeb("lib/platform-context/PlatformContextProvider.tsx");
const SETTINGS = readWeb("app/(app)/settings/page.tsx");
const RUNTIME_INDICATOR = readWeb(
  "components/operational/GlobalRuntimeIndicator.tsx",
);

// =============================================================================
// PART 1 — CommandCenter active-space fix
// =============================================================================

describe("R1 Part 1 — CommandCenter consumes canonical active-space", () => {
  it("imports useActiveSpace + usePlatformContext (canonical readers)", () => {
    expect(CC).toMatch(/\buseActiveSpace\b/);
    expect(CC).toMatch(/\busePlatformContext\b/);
  });

  it("no longer imports or calls useTeamWorkspaceGate", () => {
    expect(CC).not.toMatch(/\buseTeamWorkspaceGate\b/);
  });

  it("does not early-return to 'No workspace selected' for personal users", () => {
    // The legacy early-return was driven by `workspace.status ===
    // "no-workspace"`. The status field was the tell. After R1 the
    // load-state still includes `no_workspace`, but it is only
    // reached when the canonical activeSpace is genuinely null —
    // never for personal users (the provider bootstraps Personal
    // Space).
    expect(CC).not.toMatch(/workspace\.status\s*===\s*["']no-workspace["']/);
  });

  it("dashboard fetch is keyed by the canonical active-space id (personal OR org)", () => {
    // The fetch URL must reference activeSpace.id (or, post-R8.1A
    // Part G, the narrowed const `activeSpaceId`), not
    // workspace.workspaceId. The intent — fetch keyed by the
    // canonical active-space id — is the same; R8.1A only added a
    // null-narrowing local.
    expect(CC).toMatch(
      /\/v1\/dashboard\/command-center\?teamId=\$\{encodeURIComponent\((?:activeSpace\.id|activeSpaceId)\)\}/,
    );
  });

  it("provider FAILED state still maps to the existing auth/permission/unavailable branches", () => {
    // R1 preserves the auth_error + unavailable handling — only the
    // workspace gate changed.
    expect(CC).toMatch(/AUTH_REQUIRED/);
    expect(CC).toMatch(/PERMISSION_DENIED/);
    expect(CC).toMatch(/WORKSPACE_MEMBERSHIP_REQUIRED/);
  });
});

// =============================================================================
// PART 2 — Persona save refresh
// =============================================================================

describe("R1 Part 2 — persona save refreshes the canonical envelope", () => {
  it("settings/persona/page.tsx imports usePlatformContext", () => {
    expect(PERSONA).toMatch(/\busePlatformContext\b/);
  });

  it("PATCH handler calls ctx.refresh() after successful save", () => {
    expect(PERSONA).toMatch(/ctx\.refresh\s*\(/);
    // Refresh must happen INSIDE the persistProfile body, between
    // the PATCH success and `setSaved(true)`. We anchor by checking
    // that the refresh call appears before `setSaved(true)` in the
    // same source.
    const refreshIdx = PERSONA.search(/ctx\.refresh\s*\(/);
    const setSavedIdx = PERSONA.search(/setSaved\s*\(\s*true\s*\)/);
    expect(refreshIdx, "ctx.refresh() must be present").toBeGreaterThan(-1);
    expect(setSavedIdx, "setSaved(true) must be present").toBeGreaterThan(-1);
    expect(refreshIdx).toBeLessThan(setSavedIdx);
  });

  it("the stale 'Reload to see' copy is removed", () => {
    expect(PERSONA).not.toMatch(/Reload to see/i);
  });

  it("the new success copy says navigation/recommendations have been refreshed", () => {
    expect(PERSONA).toMatch(/Workspace profile updated/);
    expect(PERSONA).toMatch(/refreshed/i);
  });
});

// =============================================================================
// PART 3 — No red "Unknown" state in primary shell
// =============================================================================

describe("R1 Part 3 — primary-shell 'Unknown' fallbacks softened", () => {
  it("GlobalRuntimeIndicator UNKNOWN label is neutral, not alarming", () => {
    // The label `"Unknown"` reads as a red error indicator in a
    // primary-shell badge; the actual semantics are "no recent
    // telemetry." Neutral copy preserves the operational state
    // without false alarm.
    expect(RUNTIME_INDICATOR).not.toMatch(/UNKNOWN:\s*["']Unknown["']/);
    expect(RUNTIME_INDICATOR).toMatch(/UNKNOWN:\s*["']Status pending["']/);
  });

  it("CommandCenter NoWorkspaceState uses neutral setup-incomplete copy", () => {
    // After R1's gate fix, NoWorkspaceState should rarely render
    // (provider bootstraps Personal Space). When it does, it must
    // not read as a hard failure.
    expect(CC).not.toMatch(/<h1[^>]*>No workspace selected<\/h1>/);
    expect(CC).toMatch(/Workspace setup incomplete/);
  });
});

// =============================================================================
// PART 4 — Envelope-drift cleanup: settings PATCH pairs with refresh
// =============================================================================

describe("R1 Part 4 — settings profile PATCH paired with envelope refresh", () => {
  it("settings/page.tsx imports usePlatformContext", () => {
    expect(SETTINGS).toMatch(/\busePlatformContext\b/);
  });

  it("the /v1/users/me PATCH handler calls platformCtx.refresh() after success", () => {
    // The handler must call refresh AFTER the local AuthContext is
    // updated (so the optimistic UI sees the change immediately) but
    // BEFORE the success toast fires. We anchor by string order.
    const patchIdx = SETTINGS.search(/apiFetch\(["']\/v1\/users\/me["']/);
    const refreshIdx = SETTINGS.search(/platformCtx\.refresh\s*\(/);
    const toastIdx = SETTINGS.search(/addToast\(["']Profile updated["']/);
    expect(patchIdx).toBeGreaterThan(-1);
    expect(refreshIdx).toBeGreaterThan(patchIdx);
    expect(toastIdx).toBeGreaterThan(refreshIdx);
  });
});

// =============================================================================
// PART 5 — Observability wiring (R1 instrumented the dev-only utility)
// =============================================================================

describe("R1 Part 7 — observability utility wired into key transitions", () => {
  it("provider emits platform-envelope:loaded + :refreshed", () => {
    expect(PROVIDER).toMatch(/state-observability/);
    expect(PROVIDER).toMatch(/platform-envelope:loaded/);
    expect(PROVIDER).toMatch(/platform-envelope:refreshed/);
  });

  it("CommandCenter emits active-space:resolved + dashboard:resolved", () => {
    expect(CC).toMatch(/state-observability/);
    expect(CC).toMatch(/active-space:resolved/);
    expect(CC).toMatch(/dashboard:resolved/);
  });

  it("persona save emits persona-profile:saved (and :refresh-missing on failure)", () => {
    expect(PERSONA).toMatch(/state-observability/);
    expect(PERSONA).toMatch(/persona-profile:saved/);
    expect(PERSONA).toMatch(/persona-profile:refresh-missing/);
  });

  it("observability emits use the redactWorkspaceId helper (no full workspace ids in payload)", () => {
    expect(PROVIDER).toMatch(/redactWorkspaceId/);
    expect(CC).toMatch(/redactWorkspaceId/);
    expect(PERSONA).toMatch(/redactWorkspaceId/);
  });
});

// =============================================================================
// PART 6 — No regression: workflow/persona still presentation-only,
// capabilities still authoritative
// =============================================================================

describe("R1 Part 6 — no workflow/persona authorization regression", () => {
  it("workflowExposureResolver still documents the no-authorization contract", () => {
    const src = readWeb("lib/navigation/workflowExposureResolver.ts");
    expect(src).toMatch(/Workflow NEVER changes/i);
    expect(src).not.toMatch(/\bauthorize\b/i);
  });

  it("R1 did NOT introduce workflow-gated capability checks in CommandCenter", () => {
    // The CommandCenter still uses `ctx.can(...)` (capability) for
    // mutation visibility and `envelope.flags.isTeamWorkspace` for
    // team-only sections. It must NOT gate on persona/workflow.
    expect(CC).not.toMatch(/persona\s*===\s*["']/);
    // Workflow code is consumed for data-cc-workflow attribute and
    // section ordering — that is presentation only.
    expect(CC).toMatch(/data-cc-workflow=/);
  });
});

// =============================================================================
// PART 7 — No new /v1/users/me self-fetcher (Part 4 did not add one)
// =============================================================================

describe("R1 Part 7 — self-fetcher allow-list unchanged (no new drift)", () => {
  function listAllTsxFiles(dirAbs: string): string[] {
    const out: string[] = [];
    const stack: string[] = [dirAbs];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        const full = `${dir}/${name}`;
        try {
          const st = statSync(full);
          if (st.isFile() && /\.(ts|tsx)$/.test(name)) out.push(full);
          else if (st.isDirectory()) stack.push(full);
        } catch {
          /* ignore */
        }
      }
    }
    return out;
  }

  it("exactly the 2 documented self-fetchers remain (post-CR1.6 cleanup)", () => {
    // Mirrors the post-CR1.6 allow-list. Pinning it here in R1's own
    // suite catches any regression where a future fix accidentally
    // adds a new self-fetcher OR re-introduces the teams/[id] one
    // CR1.6 migrated off /v1/users/me.
    //
    // CR1.6 reduced the allow-list from 3 to 2:
    //   - providers.tsx              (bootstrap; retained intentionally)
    //   - settings/page.tsx          (PATCH mutation; not a stale-read)
    //   - teams/[id]/page.tsx        REMOVED — migrated to envelope.user.id
    const EXPECTED_FILES = new Set([
      "/app/providers.tsx",
      "/app/(app)/settings/page.tsx",
    ]);
    const root = webPath(".");
    const all = listAllTsxFiles(root);
    const found = new Set<string>();
    for (const file of all) {
      const src = readFileSync(file, "utf8");
      if (
        /\bapiFetch\(\s*["']\/v1\/users\/me["']/.test(src) ||
        /\bfetch\(\s*["']\/v1\/users\/me["']/.test(src)
      ) {
        const rel = file
          .replace(/\\/g, "/")
          .replace(/^.*\/apps\/web\/+/, "/");
        found.add(rel);
      }
    }
    expect([...found].sort()).toEqual([...EXPECTED_FILES].sort());
  });
});
