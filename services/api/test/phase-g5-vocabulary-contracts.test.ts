/**
 * Phase G5.2 — Vocabulary + renaming contract suite.
 *
 * Goals (from the G5 spec):
 *
 *   * product-facing Team → Workspace
 *   * Case → Matter where operationally appropriate
 *   * Report → Report PDF where artifact-specific
 *   * Package → Verification Package ZIP where artifact-specific
 *   * tenant → never in user-facing UI
 *   * preserve backend DB names (Team, Case, Report, VerificationPackage)
 *
 * The contract is enforced as a **bounded allowlist** of files that
 * still carry the legacy term in user-facing strings. The G5.0 audit
 * mapped 45 offenders across 9 surfaces; this suite codifies that
 * frontier so:
 *
 *   - any NEW file using "Team" / "Case" / standalone "Report" /
 *     standalone "Package" in user-facing UI fails CI
 *   - allowlisted files can be migrated independently (a fix that
 *     removes a file from the allowlist is the desired direction of
 *     travel)
 *
 * This is the SAME pattern the G4.3 tenancy-cleanup test uses.
 *
 * Scope:
 *   * Backend code identifiers (`teamId`, `caseId`, etc.) are exempt.
 *   * Route paths (`/teams`, `/cases`) are exempt.
 *   * Component names + class names are exempt.
 *   * DB enum values and Prisma field names are exempt.
 *   * Only user-visible string literals (JSX text, button labels,
 *     toast messages, validation messages, page titles, modal copy)
 *     are checked.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, relative } from "node:path";

import { describe, expect, it } from "vitest";

const WEB_ROOT = fileURLToPath(
  new URL("../../../apps/web", import.meta.url),
);

/**
 * The SHIPPED web corpus.
 *
 * PHASE 12 POINT 1 (2026-07-31) — test sources are excluded. Every contract in
 * this file is about copy an OPERATOR can read; a vitest `it("…")` title, a
 * fixture string or a render-harness assertion is never rendered to anyone.
 * Scanning them produced failures for wording that is not user-facing at all
 * (a render test naming the workspace/tenant-generation seam it exercises),
 * which is a scoping defect in the scanner rather than a vocabulary breach.
 *
 * This can only ever REMOVE non-shipped files from the corpus — no shipped
 * surface stops being checked.
 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (
        name === "node_modules" ||
        name === ".next" ||
        name === "dist" ||
        name === "__tests__" ||
        name === "__mocks__" ||
        name === "e2e"
      ) {
        continue;
      }
      out.push(...walk(full));
      continue;
    }
    if (/\.(test|spec|render)\.(tsx|jsx)$/.test(name)) continue;
    if (name.endsWith(".tsx") || name.endsWith(".jsx")) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source[i] === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (source[i] === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/"))
        i++;
      i += 2;
      continue;
    }
    out += source[i];
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// "tenant" — must NEVER appear in user-facing UI strings.
// ---------------------------------------------------------------------------

/**
 * Files that may carry the word `tenant` in a non-tenancy-anchor
 * sense — e.g. governance onboarding copy that uses "tenant" as a
 * generic dictionary word ("collaborative tenant of the workspace").
 * Each entry is audited carryover.
 */
const TENANT_WORDING_ALLOWLIST = new Set<string>([
  "app/(app)/organizations/[id]/page.tsx",
]);

