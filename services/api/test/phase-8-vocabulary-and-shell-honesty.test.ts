/**
 * Phase 8 — Vocabulary + shell honesty contract.
 *
 * Constitutional vocabulary rules applied to the new org-admin shell
 * and its leaf tabs, plus an honesty rule on the Security tab that
 * forbids fake-positive readiness affordances when MFA / SSO / SCIM
 * are not configured.
 *
 * Rules pinned:
 *
 *   1. No "Governance Workspace", "Team Workspace", "Reviewer Workspace",
 *      or "Operations Workspace" strings anywhere in the admin shell
 *      pages.
 *   2. The word "workspace" is never applied as a label to an
 *      Organization (no "Organization workspace", "Org workspace",
 *      etc.) in user-visible strings.
 *   3. "Organization" is the operator label everywhere — verified by
 *      the layout header + tab descriptions.
 *   4. /admin/security renders honest "Not configured" states for MFA,
 *      SSO, SCIM, Sessions — no green checkmarks or "All set" copy.
 *   5. Every "configure" affordance on the security tab links OUT to a
 *      canonical configuration surface (no in-shell fake-button).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const WEB_ROOT = fileURLToPath(new URL("../../../apps/web", import.meta.url));

function readWeb(rel: string): string {
  return readFileSync(resolve(WEB_ROOT, rel), "utf8");
}

const ADMIN_FILES: ReadonlyArray<string> = [
  "app/(app)/organizations/[id]/admin/layout.tsx",
  "app/(app)/organizations/[id]/admin/page.tsx",
  "app/(app)/organizations/[id]/admin/overview/page.tsx",
  "app/(app)/organizations/[id]/admin/members/page.tsx",
  "app/(app)/organizations/[id]/admin/departments/page.tsx",
  "app/(app)/organizations/[id]/admin/governance/page.tsx",
  "app/(app)/organizations/[id]/admin/access-reviews/page.tsx",
  "app/(app)/organizations/[id]/admin/retention/page.tsx",
  "app/(app)/organizations/[id]/admin/audit/page.tsx",
  "app/(app)/organizations/[id]/admin/security/page.tsx",
  "app/(app)/organizations/[id]/admin/trust/page.tsx",
];

// ---------------------------------------------------------------------------
// (1) No forbidden "<Concept> Workspace" phrases in admin shell pages.
// ---------------------------------------------------------------------------

const FORBIDDEN_FAKE_WORKSPACE_PHRASES: ReadonlyArray<{
  phrase: string;
  why: string;
}> = [
  {
    phrase: "Governance Workspace",
    why: "Governance is a feature area, not a workspace.",
  },
  {
    phrase: "Team Workspace",
    why: "Team is a collaboration unit, not a workspace.",
  },
  {
    phrase: "Reviewer Workspace",
    why: "Reviewer is a role, not a workspace.",
  },
  {
    phrase: "Operations Workspace",
    why: "Operations is platform-admin only — not a workspace.",
  },
  {
    phrase: "Department Workspace",
    why: "Department is an org sub-unit, not a workspace.",
  },
];

describe("Phase 8 — admin pages forbid '<Concept> Workspace' literals", () => {
  for (const file of ADMIN_FILES) {
    const body = readWeb(file);
    for (const { phrase, why } of FORBIDDEN_FAKE_WORKSPACE_PHRASES) {
      it(`${file} does not contain "${phrase}" (${why})`, () => {
        // Case-insensitive scan — any occurrence (in a string literal,
        // comment, JSX) would mislead operators.
        const re = new RegExp(phrase.replace(/ /g, "\\s+"), "i");
        expect(body).not.toMatch(re);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// (2) The word "workspace" is never applied as a label to Organization.
//
// Forbidden phrases on the admin shell (where "Organization" is the
// only correct label):
//   - "Organization Workspace"
//   - "Org Workspace"
//   - "Organization workspace" (any case)
// ---------------------------------------------------------------------------

const ORG_WORKSPACE_FORBIDDEN: ReadonlyArray<string> = [
  "Organization Workspace",
  "Organization workspace",
  "Org Workspace",
  "Org workspace",
];

describe("Phase 8 — admin pages never use 'Organization Workspace'-style labels", () => {
  for (const file of ADMIN_FILES) {
    const body = readWeb(file);
    for (const phrase of ORG_WORKSPACE_FORBIDDEN) {
      it(`${file} does not contain "${phrase}"`, () => {
        // Strict literal scan — same hammer the Phase 7 anti-confusion
        // test uses for the fake-workspace phrases.
        expect(body).not.toContain(phrase);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// (3) "Organization" is the consistent operator label.
//
// The layout header must use "Organization" or "organization", never
// "Account" or "Tenant" as a synonym for Org.
// ---------------------------------------------------------------------------

describe("Phase 8 — admin layout uses 'Organization' as the canonical label", () => {
  const layout = readWeb("app/(app)/organizations/[id]/admin/layout.tsx");

  it("the layout kicker says 'Organization administration'", () => {
    expect(layout).toMatch(/Organization administration/);
  });

  it("the layout's role labels never use 'Tenant' as a synonym for Organization", () => {
    expect(layout).not.toMatch(/Tenant/);
  });

  it("the breadcrumb says 'All organizations'", () => {
    expect(layout).toMatch(/All organizations/);
  });
});

// ---------------------------------------------------------------------------
// (4) Security tab — honest "Not configured" empty states.
// ---------------------------------------------------------------------------

describe("PHASE 12B — /admin/security is the REAL OrganizationSecurityPolicyEditor (page wrapper honesty)", () => {
  const security = readWeb(
    "app/(app)/organizations/[id]/admin/security/page.tsx",
  );

  it("mounts the canonical editor behind the org-detail route gate", () => {
    // The static readiness hub (fabricated "Not configured" rows +
    // configureHref deep-links) was REPLACED by the real org-keyed
    // security-policy editor in 12B Batch 2 — the honesty contract moved
    // from "never fake readiness" to "render only server-projected policy
    // states" (loading / not_provisioned / not_applicable / error / ready),
    // proven behaviorally in security-policy-editor.render.test.tsx.
    expect(security).toMatch(/OrganizationSecurityPolicyEditor/);
    expect(security).toMatch(/PageRouteGate routeId="account.organization-detail"/);
  });

  it("the page wrapper itself renders no fake-positive or fabricated readiness copy", () => {
    expect(security).not.toMatch(/All set/i);
    expect(security).not.toMatch(/Ready to go/i);
    expect(security).not.toMatch(/Not configured/);
    expect(security).not.toMatch(/configureHref/);
  });
});

describe("Phase 8 — no raw window.confirm anywhere in the admin shell", () => {
  for (const file of ADMIN_FILES) {
    it(`${file} does not call window.confirm in executable code`, () => {
      const body = readWeb(file);
      // Strip line comments + block comments so we don't false-match
      // doc strings like "No raw window.confirm (page is read-only)".
      const stripped = body
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/, ""))
        .join("\n");
      expect(stripped).not.toMatch(/window\.confirm\s*\(/);

      // Any unqualified `confirm(` call in stripped (executable) code
      // is only legitimate when it's the destructured callback from
      // useConfirmAction. We check that any executable `confirm(` is
      // surrounded by an import of useConfirmAction.
      const matches = stripped.match(/\bconfirm\s*\(/g) ?? [];
      if (matches.length > 0) {
        expect(stripped).toMatch(/useConfirmAction/);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Defense-in-depth: admin shell does not read envelope.workspace.*
// (constitutional rule, only lib/platform-context may).
// ---------------------------------------------------------------------------

describe("Phase 8 — admin shell never reads envelope.workspace.* directly", () => {
  for (const file of ADMIN_FILES) {
    it(`${file} does not access envelope.workspace.*`, () => {
      const body = readWeb(file);
      // The hook surfaces (useWorkspaceFragment / usePersonalSpaceFragment)
      // are the only canonical readers. Direct envelope.workspace.<prop>
      // access is forbidden outside lib/platform-context.
      expect(body).not.toMatch(/envelope\.workspace\.[a-zA-Z_]/);
    });
  }
});
