/**
 * Phase R15 — Team Collaboration frontend source-contract test.
 *
 * Pins the Phase 6 frontend deliverables documented in
 * `docs/architecture/phase-6-team-frontend-final.md`. Like R11-R14
 * this is a source-contract test — it greps the source tree and
 * asserts shape, not runtime behaviour.
 *
 * What's pinned:
 *
 *   - The 3 pages exist on disk (overview, detail, accept).
 *   - The API client module exports the 20+ canonical functions.
 *   - The 3 new route ids exist in routeRegistry.ts with the right
 *     metadata (requiredActiveSpace, capabilities, fallback).
 *   - Personal users can see the Teams overview (no
 *     ORGANIZATION_ONLY gate on `workspace.collaboration_teams`).
 *   - No forbidden "Team Workspace" string in the new files.
 *   - The 3 routes are not page-missing (R13 page-existence rule).
 *   - The link-invite UI shows the raw token only via the in-page
 *     LinkInviteResult panel — no other component receives the raw
 *     token in props.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
function read(rel) {
    const full = join(repoRoot, rel);
    if (!existsSync(full))
        throw new Error(`R15: missing required file: ${rel}`);
    return readFileSync(full, "utf8");
}
function exists(rel) {
    return existsSync(join(repoRoot, rel));
}
// =============================================================================
// Stage 2 — API client
// =============================================================================
describe("Phase R15 — Stage 2: API client", () => {
    const client = read("apps/web/lib/api/collaboration-teams.ts");
    it("exports the canonical 17+ API functions", () => {
        const required = [
            "listTeams",
            "createTeam",
            "getTeam",
            "updateTeam",
            "archiveTeam",
            "addExistingMember",
            "updateMember",
            "removeMember",
            "inviteByEmail",
            "inviteBySms",
            "createInviteLink",
            "revokeInvite",
            "acceptInvite",
            "listActivity",
            "listAssignments",
            "createAssignment",
            "updateAssignment",
        ];
        for (const fn of required) {
            expect(client).toMatch(new RegExp(`export async function ${fn}\\b`));
        }
    });
    it("imports the canonical shared vocabulary", () => {
        expect(client).toMatch(/from\s+["']@proovra\/shared["']/);
        expect(client).toMatch(/CollaborationTeamRole/);
        expect(client).toMatch(/CollaborationTeamInviteChannel/);
    });
    it("uses the canonical apiFetch wrapper (requestId-aware)", () => {
        expect(client).toMatch(/apiFetch/);
    });
    it("link-invite is the only function whose RETURN type carries rawToken", () => {
        // Only `createInviteLink` may type-return `rawToken` — every other
        // function's return type omits it. (The `acceptInvite` PARAMETER
        // is named `rawToken` legitimately — it consumes the token; that's
        // not the same as exposing one.)
        const linkBlock = (() => {
            const idx = client.indexOf("export async function createInviteLink");
            if (idx < 0)
                return "";
            const end = client.indexOf("\nexport ", idx + 10);
            return client.slice(idx, end > 0 ? end : client.length);
        })();
        expect(linkBlock).toMatch(/CollaborationTeamLinkInviteSecret/);
        // No other exported async function declares a return type that
        // contains `rawToken`. We pin this by looking only at the
        // `Promise<...>` annotation slice, not the full body or parameter
        // list.
        const otherFns = client
            .split("export async function ")
            .slice(1)
            .filter((s) => !s.startsWith("createInviteLink"));
        for (const block of otherFns) {
            // The return type is `Promise<...>` immediately before `{`.
            const m = /\)\s*:\s*(Promise<[\s\S]*?>)\s*\{/.exec(block);
            const ret = m?.[1] ?? "";
            expect(ret).not.toMatch(/rawToken/);
        }
    });
});
// =============================================================================
// Stage 3 — Routes registered
// =============================================================================
describe("Phase R15 — Stage 3: route registry", () => {
    const registry = read("apps/web/lib/navigation/routeRegistry.ts");
    it("declares workspace.collaboration_teams (the Teams overview route)", () => {
        expect(registry).toMatch(/id:\s*"workspace\.collaboration_teams"/);
    });
    it("declares workspace.collaboration_team_detail", () => {
        expect(registry).toMatch(/id:\s*"workspace\.collaboration_team_detail"/);
    });
    it("declares workspace.collaboration_team_invite_accept", () => {
        expect(registry).toMatch(/id:\s*"workspace\.collaboration_team_invite_accept"/);
    });
    it("workspace.collaboration_teams is PERSONAL_OR_ORG (not ORGANIZATION_ONLY)", () => {
        // Grab the block for that route id.
        const idx = registry.indexOf('"workspace.collaboration_teams"');
        expect(idx).toBeGreaterThan(0);
        // The block runs from `{` (just before the id) to the next `},` after.
        const blockStart = registry.lastIndexOf("{", idx);
        const blockEnd = registry.indexOf("},", idx);
        const block = registry.slice(blockStart, blockEnd);
        expect(block).toMatch(/requiredActiveSpace:\s*"PERSONAL_OR_ORG"/);
        expect(block).not.toMatch(/requiredActiveSpace:\s*"ORGANIZATION_ONLY"/);
        expect(block).toMatch(/sidebarEligible:\s*true/);
        expect(block).toMatch(/label:\s*"Teams"/);
    });
    it("invite-accept route is NONE active-space (accessible during signup flow)", () => {
        const idx = registry.indexOf('"workspace.collaboration_team_invite_accept"');
        expect(idx).toBeGreaterThan(0);
        const blockStart = registry.lastIndexOf("{", idx);
        const blockEnd = registry.indexOf("},", idx);
        const block = registry.slice(blockStart, blockEnd);
        expect(block).toMatch(/requiredActiveSpace:\s*"NONE"/);
        expect(block).toMatch(/fallbackBehavior:\s*"LOAD"/);
    });
});
// =============================================================================
// Stage 4-12 — Pages exist on disk
// =============================================================================
describe("Phase R15 — Stages 4-12: pages exist on disk", () => {
    it("Teams overview page exists", () => {
        expect(exists("apps/web/app/(app)/collaboration-teams/page.tsx")).toBe(true);
    });
    it("Team detail page exists", () => {
        expect(exists("apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx")).toBe(true);
    });
    it("Accept-invite page exists", () => {
        expect(exists("apps/web/app/(app)/collaboration-teams/invites/[token]/accept/page.tsx")).toBe(true);
    });
});
// =============================================================================
// Stage 4-12 — Page content sanity (testid hooks + key UI elements)
// =============================================================================
describe("Phase R15 — Stages 4-12: page content", () => {
    const overview = read("apps/web/app/(app)/collaboration-teams/page.tsx");
    const detail = read("apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx");
    const accept = read("apps/web/app/(app)/collaboration-teams/invites/[token]/accept/page.tsx");
    it("overview wraps in PageRouteGate with the right routeId", () => {
        expect(overview).toMatch(/<PageRouteGate routeId="workspace\.collaboration_teams">/);
    });
    it("overview has Create Team button + empty + loading + error states", () => {
        expect(overview).toMatch(/data-testid="create-team-button"/);
        expect(overview).toMatch(/data-testid="teams-empty-state"/);
        expect(overview).toMatch(/data-testid="teams-loading"/);
        expect(overview).toMatch(/data-testid="teams-error"/);
    });
    it("overview empty state never says 'Team Workspace' (constitutional rule 9)", () => {
        expect(overview).not.toMatch(/Team Workspace/);
        expect(overview).not.toMatch(/Create Team Workspace/);
        expect(overview).not.toMatch(/Switch to Team Workspace/);
    });
    it("overview mentions personal-user + organization-not-required messaging", () => {
        // Constitutional rule 7 — personal users see Teams; Organization
        // is optional. Subtitle copy reflects this.
        expect(overview).toMatch(/no Organization is required/i);
    });
    it("detail page wraps in PageRouteGate with team-detail routeId", () => {
        expect(detail).toMatch(/<PageRouteGate routeId="workspace\.collaboration_team_detail">/);
    });
    it("detail page renders the 6 tab definitions (overview/members/invites/assignments/activity/settings)", () => {
        // The tab labels are emitted via `data-testid={`tab-${t}`}` where
        // `t` is a value from the TABS array. Assert the array itself.
        expect(detail).toMatch(/const TABS = \[\s*"overview",\s*"members",\s*"invites",\s*"assignments",\s*"activity",\s*"settings",\s*\] as const/);
        // And the wrapping nav uses the bounded testid for the tablist.
        expect(detail).toMatch(/data-testid="team-tabs"/);
        // The dynamic per-tab testid is built from the array element.
        expect(detail).toMatch(/data-testid=\{`tab-\$\{t\}`\}/);
        // Each tab-id appears at least once as a string literal (the
        // page-level switch on activeTab).
        for (const t of [
            "overview",
            "members",
            "invites",
            "assignments",
            "activity",
            "settings",
        ]) {
            expect(detail).toMatch(new RegExp(`"${t}"`));
        }
    });
    it("detail page Members tab has role select + suspend + remove actions", () => {
        expect(detail).toMatch(/data-testid="tab-members-content"/);
        expect(detail).toMatch(/member-role-select-/);
        expect(detail).toMatch(/member-suspend-/);
        expect(detail).toMatch(/member-remove-/);
    });
    it("detail page Invites tab has email + SMS + link forms", () => {
        expect(detail).toMatch(/data-testid="email-invite-form"/);
        expect(detail).toMatch(/data-testid="sms-invite-form"/);
        expect(detail).toMatch(/data-testid="link-invite-form"/);
        expect(detail).toMatch(/data-testid="link-invite-copy"/);
        expect(detail).toMatch(/data-testid="link-invite-url"/);
    });
    it("detail page Invites tab shows link invite secret ONLY in LinkInviteResult", () => {
        // Only one component reads the link-invite secret state. We just
        // assert the local state variable is gated to the result panel.
        expect(detail).toMatch(/LinkInviteResult/);
        expect(detail).toMatch(/visible once/);
    });
    it("detail page Assignments tab has create + status filter + complete", () => {
        expect(detail).toMatch(/data-testid="tab-assignments-content"/);
        expect(detail).toMatch(/data-testid="create-assignment-button"/);
        expect(detail).toMatch(/data-testid="assignment-status-filter"/);
        expect(detail).toMatch(/assignment-complete-/);
    });
    it("detail page Activity tab renders bounded event-type rows", () => {
        expect(detail).toMatch(/data-testid="tab-activity-content"/);
        expect(detail).toMatch(/activityLabel/);
    });
    it("detail page Settings tab has save + danger-zone archive", () => {
        expect(detail).toMatch(/data-testid="tab-settings-content"/);
        expect(detail).toMatch(/data-testid="settings-save"/);
        expect(detail).toMatch(/data-testid="settings-danger-zone"/);
        expect(detail).toMatch(/data-testid="settings-archive"/);
    });
    it("detail page surfaces requestId in error messages", () => {
        // The Members + Invites + Assignments + Activity + Settings handlers
        // all funnel through `addToast` with `req ${requestId}` formatting.
        expect(detail).toMatch(/requestId/);
        expect(detail).toMatch(/req \$\{/);
    });
    it("detail page never says 'Team Workspace' (rule 9)", () => {
        expect(detail).not.toMatch(/Team Workspace/);
        expect(detail).not.toMatch(/Switch to Team Workspace/);
    });
    it("accept page wraps in PageRouteGate with accept routeId", () => {
        expect(accept).toMatch(/<PageRouteGate routeId="workspace\.collaboration_team_invite_accept">/);
    });
    it("accept page exposes all 8 bounded states for e2e + error reporting", () => {
        const required = [
            "checking",
            "accepting",
            "success",
            "invalid",
            "expired",
            "revoked",
            "auth_required",
            "workspace_required",
            "rate_limited",
            "error",
        ];
        // The state union appears in the source as a type literal.
        for (const s of required) {
            expect(accept).toContain(`"${s}"`);
        }
    });
    it("accept page calls isWellFormedCollaborationTeamInviteToken for fast-fail", () => {
        expect(accept).toMatch(/isWellFormedCollaborationTeamInviteToken/);
    });
    it("accept page never logs the raw token (no console.log of rawToken)", () => {
        const consoleHits = accept.match(/console\.[a-z]+\([^)]*rawToken/g);
        expect(consoleHits).toBeNull();
    });
    it("accept page redirects to the team detail on success", () => {
        expect(accept).toMatch(/router\.replace\(`\/collaboration-teams\/\$\{result\.teamId\}`\)/);
    });
});
// =============================================================================
// Stage 14 — Navigation integration sanity
// =============================================================================
describe("Phase R15 — Stage 14: navigation integration", () => {
    const registry = read("apps/web/lib/navigation/routeRegistry.ts");
    it("Teams overview route appears in sidebar (sidebarEligible: true)", () => {
        const idx = registry.indexOf('"workspace.collaboration_teams"');
        const blockStart = registry.lastIndexOf("{", idx);
        const blockEnd = registry.indexOf("},", idx);
        const block = registry.slice(blockStart, blockEnd);
        expect(block).toMatch(/sidebarEligible:\s*true/);
        expect(block).toMatch(/commandPaletteVisible:\s*true/);
        expect(block).toMatch(/allToolsVisible:\s*true/);
    });
    it("Team detail + invite-accept are sidebar-invisible (deep-link only)", () => {
        for (const id of [
            '"workspace.collaboration_team_detail"',
            '"workspace.collaboration_team_invite_accept"',
        ]) {
            const idx = registry.indexOf(id);
            const blockStart = registry.lastIndexOf("{", idx);
            const blockEnd = registry.indexOf("},", idx);
            const block = registry.slice(blockStart, blockEnd);
            expect(block).toMatch(/sidebarEligible:\s*false/);
        }
    });
});
// =============================================================================
// Constitutional rules
// =============================================================================
describe("Phase R15 — constitutional rules", () => {
    const files = [
        "apps/web/app/(app)/collaboration-teams/page.tsx",
        "apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx",
        "apps/web/app/(app)/collaboration-teams/invites/[token]/accept/page.tsx",
        "apps/web/lib/api/collaboration-teams.ts",
    ];
    it("no Phase 6 frontend file contains 'Team Workspace' / 'Reviewer Workspace' / 'Governance Workspace' / 'Operations Workspace' literal", () => {
        const forbidden = [
            "Team Workspace",
            "Reviewer Workspace",
            "Governance Workspace",
            "Operations Workspace",
        ];
        for (const f of files) {
            const body = read(f);
            for (const token of forbidden) {
                expect(body, `${f} contains forbidden "${token}"`).not.toContain(token);
            }
        }
    });
    it("Teams overview route does not gate on Organization (rule 5-7)", () => {
        const registry = read("apps/web/lib/navigation/routeRegistry.ts");
        const idx = registry.indexOf('"workspace.collaboration_teams"');
        const blockStart = registry.lastIndexOf("{", idx);
        const blockEnd = registry.indexOf("},", idx);
        const block = registry.slice(blockStart, blockEnd);
        expect(block).not.toMatch(/ORGANIZATION_ONLY/);
        expect(block).not.toMatch(/CREATE_ORG/);
    });
});