describe("Phase G5.2 — `tenant` is never visible to operators", () => {
  it("no JSX-string usage of the word `tenant` anywhere in apps/web (outside allowlist)", () => {
    const files = walk(WEB_ROOT);
    const offenders: Array<{ file: string; line: number; excerpt: string }> = [];
    for (const f of files) {
      const rel = relative(WEB_ROOT, f).replace(/\\/g, "/");
      if (TENANT_WORDING_ALLOWLIST.has(rel)) continue;
      const stripped = stripComments(readFileSync(f, "utf8"));
      const lines = stripped.split("\n");
      for (let i = 0; i < lines.length; i++) {
        // Only flag strings that look like UI copy: inside `"..."` or
        // `'...'` adjacent to JSX or button/title/label attributes.
        // The cheap heuristic: any case-insensitive `tenant` word
        // boundary inside a quoted string.
        const re = /["'][^"']*\btenant(?:s)?\b[^"']*["']/i;
        if (re.test(lines[i])) {
          offenders.push({
            file: rel,
            line: i + 1,
            excerpt: lines[i].trim().slice(0, 140),
          });
        }
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        "User-facing `tenant` strings found in apps/web — must be Workspace / Matter:\n" +
          offenders
            .map((o) => `  ${o.file}:${o.line} — ${o.excerpt}`)
            .join("\n"),
      );
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Artifact vocabulary — Report PDF / Verification Package ZIP must
// never be collapsed to standalone "Report" / "Package" in
// artifact-specific download contexts.
// ---------------------------------------------------------------------------

describe("Phase G5.2 — Artifact vocabulary (A2 contract) preserved", () => {
  it("no UI string says `Download report` without `PDF`", () => {
    const files = walk(WEB_ROOT);
    const offenders: Array<{ file: string; line: number; excerpt: string }> = [];
    // Match the verb form an operator would see, not generic "report" /
    // "analytics report".
    const verbRe = /Download report(?!\s+PDF)\b/;
    const allow = new Set<string>([
      // Permission-matrix label that intentionally pairs "report"
      // and "package" without artifact-specific suffix because the
      // matrix row covers BOTH artifacts in one permission grant.
      "components/workspace-admin/WorkspaceAdminPanel.tsx",
    ]);
    for (const f of files) {
      const stripped = stripComments(readFileSync(f, "utf8"));
      const lines = stripped.split("\n");
      const rel = relative(WEB_ROOT, f).replace(/\\/g, "/");
      if (allow.has(rel)) continue;
      for (let i = 0; i < lines.length; i++) {
        if (verbRe.test(lines[i])) {
          offenders.push({
            file: rel,
            line: i + 1,
            excerpt: lines[i].trim().slice(0, 140),
          });
        }
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        "Artifact-specific download string must say `Download Report PDF`:\n" +
          offenders
            .map((o) => `  ${o.file}:${o.line} — ${o.excerpt}`)
            .join("\n"),
      );
    }
    expect(offenders).toEqual([]);
  });

  it("no UI string says `Download verification package` without `ZIP`", () => {
    const files = walk(WEB_ROOT);
    const offenders: Array<{ file: string; line: number; excerpt: string }> = [];
    const verbRe = /Download (?:the\s+)?[Vv]erification [Pp]ackage(?!\s+ZIP)\b/;
    /**
     * Carryover allowlist for "Download verification package" UI
     * strings that pre-date the G5.2 ZIP-suffix contract. Each is a
     * candidate for the bounded follow-up "rename to Download
     * Verification Package ZIP". Adding a NEW file here is a
     * regression.
     */
    const allow = new Set<string>([
      "app/(app)/evidence/components/QueueSelectionPreview.tsx",
      "app/(app)/reviewer-ops/[reviewId]/page.tsx",
      "app/(app)/teams/[id]/components/TeamPermissionMatrix.tsx",
      "app/share/[id]/page.tsx",
      "components/reports-experience/ReportsIndex.tsx",
    ]);
    for (const f of files) {
      const stripped = stripComments(readFileSync(f, "utf8"));
      const lines = stripped.split("\n");
      const rel = relative(WEB_ROOT, f).replace(/\\/g, "/");
      if (allow.has(rel)) continue;
      for (let i = 0; i < lines.length; i++) {
        if (verbRe.test(lines[i])) {
          offenders.push({
            file: rel,
            line: i + 1,
            excerpt: lines[i].trim().slice(0, 140),
          });
        }
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        "Artifact-specific download string must say `Download Verification Package ZIP`:\n" +
          offenders
            .map((o) => `  ${o.file}:${o.line} — ${o.excerpt}`)
            .join("\n"),
      );
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Team → Workspace carryover allowlist.
//
// The 9 files in the allowlist below carry "Team" in user-facing UI
// and were identified by the G5.0 audit. Each is a candidate for
// follow-up renaming. The contract is: this list cannot GROW.
// ---------------------------------------------------------------------------

const TEAM_WORDING_ALLOWLIST = new Set<string>([
  // Billing / pricing surfaces — "Team" is a pricing-tier brand.
  "components/pricing/PricingComparisonTable.tsx",
  "components/pricing/PricingCheckoutGuide.tsx",
  "app/pricing/page.tsx",
  // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — three entries removed. The
  // two components are deleted, and the rebuilt Billing page carries no "Team"
  // wording at all: it names a BILLING ACCOUNT ("Personal", "Workspace",
  // "Organization"), and the word "Team" survives only as the pricing-tier
  // brand on Pricing.
  // Admin / dashboard / nav — pre-G5 terminology.
  "app/(app)/admin/dashboard/page.tsx",
  "app/(app)/admin/page.tsx",
  "app/(app)/operations/quotas/page.tsx",
  "components/ui-legacy.tsx",
  // Team-detail page — explicitly named per backend Team model.
  "app/(app)/teams/[id]/page.tsx",
  "app/(app)/teams/[id]/components/TeamPermissionMatrix.tsx",
  // Phase IA-self-serve-completion — /teams landing list. Uses
  // "Team" as the displayed entity name (same exemption as the
  // detail page above) when the org has no displayName/name set.
  "app/(app)/teams/page.tsx",
  // Phase IA-self-serve-home-rebuild — production self-serve Home.
  // Uses "Team activity", "Invite a teammate", "Manage teams" — all
  // canonical Collaboration Teams vocabulary (Phase 5/6/7) which is
  // already an allowlisted constitutional product term.
  "components/home-experience/SelfServeHomeDashboard.tsx",
  "components/home-experience/HomeSections.tsx",
  "components/home-experience/home-view-model.ts",
  "components/home-experience/useHomeData.ts",
  // Command Center + Governance Control Plane — older surfaces that
  // still describe the workspace as a "Team workspace". (The third
  // entry, ReviewerCommandConsole, was deleted in Phase 12 Point 4;
  // this list may only shrink.)
  "components/command-center/CommandCenter.tsx",
  "components/governance-experience/GovernanceControlPlane.tsx",
  // Landing / marketing nav.
  "components/header.tsx",
  "components/landing-body.tsx",
  "app/contact-sales/page.tsx",
  "app/(app)/intake-links/page.tsx",
  // Evidence saved-view chip + organizations onboarding copy +
  // security-center MFA recovery view + invite-token page — each
  // surfaces "Team" as a noun (saved-view scope, debug detail row,
  // landing CTA) that operators see during pre-G5 flows.
  "app/(app)/evidence/components/SavedViewsMenu.tsx",
  "app/(app)/organizations/[id]/page.tsx",
  "app/(app)/security-center/mfa-recovery/page.tsx",
  "app/invite/[token]/page.tsx",
  // -------------------------------------------------------------------
  // PHASE 5 / 6 / 7 — Collaboration Teams (constitutional product).
  //
  // Per the PROOVRA target operating model (Phase 7 closure
  // constitution), "Team" is the canonical term for collaboration
  // sub-units: members, invitations, assignments, activity, comments,
  // mentions, guest collaboration, team roles. The Team product is
  // explicitly NOT a workspace, NOT a tenant, NOT enterprise-only —
  // it is a core collaboration feature that works in BOTH the
  // Personal Workspace and the Organization Workspace.
  //
  // Renaming these surfaces to "Workspace" would VIOLATE constitutional
  // rules 2, 3, 4, 5, 6 (Team ≠ Workspace, Team is core collaboration,
  // Team is not enterprise-only). The four pages below are the
  // canonical Collaboration Teams surfaces shipped in Phases 5–7 and
  // therefore use the constitutional vocabulary.
  // -------------------------------------------------------------------
  "app/(app)/collaboration-teams/page.tsx",
  "app/(app)/collaboration-teams/[teamId]/page.tsx",
  // The team-detail page was decomposed into per-tab modules (app-* redesign);
  // each tab inherits the same legitimate Collaboration-Teams product wording.
  "app/(app)/collaboration-teams/[teamId]/_tabs/OverviewTab.tsx",
  "app/(app)/collaboration-teams/[teamId]/_tabs/MembersTab.tsx",
  "app/(app)/collaboration-teams/[teamId]/_tabs/InvitesTab.tsx",
  "app/(app)/collaboration-teams/[teamId]/_tabs/AssignmentsTab.tsx",
  "app/(app)/collaboration-teams/[teamId]/_tabs/ActivityTab.tsx",
  "app/(app)/collaboration-teams/[teamId]/_tabs/SettingsTab.tsx",
  "app/(app)/collaboration-teams/[teamId]/collaboration/page.tsx",
  "app/(app)/collaboration-teams/invites/[token]/accept/page.tsx",
  // -------------------------------------------------------------------
  // Phase IA-self-serve-simplification — pricing-aligned vocabulary.
  //
  // The public pricing page calls one of the plans "Team". The
  // self-serve simplification adds:
  //   * `FreeReportsLockedNotice` — the Reports unlock copy explicitly
  //     names "Pay-Per-Evidence, Pro, or Team" as the plans that
  //     include reports. Renaming "Team" here would break the
  //     pricing-page mirror that the brief requires.
  //   * `SelfServeHomeDashboard` — the "Team activity" section is the
  //     constitutional Collaboration Teams surface (see Phase 5/6/7
  //     above). The brief explicitly names this section.
  // -------------------------------------------------------------------
  "components/reports-experience/FreeReportsLockedNotice.tsx",
  "components/home-experience/SelfServeHomeDashboard.tsx",
  // -------------------------------------------------------------------
  // Platform Admin Control Center (P0/P1) — pricing-plan vocabulary.
  //
  // The billing-plan enum has a tier literally named "Team" (the public
  // pricing page's mid tier — see FreeReportsLockedNotice above). The
  // customers/organizations roster's plan filter and the billing detail
  // console's subscriptions-by-plan breakdown render that plan's
  // canonical name. This is the pricing tier, NOT a Collaboration Team
  // and NOT a Workspace — renaming it would break the pricing mirror.
  // -------------------------------------------------------------------
  // ADM-033 (2026-08-27) — renamed from `admin/organizations/page.tsx`. Same
  // page, same reason: it renders the FREE / PAYG / PRO / TEAM / ENTERPRISE
  // plan ladder, where "Team" is the product tier's canonical name.
  "app/(app)/admin/customers/page.tsx",
  "app/(app)/admin/billing/page.tsx",
  // ADM-027 / ADM-028 — the two new control-plane rosters offer the SAME plan
  // filter, for the same reason. The stored `value` stays "TEAM" (the pricing
  // mirror depends on it); only the visible label is spelled "Team plan", so
  // that beside "Pro" and "Enterprise" it cannot be misread as the workspace.
  "app/(app)/admin/workspaces/page.tsx",
  "app/(app)/admin/users/page.tsx",
  // -------------------------------------------------------------------
  // BILLING (2026-09-04) — the same pricing-tier reason, on the customer
  // side of it.
  //
  // The Billing overview's AI meter says "Available on Pro and Team" when
  // the current plan does not include AI. Those are the names of the two
  // tiers that do — the identical FREE / PAYG / PRO / TEAM / ENTERPRISE
  // ladder the admin consoles above are allowlisted for, and the same
  // pricing mirror. Spelling it "Workspace" would name no plan at all and
  // tell a customer to look for a tier that does not exist.
  //
  // This is the file's ONLY Team string; every other use of the word on
  // the billing surface is a plan key, not prose.
  // -------------------------------------------------------------------
  "app/(app)/billing/_sections/BillingOverview.tsx",
]);

describe("Phase G5.2 — Team → Workspace carryover", () => {
  it("no NEW file outside the allowlist uses `Team` in user-facing UI strings", () => {
    const files = walk(WEB_ROOT);
    const offenders: Array<{ file: string; line: number; excerpt: string }> = [];
    // Match phrases that look like UI labels — preceded by a quote
    // or JSX `>` and containing the word Team with a capital T.
    const labelRe =
      /["'>](?:[^"'<>]*\b)?Team(?:s)?\b(?!Id|Member|Role|Workspace|Permission)/;
    for (const f of files) {
      const rel = relative(WEB_ROOT, f).replace(/\\/g, "/");
      if (TEAM_WORDING_ALLOWLIST.has(rel)) continue;
      const stripped = stripComments(readFileSync(f, "utf8"));
      const lines = stripped.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (labelRe.test(lines[i])) {
          offenders.push({
            file: rel,
            line: i + 1,
            excerpt: lines[i].trim().slice(0, 140),
          });
        }
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        "New `Team` UI strings outside the G5.2 allowlist — use `Workspace`:\n" +
          offenders
            .map((o) => `  ${o.file}:${o.line} — ${o.excerpt}`)
            .join("\n"),
      );
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Case → Matter carryover allowlist (operational contexts only).
// ---------------------------------------------------------------------------

const CASE_WORDING_ALLOWLIST = new Set<string>([
  "app/(app)/evidence/components/BulkActionsToolbar.tsx",
  "app/(app)/evidence/[id]/components/ReviewWorkspace.tsx",
  "app/(app)/evidence/components/ReviewWorkspace.tsx",
  "app/(app)/teams/[id]/page.tsx",
  "components/cases-experience/matter-modals/CreateCaseModal.tsx",
  "components/command-center/CommandCenter.tsx",
  "app/(app)/governance/retention/page.tsx",
  "app/(app)/investigation/graph/page.tsx",
  "app/(app)/tools/page.tsx",
  "app/(app)/teams/[id]/components/TeamPermissionMatrix.tsx",
  // Public legal-domain meaning where "case" is intentional.
  "app/verify/[token]/page.tsx",
  "app/(app)/cases/page.tsx",
  // Investigation surface (legal-domain language).
  "app/(app)/investigation/page.tsx",
  "app/(app)/investigation/reviewers/page.tsx",
  "app/(app)/investigation/relationships/page.tsx",
  "app/(app)/investigation/cases/[caseId]/graph/page.tsx",
]);

describe("Phase G5.2 — Case → Matter carryover", () => {
  it("no NEW file outside the allowlist uses operational `Case` in UI", () => {
    const files = walk(WEB_ROOT);
    const offenders: Array<{ file: string; line: number; excerpt: string }> = [];
    // Match UI strings like "Add to Case", "Remove from Case", "Open
    // Case", "Case Operations". Exclude phrases like "use case" or
    // "test case".
    const labelRe =
      /["'>](?:[^"'<>]*\b)?(?:Open|Add|Remove|Create|Edit|Delete|Manage|Assign)\s+(?:to\s+|from\s+|the\s+)?Case\b/;
    for (const f of files) {
      const rel = relative(WEB_ROOT, f).replace(/\\/g, "/");
      if (CASE_WORDING_ALLOWLIST.has(rel)) continue;
      const stripped = stripComments(readFileSync(f, "utf8"));
      const lines = stripped.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (labelRe.test(lines[i])) {
          offenders.push({
            file: rel,
            line: i + 1,
            excerpt: lines[i].trim().slice(0, 140),
          });
        }
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        "New `Case` UI strings outside the G5.2 allowlist — use `Matter`:\n" +
          offenders
            .map((o) => `  ${o.file}:${o.line} — ${o.excerpt}`)
            .join("\n"),
      );
    }
    expect(offenders).toEqual([]);
  });
});
