/**
 * PHASE 12 — POINT 7, STEP 5: the client-authority metrics.
 *
 * WHAT KIND OF EVIDENCE THIS IS, STATED PLAINLY
 * ---------------------------------------------------------------------------
 * A structural absence claim, not a behavioural one. The mandate is explicit
 * that a source regex is not behavioural proof, and it is right: "the FREE
 * user cannot create a case" is proven by driving the product, and that lives
 * in the server and browser matrices.
 *
 * But "the browser contains NO second authority for this decision" is a claim
 * about what the code does not contain, and there is no behaviour that
 * establishes it — a duplicate authority is invisible whenever it happens to
 * agree, which is most of the time, which is exactly why it survives. The
 * honest instrument for an absence claim is a scan, and the honest thing to do
 * is label it as one.
 *
 * WHAT COUNTS AS AN AUTHORITY
 * ---------------------------------------------------------------------------
 * Deriving a DECISION from a plan name, a role name, or a limit table. Not:
 *   - rendering a plan name as a LABEL;
 *   - choosing a checkout TARGET the user explicitly picked;
 *   - reading a server-projected boolean or number.
 * The distinction is whether the browser would still be right if the server
 * changed its mind.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { repoRoot } from "./point7/scenario-manifest.js";

const ROOT = repoRoot();
const WEB = resolve(ROOT, "apps/web");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "__tests__") {
      continue;
    }
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/**
 * Every browser source tree that exists.
 *
 * Discovered rather than listed: a directory added later must be scanned, and
 * a directory that does not exist must not silently narrow the scan to
 * nothing. `existsSync` here is about the SHAPE of the app, not about skipping
 * inconvenient files — a missing `app/` would fail the count assertion below.
 */
const WEB_SOURCES = ["app", "components", "lib", "hooks"]
  .map((d) => resolve(WEB, d))
  .filter((d) => existsSync(d))
  .flatMap((d) => walk(d))
  .filter((f) => !f.includes("__tests__"));

/**
 * Source with comments removed.
 *
 * Necessary, not fastidious: a scan that counts prose finds an "offender"
 * every time somebody DOCUMENTS the rule — this very migration left a dozen
 * comments naming `getCollaborationTeamPlanLimits` to explain why it is gone.
 * A metric that punishes writing down the reason teaches people to stop
 * writing down the reason.
 */
