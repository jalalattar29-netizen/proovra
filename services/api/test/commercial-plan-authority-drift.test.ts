/**
 * THE DRIFT GUARD for the effective-plan authority.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT FORBIDS, AND WHAT IT DELIBERATELY DOES NOT
 * ---------------------------------------------------------------------------
 * `Team.billingPlan` is a persisted column whose ONLY production writer is
 * Enterprise provisioning. On a Personal Workspace it is therefore always
 * `FREE`, whatever the account pays, and reading it as "the plan" is how the
 * product came to tell PRO customers they were on Free.
 *
 * This guard bans that reading in CUSTOMER-FACING plan projections. It does not
 * ban the column: several readings of it are legitimate and one of them is
 * load-bearing, so the allowlist below states each remaining reader and the
 * reason it is allowed. A blanket prohibition would have been rejected on the
 * first honest reader and deleted; a list with reasons survives review.
 *
 * WHY A SOURCE SCAN. The defect was never inside a function — it was the WRONG
 * SOURCE at a call site, and no unit test over `resolveWorkspaceEffectivePlan`
 * can see a caller that never invokes it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const API_SRC = new URL("../src/", import.meta.url);
const WEB_ROOT = new URL("../../../apps/web/", import.meta.url);

function read(rel: string, base: URL): string {
  return readFileSync(fileURLToPath(new URL(rel, base)), "utf8");
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Every file that still reads `billingPlan`, with the reason.
 *
 * A file NOT in this list may not read the column at all. Adding one is a
 * deliberate act that has to be justified here, in front of the next reader.
 */
const ALLOWED_BILLING_PLAN_READERS: ReadonlyArray<{
  file: string;
  base: "api" | "web";
  reason: string;
}> = [
  // --- The canonical resolution chain itself -------------------------------
  {
    file: "services/workspace-billing.service.ts",
    base: "api",
    reason:
      "THE input adapter. It loads the persisted column and hands it to `resolveWorkspaceEffectivePlan`, which is the decision. This is the one place the column is supposed to be read.",
  },
  {
    file: "services/identity/workspace-kind.ts",
    base: "api",
    reason:
      "Structural CLASSIFICATION, not a plan projection: the canonical kind resolver accepts the column as one signal for legacy rows with no `workspace_kind`.",
  },
  {
    file: "services/access/accessible-workspaces.ts",
    base: "api",
    reason: "Passes the column into `resolveWorkspaceKind` — classification, not a plan.",
  },
  {
    file: "routes/external-portal.routes.ts",
    base: "api",
    reason: "Passes the column into `resolveWorkspaceKind` — classification, not a plan.",
  },
  {
    file: "services/platform-context/enterprise-authority.ts",
    base: "api",
    reason:
      "Enterprise CONTRACT coverage on an ORGANIZATION workspace, where provisioning is the writer and the column is authoritative.",
  },
  {
    file: "services/platform-context/platform-context.service.ts",
    base: "api",
    reason:
      "Classification input plus the fallback the resolver degrades to. The workspace plan itself now comes from `resolveWorkspaceScopeForUser`.",
  },
  {
    file: "services/platform-context/workspace-bootstrap.service.ts",
    base: "api",
    reason: "WRITES the column when bootstrapping a workspace row.",
  },

  // --- Provisioning and lifecycle: the writers -----------------------------
  {
    file: "services/enterprise-provisioning.service.ts",
    base: "api",
    reason: "The ONE production writer of the column.",
  },
  {
    file: "routes/admin-provisioning.routes.ts",
    base: "api",
    reason: "Provisioning surface — reads what provisioning wrote.",
  },
  {
    file: "services/workspace/workspace-lifecycle.service.ts",
    base: "api",
    reason: "Workspace lifecycle bookkeeping over the persisted commercial columns.",
  },
  {
    file: "services/organization/admin-organizations.service.ts",
    base: "api",
    reason: "Organization administration over provisioned ORGANIZATION workspaces.",
  },
  {
    file: "services/admin/customer-lifecycle.ts",
    base: "api",
    reason: "Customer lifecycle over provisioned ORGANIZATION workspaces.",
  },
  {
    file: "routes/webhooks.routes.ts",
    base: "api",
    reason: "Provider lifecycle handling against the persisted workspace columns.",
  },

  // --- Platform-admin consoles: the raw row IS the subject -----------------
  {
    file: "services/admin/workspaces.service.ts",
    base: "api",
    reason:
      "PLATFORM_ADMIN workspace directory. Its subject is the persisted row, and the projection names the field `raw`.",
  },
  { file: "services/admin/executive.service.ts", base: "api", reason: "PLATFORM_ADMIN aggregate." },
  { file: "services/admin/overview.service.ts", base: "api", reason: "PLATFORM_ADMIN aggregate." },
  { file: "services/admin/search.service.ts", base: "api", reason: "PLATFORM_ADMIN search." },
  {
    file: "routes/analytics.routes.ts",
    base: "api",
    reason:
      "PLATFORM analytics sweep across every live workspace. It carries a DOCUMENTED baseline tolerance — it cannot resolve a commercial context per workspace at that scale — and it is a platform report, never a customer's plan.",
  },
  {
    file: "routes/organizations.routes.ts",
    base: "api",
    reason: "Organization rollup over provisioned ORGANIZATION workspaces.",
  },
  {
    file: "routes/organizations-governance.routes.ts",
    base: "api",
    reason: "Organization rollup over provisioned ORGANIZATION workspaces.",
  },
  {
    file: "routes/organizations-reports.routes.ts",
    base: "api",
    reason: "Organization rollup over provisioned ORGANIZATION workspaces.",
  },
  {
    file: "routes/organizations-bulk-invite.routes.ts",
    base: "api",
    reason: "Organization rollup over provisioned ORGANIZATION workspaces.",
  },

  // --- Remaining API readers ----------------------------------------------
  {
    file: "routes/teams.routes.ts",
    base: "api",
    reason:
      "Returns the raw columns to ADMIN and above as administrative data, BESIDE `effectivePlan`, which is what the client renders.",
  },
  {
    file: "services/workspace-admin/workspace-admin.service.ts",
    base: "api",
    reason:
      "Projects the raw column as `persistedBillingPlan` for diagnostics, beside the resolved `effectivePlan`.",
  },
  {
    file: "services/billing.service.ts",
    base: "api",
    reason: "Billing bookkeeping over the persisted workspace columns.",
  },
  {
    file: "services/billing-overview.service.ts",
    base: "api",
    reason: "Reads through the canonical scope; the column appears as a select only.",
  },
  {
    file: "services/billing-enforcement.service.ts",
    base: "api",
    reason: "Select/plumbing only; every decision reads `scope.plan`.",
  },
  {
    file: "services/collaboration-team/billing-guards.ts",
    base: "api",
    reason: "Collaboration capacity guard over the canonical scope.",
  },
  {
    file: "services/collaboration-team/collaboration-team.service.ts",
    base: "api",
    reason: "Collaboration capacity over the canonical scope.",
  },
  {
    file: "services/enterprise-gate-resolvers.service.ts",
    base: "api",
    reason: "Enterprise feature gates resolved from the commercial context.",
  },
  {
    file: "services/identity/access-policy.service.ts",
    base: "api",
    reason: "Access policy classification input.",
  },

  // --- Web: platform-admin and organization consoles only ------------------
  {
    file: "app/(app)/admin/workspaces/page.tsx",
    base: "web",
    reason: "PLATFORM_ADMIN directory; the field is literally named `raw`.",
  },
  {
    file: "app/(app)/admin/workspaces/[id]/page.tsx",
    base: "web",
    reason: "PLATFORM_ADMIN workspace detail over the persisted row.",
  },
  {
    file: "app/(app)/admin/customers/page.tsx",
    base: "web",
    reason: "PLATFORM_ADMIN customer directory.",
  },
  {
    file: "app/(app)/admin/customers/[id]/page.tsx",
    base: "web",
    reason: "PLATFORM_ADMIN customer detail.",
  },
  {
    file: "app/(app)/organizations/[id]/admin/billing/page.tsx",
    base: "web",
    reason:
      "Organization rollup over PROVISIONED ORGANIZATION workspaces, where provisioning is the writer and the canonical resolver's ORGANIZATION branch returns the same value.",
  },
  {
    file: "app/(app)/teams/[id]/page.tsx",
    base: "web",
    reason:
      "Declares the field so the response shape matches. It is NOT rendered — the page renders `effectivePlan` — and the assertions below pin that.",
  },
];

