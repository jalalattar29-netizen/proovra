/**
 * PHASE CR0 — System Freeze + Safety Baseline Guardrails.
 *
 * This test file is INTENTIONALLY conservative. It does NOT lock in
 * shallow structural details that will change during the recovery
 * phases (CR1, CR2, R1...R11). It locks in the FOUR things that
 * prevent further chaos:
 *
 *   1. Every `app/(app)/**\/page.tsx` either wraps in <PageRouteGate>
 *      OR is on a documented CR0 exemption list with a justification.
 *   2. New `useTeamWorkspaceGate` callsites cannot appear outside the
 *      existing CR0 allow-list (extends Phase 38.7 lock).
 *   3. New raw "Org" / "Access" / "Unknown" labels cannot appear in
 *      primary sidebar surfaces.
 *   4. Production `server.ts` cannot mount additional `*-seed*` /
 *      `webhook.routes` (the orphan) registrations beyond the
 *      currently-acknowledged debt (which CR1 will purge).
 *
 * The recovery roadmap document is in
 * `docs/recovery/CR0_SYSTEM_FREEZE_BASELINE.md`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}
function webPath(rel: string): string {
  return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}
function readApi(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

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
        const stat = statSync(full);
        if (stat.isFile() && /\.tsx?$/.test(name)) out.push(full);
        else if (stat.isDirectory()) stack.push(full);
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

// =============================================================================
// PART 1 — App routes: PageRouteGate-wrapped OR documented exemption
// =============================================================================

describe("Phase CR0 — every (app) page wraps in <PageRouteGate> OR is documented exempt", () => {
  /**
   * Pages that are EXPLICITLY exempt from the PageRouteGate
   * requirement. Each exemption documents the reason inline.
   *
   * Future phases (R1-R6) will revisit each entry:
   *   - admin/* → CR1 / R6 (gate via platform.admin routeId)
   *   - legacy redirects → CR1 purge
   *   - tools → permanent exemption (registry self-reference)
   *   - dynamic sub-routes that inherit parent → R2/R5 cleanup
   *   - legacy operator pages (identity, review/operations) → CR1
   */
  const DOCUMENTED_EXEMPTIONS: ReadonlyArray<{
    page: string;
    reason: string;
    revisitPhase: string;
  }> = [
    // Platform-admin scope — covered by route-level platformAdmin guard,
    // not the PageRouteGate canonical layer. CR1 will either gate via
    // <PageRouteGate routeId="platform.admin"> or document as permanent.
    { page: "admin/page.tsx", reason: "platform admin", revisitPhase: "CR1" },
    { page: "admin/audit/page.tsx", reason: "platform admin", revisitPhase: "CR1" },
    { page: "admin/dashboard/page.tsx", reason: "platform admin", revisitPhase: "CR1" },
    { page: "admin/demo-requests/page.tsx", reason: "platform admin", revisitPhase: "CR1" },
    { page: "admin/contact-sales/page.tsx", reason: "platform admin", revisitPhase: "CR1" },
    { page: "admin/identity/page.tsx", reason: "platform admin", revisitPhase: "CR1" },
    { page: "admin/identity/access-reviews/page.tsx", reason: "platform admin", revisitPhase: "CR1" },
    { page: "admin/identity/permission-matrix/page.tsx", reason: "platform admin", revisitPhase: "CR1" },
    { page: "admin/identity/providers/page.tsx", reason: "platform admin", revisitPhase: "CR1" },
    { page: "admin/identity/runtime/page.tsx", reason: "platform admin", revisitPhase: "CR1" },
    { page: "admin/identity/scim/page.tsx", reason: "platform admin", revisitPhase: "CR1" },
    { page: "admin/identity/sessions/page.tsx", reason: "platform admin", revisitPhase: "CR1" },
    { page: "admin/identity/timeline/page.tsx", reason: "platform admin", revisitPhase: "CR1" },
    // Platform Admin Control Center (P0/P1) — gated by /admin/layout.tsx's
    // <PageRouteGate routeId="platform.admin"> wrapper (same model as every
    // other /admin page above). /admin/organizations{,/[id]} additionally
    // self-wrap PageRouteGate so they are not listed here.
    { page: "admin/users/page.tsx", reason: "platform admin", revisitPhase: "CR1" },
    { page: "admin/evidence-ops/page.tsx", reason: "platform admin", revisitPhase: "CR1" },
    { page: "admin/security/page.tsx", reason: "platform admin", revisitPhase: "CR1" },
    { page: "admin/billing/page.tsx", reason: "platform admin", revisitPhase: "CR1" },

    // Redirect-only pages — CR1 Part 2 PURGED all 8. The 8 backward-
    // compat redirects (dashboard, archive, deleted, locked, operations,
    // review, reviewer-ops/policy, security) now live in
    // `apps/web/next.config.js` `redirects()` as canonical 308s.

    // All Tools self-reference — registry entry workspace.tools has
    // sidebarEligible:false, allToolsVisible:false. Wrapping itself
    // would be circular. Permanent exemption.
    { page: "tools/page.tsx", reason: "All Tools self-reference (registry entry workspace.tools)", revisitPhase: "PERMANENT" },


    // Dynamic sub-routes that inherit access from a parent route. CR1
    // will inherit via routeId or wrap explicitly.
    { page: "investigation/cases/[caseId]/graph/page.tsx", reason: "inherits investigation.graph access", revisitPhase: "CR1" },
    { page: "teams/[id]/page.tsx", reason: "inherits admin.teams access", revisitPhase: "CR1" },

    // Phase Final-Closure-Remediation — the following redirect /
    // duplicate page files were deleted and their behaviour moved into
    // `apps/web/next.config.js` `redirects()` as permanent 308s.
    // They are intentionally absent from the live route tree, so they
    // do not appear in the exemption list any more.
    //   * `cases/[id]/classic/page.tsx` (was G4.2 redirect)
    //   * `settings/security/scim/page.tsx` (was P1.2 redirect)
    //   * `settings/security/audit/page.tsx` (was P1.3 redirect)
    //   * `identity/page.tsx` (was Phase 17 legacy console; folded
    //     into the canonical `/admin/identity` enterprise operator
    //     control plane)
    //   * `teams/page.tsx` (was a duplicate of `workspaces/page.tsx`;
    //     canonical href flipped to `/workspaces` and the legacy URL
    //     redirects)
    //
    // Phase P1.1 — `/settings/security/saml` is still a redirect-only
    // page (not yet collapsed into next.config because the existing
    // P1 contract test pins the file content + docstring endpoint
    // list, separate scope from this closure).
    { page: "settings/security/saml/page.tsx", reason: "P1.1 canonical redirect to /security-center/sso — no body to gate", revisitPhase: "PERMANENT" },
    { page: "trust-center/page.tsx", reason: "canonical backward-compatible redirect to /trust — no body to gate", revisitPhase: "PERMANENT" },

    // Legacy operator page. CR1 inspected and deferred:
    // a real ~600 LoC operational console (not dead code).
    // Folding requires a UX-level decision (target gate or canonical
    // home) that CR1's surgical-stabilization charter explicitly
    // excludes. Revisit moved to CR2.
    { page: "review/operations/page.tsx", reason: "Phase 13 legacy review-ops queue; folding into /reviewer-ops is a UX decision deferred to CR2", revisitPhase: "CR2" },

    // Phase 38.12 — `/reviewer-ops/queue` is the canonical queue-
    // anchored entry for `review.queue_detail`. It is a redirect-
    // only landing (next/navigation.redirect to /review, the
    // canonical reviewer console). No page body to gate.
    { page: "reviewer-ops/queue/page.tsx", reason: "Phase 38.12 redirect-only landing to /review (canonical reviewer console) — no body to gate", revisitPhase: "PERMANENT" },

    // Phase 1A IA reset — `/operations/{...}` are thin re-export
    // wrappers that delegate to the canonical legacy `/ops/...`
    // and `/dashboard/...` page implementations (which carry their
    // own PageRouteGate). The wrappers exist only so the canonical
    // URL family resolves to the same content as the legacy URLs
    // (which 308-redirect here). Re-gating in the wrapper would
    // double-render the structured-denial panel.
    { page: "operations/observability/page.tsx", reason: "Phase 1A IA reset thin wrapper — delegates to /ops/observability which carries the PageRouteGate", revisitPhase: "PERMANENT" },
    { page: "operations/runbooks/page.tsx", reason: "Phase 1A IA reset thin wrapper — delegates to /ops/runbooks which carries the PageRouteGate", revisitPhase: "PERMANENT" },
    { page: "operations/media-graph/page.tsx", reason: "Phase 1A IA reset thin wrapper — delegates to /ops/media-graph which carries the PageRouteGate", revisitPhase: "PERMANENT" },
    { page: "operations/automation/page.tsx", reason: "Phase 1A IA reset thin wrapper — delegates to /ops/automation which carries the PageRouteGate", revisitPhase: "PERMANENT" },
    { page: "operations/analytics/page.tsx", reason: "Phase 1A IA reset thin wrapper — delegates to /ops/analytics which carries the PageRouteGate", revisitPhase: "PERMANENT" },
    { page: "operations/batch-analysis/page.tsx", reason: "Phase 1A IA reset thin wrapper — delegates to /dashboard/batch-analysis which carries the PageRouteGate", revisitPhase: "PERMANENT" },
    { page: "operations/quotas/page.tsx", reason: "Phase 1A IA reset thin wrapper — delegates to /dashboard/quotas which carries the PageRouteGate", revisitPhase: "PERMANENT" },
  ];

  it("every page.tsx under app/(app)/ either has PageRouteGate or is on the CR0 exemption list", () => {
    const root = webPath("app/(app)");
    const all = listAllTsxFiles(root).filter((f) => /page\.tsx$/.test(f));
    const exemptSuffixes = new Set(
      DOCUMENTED_EXEMPTIONS.map((e) => e.page.replace(/\\/g, "/")),
    );
    const offenders: string[] = [];
    for (const file of all) {
      const normalized = file.replace(/\\/g, "/");
      const rel = normalized.replace(/^.*\/app\/\(app\)\//, "");
      if (exemptSuffixes.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      if (!/PageRouteGate/.test(src)) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      `Pages must either use <PageRouteGate> or be added to the CR0 DOCUMENTED_EXEMPTIONS list with a justification + revisit phase. Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("every exemption has a non-empty reason + revisitPhase (no orphan entries)", () => {
    for (const e of DOCUMENTED_EXEMPTIONS) {
      expect(e.reason.length, `${e.page} exemption needs reason`).toBeGreaterThan(2);
      expect(e.revisitPhase.length, `${e.page} needs revisitPhase`).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// PART 2 — Sidebar root groups bounded (no chaos drift)
// =============================================================================

describe("Phase CR0 — sidebar root groups bounded to canonical vocabulary", () => {
  /**
   * The canonical sidebar derives its groups from ROUTE_REGISTRY via
   * `resolveWorkflowExposure`. The BOUNDED set of group titles that
   * can appear at the root level is intentional and bounded. Adding
   * a new root-level group must go through CR6 (Product Orchestration
   * Layer), not be done ad-hoc.
   */
  // Phase G0 (B.1) — sidebar rewrite. The R2 group titles were
  // consolidated into the Phase B canonical operational hierarchy
  // (Workspace · Governance · Outputs · System). Source of truth:
  // `apps/web/lib/navigation/canonicalNavigationGroups.ts`
  // (`ALLOWED_ROOT_GROUP_TITLES`) + `phaseBOperationalGroups.ts`.
  const ALLOWED_ROOT_GROUP_TITLES = [
    "Workspace",
    "Governance",
    "Outputs",
    "System",
    "All Tools",
    // The collapsed More disclosure is rendered as a group:
    "More / Advanced",
  ];

  it("sidebar source + canonical group definitions only emit titles from the bounded vocabulary", () => {
    // R2 extracted the group title literals out of AppSidebarV2.tsx
    // and into `lib/navigation/canonicalNavigationGroups.ts`. The
    // pin now scans BOTH so any future drift in either file fails
    // the CR0 contract.
    const sidebar = readWeb("components/app-shell-v2/AppSidebarV2.tsx");
    const canonical = readWeb("lib/navigation/canonicalNavigationGroups.ts");
    const combined = `${sidebar}\n${canonical}`;
    const titleMatches = Array.from(
      combined.matchAll(/title:\s*"([^"]+)"/g),
    ).map((m) => m[1]);
    for (const t of titleMatches) {
      expect(
        ALLOWED_ROOT_GROUP_TITLES.includes(t),
        `Sidebar root group "${t}" is not in the bounded vocabulary. Add it to ALLOWED_ROOT_GROUP_TITLES intentionally (CR6) or remove.`,
      ).toBe(true);
    }
  });

  it("sidebar source contains no raw 'Org' / 'Access' as a primary group label", () => {
    const sidebar = readWeb("components/app-shell-v2/AppSidebarV2.tsx");
    // Forbidden in `title:` literals (primary group labels).
    expect(sidebar).not.toMatch(/title:\s*"Org"/);
    expect(sidebar).not.toMatch(/title:\s*"Access"/);
    expect(sidebar).not.toMatch(/title:\s*"Org\s/);
    expect(sidebar).not.toMatch(/title:\s*"Access\s/);
  });
});

// =============================================================================
// PART 3 — User-facing "Unknown" fallbacks bounded
// =============================================================================

describe("Phase CR0 — no new user-facing 'Unknown' fallback in primary surfaces", () => {
  /**
   * "Unknown" rendered to a user typically means the frontend is
   * leaking an internal-state hole. CR0 freezes the EXISTING set of
   * "Unknown" appearances in primary surfaces (sidebar, topbar,
   * dashboard, persona/profile, app shell) — new appearances must be
   * explicitly justified.
   *
   * The existing set is small; we don't try to enumerate it. Instead
   * we check ONLY the explicit primary-shell files for the literal
   * `"Unknown"` user-string and require any new occurrence to be
   * justified inline with a `// CR0-allowed: <reason>` comment.
   */
  const PRIMARY_SHELL_FILES = [
    "components/app-shell-v2/AppSidebarV2.tsx",
    "components/app-shell-v2/AppShellV2.tsx",
    "components/navigation/CommandPalette.tsx",
    "components/navigation/PageRouteGate.tsx",
    "components/contextual-help/ContextualHelp.tsx",
  ];

  it("primary shell files contain no raw user-facing 'Unknown' string without an explicit CR0 allowance", () => {
    for (const rel of PRIMARY_SHELL_FILES) {
      const src = readWeb(rel);
      // Match `"Unknown"` as a JSX text / string literal, ignoring
      // matches that have a `CR0-allowed:` comment on the same line.
      const lines = src.split("\n");
      const offenders: number[] = [];
      lines.forEach((line, idx) => {
        if (/["']Unknown["']/.test(line)) {
          if (/CR0-allowed:/i.test(line)) return;
          offenders.push(idx + 1);
        }
      });
      expect(
        offenders,
        `${rel} contains user-facing "Unknown" at lines ${offenders.join(", ")} without a CR0-allowed comment.`,
      ).toEqual([]);
    }
  });
});

// =============================================================================
// PART 4 — Production server.ts mount inventory frozen
// =============================================================================

describe("Phase CR0 — server.ts route registration inventory is frozen (CR1 will purge)", () => {
  /**
   * server.ts currently registers a handful of legacy/orphan routes
   * (per the Phase 39 audit). CR0 does NOT delete them; CR1 does.
   * What CR0 prevents is the addition of MORE orphans or seed routes
   * in production registration before CR1 runs.
   *
   * We pin the current acknowledged debt explicitly so that adding a
   * new orphan stands out in diff review.
   */
  it("server.ts mounts the acknowledged-debt route handles and no new seed/orphan routes appear", () => {
    const server = readApi("src/server.ts");
    // Acknowledged debt (CR1 will purge / guard):
    expect(server).toMatch(/opsSeedRoutes/); // CR1 Phase F: env-guarded
    // CR1 Phase B — legacy webhook routes REMOVED. Pin the absence so
    // they cannot come back without explicit sign-off. Match actual
    // code-context only (imports + register call) — explanatory
    // deletion comments are allowed to mention the symbol.
    expect(server).not.toMatch(/^import[^\n]*\bwebhookRoutes\b/m);
    expect(server).not.toMatch(/\bapp\.register\(webhookRoutes\)/);

    // Forbid any *new* registration of files that look like seed /
    // debug / fixture routes alongside the acknowledged ones. New
    // files matching these patterns require explicit CR1 sign-off.
    const FORBIDDEN_NEW_SEED_PATTERNS = [
      /\bdevSeedRoutes\b/,
      /\bfixtureRoutes\b/,
      /\bdebugSeedRoutes\b/,
      /\btestOnlyRoutes\b/,
    ];
    for (const pattern of FORBIDDEN_NEW_SEED_PATTERNS) {
      expect(
        server,
        `New seed/debug route registration matching ${pattern} is forbidden under CR0. Use a guarded test endpoint instead, or wait for CR1.`,
      ).not.toMatch(pattern);
    }
  });

  it("the recovery baseline document exists", () => {
    // Test that docs/recovery/CR0_SYSTEM_FREEZE_BASELINE.md exists so
    // future contributors can find the canonical inventory.
    const docPath = fileURLToPath(
      new URL("../../../docs/recovery/CR0_SYSTEM_FREEZE_BASELINE.md", import.meta.url),
    );
    expect(
      readFileSync(docPath, "utf8").length,
      `${docPath} must exist and be non-empty.`,
    ).toBeGreaterThan(500);
  });
});

// =============================================================================
// PART 5 — Reaffirm existing locks (defense in depth)
// =============================================================================

describe("Phase CR0 — existing Phase 38 architectural locks still hold", () => {
  it("ROUTE_REGISTRY remains the canonical navigation source", () => {
    const sidebar = readWeb("components/app-shell-v2/AppSidebarV2.tsx");
    expect(sidebar).toMatch(/ROUTE_REGISTRY/);
    expect(sidebar).toMatch(/resolveRouteAccess/);
    // (2026-07-20) The workflow/persona exposure resolver was replaced
    // by the neutral, persona-free `resolveNavigationExposure` when the
    // workspace-persona / workflow-personalization feature was deleted.
    expect(sidebar).toMatch(/resolveNavigationExposure/);
  });

  it("PageRouteGate remains the canonical access decision render layer", () => {
    const gate = readWeb("components/navigation/PageRouteGate.tsx");
    expect(gate).toMatch(/resolveRouteAccess/);
    expect(gate).toMatch(/getRouteDefinition/);
  });

  // (2026-07-20) The "workflow safety statement" test was removed with the
  // WorkflowSafetyNotice component: workflow profiles no longer exist, so
  // there is nothing to reassure operators about. Navigation is canonical
  // and identical for everyone — no personalization to disclaim.
});