function read(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function rel(file: string): string {
  return relative(ROOT, file).split("\\").join("/");
}

/**
 * Files whose plan-name reads are PRESENTATION or explicit user CHOICE, with
 * the reason recorded per file. A closed list: adding to it is a decision
 * somebody has to write down, which is the point.
 */
const PRESENTATION_ALLOWLIST: Record<string, string> = {
  "apps/web/components/billing/CheckoutPanel.tsx":
    "checkout TARGET selection — the user picks what to buy; the server prices and authorizes it",
  "apps/web/components/billing/StorageAddonsPanel.tsx":
    "add-on catalogue filtering by the user's chosen target",
  "apps/web/components/billing/TeamWorkspaceCard.tsx":
    "renders the workspace's server-resolved plan as a label + tone",
  "apps/web/components/billing/PersonalWorkspaceCard.tsx":
    "renders the server-resolved plan as a label",
  "apps/web/app/(app)/billing/page.tsx":
    "checkout target defaulting from an explicit query parameter",
  "apps/web/app/(app)/admin/executive/page.tsx":
    "platform-admin reporting: plan name → chart tone",
  "apps/web/app/(app)/admin/demo-requests/page.tsx":
    "sales lead-track counting, not a product entitlement",
  "apps/web/app/(app)/organizations/[id]/admin/billing/page.tsx":
    "admin console rendering the persisted billing plan of each workspace",
  "apps/web/lib/settings/settingsUiContext.ts":
    "display label for the settings header",
  "apps/web/lib/api/billing-summary.ts":
    "formats an unlimited storage figure for display",
  "apps/web/components/workspace-admin/WorkspaceAdministrationHome.tsx":
    "admin console rendering persisted plan values as labels",
  "apps/web/app/(app)/settings/_sections/AiSection.tsx":
    "copy variant for the AI allowance sentence",
  "apps/web/app/(app)/teams/[id]/page.tsx":
    "renders the workspace's server-resolved subscription state as a label",
};

describe("PHASE 12 POINT 7 STEP 5 — client-authority metrics", () => {
  it("the scan actually reached the browser sources", () => {
    // A scan that found nothing would report every metric as zero.
    expect(WEB_SOURCES.length).toBeGreaterThan(200);
  });

  it("ClientLimitAuthorities = 0 — the browser derives no commercial limit", () => {
    // `getCollaborationTeamPlanLimits` is the limit TABLE. Any client call is
    // a limit authority by definition: it maps a plan name to a number the
    // server also maps, in a second place, from a subject the client guessed.
    const offenders = WEB_SOURCES.filter((f) =>
      /getCollaborationTeamPlanLimits|COLLABORATION_TEAM_PLAN_LIMITS|getPlanCapabilities|PLAN_CAPABILITIES/.test(
        read(f),
      ),
    ).map(rel);
    expect(
      offenders,
      "these files derive a commercial limit in the browser; read planFeatures.limits instead",
    ).toEqual([]);
  });

  it("OwnerPlanFallbacks = 0 — no surface falls back to the account plan", () => {
    // The `?? account.accountPlan` tail is the fallback: it substitutes the
    // OWNER's commercial state when the workspace has none of its own, which
    // the canonical effective-plan policy explicitly refuses to do.
    const offenders = WEB_SOURCES.filter((f) =>
      /\?\?\s*account(\?)?\.accountPlan|\|\|\s*account(\?)?\.accountPlan/.test(read(f)),
    ).map(rel);
    expect(
      offenders,
      "these files fall back to the ACCOUNT plan for a workspace decision",
    ).toEqual([]);
  });

  it("ClientPlanNameAuthorities = 0 — plan names drive labels, never decisions", () => {
    // The measured thing is a comparison whose LEFT side is a PLAN. The
    // vocabulary overlaps with three others that are not plans and must not be
    // counted:
    //
    //   `scope === "TEAM"`  the workspace SCOPE (PERSONAL | TEAM);
    //   `tier === "ENTERPRISE"` the static SURFACE tier — a classification of
    //                       screens, whose decision then reads the
    //                       server-projected `isEnterpriseWorkspace`;
    //   `leadTrack === "ENTERPRISE"` a sales lead track;
    //   `visibility === "TEAM"` a saved view VISIBILITY (PRIVATE | TEAM),
    //                       which says who can SEE a stored query and grants
    //                       no authority at all — replaying one issues the
    //                       ordinary read under the reader's own permissions.
    //
    // Counting those would produce a metric that is impossible to drive to
    // zero without renaming unrelated concepts, which is how a metric gets
    // quietly deleted instead of satisfied.
    const COMPARISON =
      /\b([A-Za-z_$][\w$.?]*)\s*[=!]==\s*["'](FREE|PAYG|PRO|TEAM|ENTERPRISE)["']/g;
    const NOT_A_PLAN =
      /scope|tier|kind|track|target|type|status|role|visibility/i;

    const offenders = WEB_SOURCES.filter((f) => {
      const relPath = rel(f);
      if (relPath in PRESENTATION_ALLOWLIST) return false;
      const src = read(f);
      for (const match of src.matchAll(COMPARISON)) {
        const lhs = match[1];
        if (NOT_A_PLAN.test(lhs)) continue;
        if (/plan/i.test(lhs)) return true;
        // An unqualified identifier compared to a plan literal is a plan
        // comparison unless it names one of the overlapping vocabularies.
        return true;
      }
      return false;
    }).map(rel);
    expect(
      offenders,
      "these files branch on a plan NAME; branch on a server-projected capability instead",
    ).toEqual([]);
  });

  it("every allowlisted presentation file still exists", () => {
    // An allowlist that outlives its files is how an exemption becomes
    // permanent: the entry stops matching anything and nobody notices.
    for (const file of Object.keys(PRESENTATION_ALLOWLIST)) {
      expect(
        WEB_SOURCES.some((f) => rel(f) === file),
        `${file} is allowlisted but no longer exists — remove the entry`,
      ).toBe(true);
    }
  });

  it("the server projects the limits the client renders", () => {
    // The other half of the metric: removing the client authority is only
    // honest if the server actually supplies the value.
    const types = readFileSync(
      resolve(ROOT, "services/api/src/services/platform-context/types.ts"),
      "utf8",
    );
    expect(types).toMatch(/limits:\s*\{/);
    expect(types).toMatch(/maxOwnedWorkspaces:\s*number/);
    expect(types).toMatch(/maxMembersPerTeam:\s*number/);

    const service = readFileSync(
      resolve(
        ROOT,
        "services/api/src/services/platform-context/platform-context.service.ts",
      ),
      "utf8",
    );
    expect(service).toMatch(/maxOwnedWorkspaces:\s*planCaps\.maxOwnedTeams/);
    expect(service).toMatch(/maxMembersPerTeam:\s*planCaps\.maxMembersPerTeam/);
  });

  it("SilentPersonalFallbacks = 0 — the context builder gates every personal selection", () => {
    const service = readFileSync(
      resolve(
        ROOT,
        "services/api/src/services/platform-context/platform-context.service.ts",
      ),
      "utf8",
    );
    // The permission is resolved BEFORE the bootstrap, so it can govern
    // selection rather than merely presentation.
    const resolvedAt = service.indexOf("personalSpaceAllowedFlag = await resolvePersonalSpaceAllowed");
    const bootstrapAt = service.indexOf("await ensurePersonalWorkspace({ userId: userRow.id })");
    expect(resolvedAt).toBeGreaterThan(-1);
    expect(bootstrapAt).toBeGreaterThan(-1);
    expect(
      resolvedAt,
      "the personal-space permission must be resolved before the bootstrap it governs",
    ).toBeLessThan(bootstrapAt);
    // Both option lists are gated — the canonical one and the compatibility one.
    expect(service).toMatch(/personalTeamId && personalSpaceAllowedFlag/);
  });
});