describe("effective plan — no customer surface reads the raw column as truth", () => {
  it("the People page declares the raw column and renders only the effective plan", () => {
    const code = stripComments(read("app/(app)/teams/[id]/page.tsx", WEB_ROOT));
    // Declared in the response type…
    expect(code).toMatch(/billingPlan\?:\s*string \| null/);
    // …and never read into a rendered value.
    expect(code).not.toMatch(/team\?\.billingPlan/);
    expect(code).toMatch(/normalizePlanLabel\(team\?\.effectivePlan\)/);
  });

  it("the workspace-admin panel renders the effective plan on both surfaces that show one", () => {
    const code = stripComments(
      read("components/workspace-admin/WorkspaceAdminPanel.tsx", WEB_ROOT),
    );
    expect(code).toMatch(/env\.workspace\.effectivePlan/);
    // The Billing tile reads `sections.billing.data.plan`, which the server now
    // fills from the resolved plan.
    expect(code).toMatch(/cc-tile-value">\{d\.plan\}/);
  });

  it("the allowlist has a reason for every entry, and every entry still reads the column", () => {
    /*
     * A stale allowlist is worse than none: it teaches the next reader that the
     * list is decorative. An entry whose file no longer mentions the column is
     * a failure here, so removing a reader means removing its licence too.
     */
    for (const entry of ALLOWED_BILLING_PLAN_READERS) {
      expect(entry.reason.length).toBeGreaterThan(20);
      const base = entry.base === "api" ? API_SRC : WEB_ROOT;
      const src = read(entry.file, base);
      expect(
        src.includes("billingPlan"),
        `${entry.file} is allowlisted but no longer reads billingPlan — remove the entry`,
      ).toBe(true);
    }
  });

  it("no allowlisted file may be the workspace-admin plan projection again", () => {
    // The precise shape of the original defect, banned by name.
    const code = stripComments(
      read("services/workspace-admin/workspace-admin.service.ts", API_SRC),
    );
    expect(code).not.toMatch(/\bplan:\s*String\(team\.billingPlan\)/);
  });
});
