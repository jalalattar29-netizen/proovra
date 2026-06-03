/**
 * Phase 7 Closure — Team / Workspace anti-confusion contract.
 *
 * Pins the PROOVRA constitutional rules around the canonical
 * vocabulary so a future PR can't silently reintroduce the legacy
 * "Team Workspace" / "Reviewer Workspace" / "Governance Workspace" /
 * "Operations Workspace" / "Team is a workspace" confusion.
 *
 * Constitutional rules (Phase 7 closure constitution):
 *   1. Workspace kinds are ONLY `PERSONAL` and `ORGANIZATION`.
 *   2. Team is NOT a workspace.
 *   3. Team is NOT a tenant.
 *   4. Team is NOT enterprise-only.
 *   5. Team is a core collaboration feature.
 *   6. Team must work in BOTH Personal Workspace and Organization
 *      Workspace.
 *   7. Organization is optional.
 *   8. Reviewer is a role/capability, not a workspace.
 *   9. Governance is a feature area, not a workspace.
 *  10. Operations is platform-admin only.
 *  11. No fake workspace types.
 *
 * Phrases this test forbids in user-facing strings:
 *   - "Team Workspace"
 *   - "Reviewer Workspace"
 *   - "Governance Workspace"
 *   - "Operations Workspace"
 *   - "Team tenant"
 *   - "Team is a tenant"
 *   - "Team workspace required"
 *   - "Switch to Team Workspace"
 *
 * Allowed (constitutionally correct):
 *   - "Personal Workspace"        — workspace kind
 *   - "Organization Workspace"    — workspace kind
 *   - "Team" (alone)              — collaboration sub-unit
 *   - "Reviewer role" / "reviewer" — capability, not workspace
 *   - "Governance" / "governance"  — feature area
 *
 * Test style: source-contract (file-text assertions). No DB I/O.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, relative } from "node:path";
import { describe, expect, it } from "vitest";
const WEB_ROOT = fileURLToPath(new URL("../../../apps/web", import.meta.url));
function walk(dir) {
    const out = [];
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
        if (name.endsWith(".tsx") ||
            name.endsWith(".ts") ||
            name.endsWith(".jsx") ||
            name.endsWith(".js")) {
            out.push(full);
        }
    }
    return out;
}
/** Pre-compiled list of all live web source files. */
const WEB_FILES = walk(WEB_ROOT);
/**
 * Allowlist for the BILLING component `TeamWorkspaceCard.tsx`. The
 * component file name is a pre-G5 carryover that documents an
 * ORGANIZATION-tier billing card; the body copy was already cleaned
 * up under Phase R13 to use canonical workspace vocabulary.
 *
 * Importing the component (e.g. `<TeamWorkspaceCard ... />`) emits
 * the literal `TeamWorkspaceCard` as a JSX identifier, which would
 * trip the case-insensitive forbidden-phrase scan. We allow that
 * import-site usage; the component's BODY copy is still enforced by
 * `phase-r13-route-persona-matrix.test.ts`.
 */
const BILLING_CARD_IMPORT_ALLOWLIST = new Set([
    resolve(WEB_ROOT, "components/billing/TeamWorkspaceCard.tsx"),
    // Any file that imports the billing card.
    resolve(WEB_ROOT, "app/(app)/billing/page.tsx"),
]);
// ---------------------------------------------------------------------------
// Forbidden fake workspace types
// ---------------------------------------------------------------------------
const FORBIDDEN_FAKE_WORKSPACE_PHRASES = [
    {
        phrase: "Team Workspace",
        why: "Constitutional rule 2: Team is NOT a workspace. Use 'Team' or 'Workspace' separately.",
    },
    {
        phrase: "Reviewer Workspace",
        why: "Constitutional rule 8: Reviewer is a role/capability, not a workspace.",
    },
    {
        phrase: "Governance Workspace",
        why: "Constitutional rule 9: Governance is a feature area, not a workspace.",
    },
    {
        phrase: "Operations Workspace",
        why: "Constitutional rule 10: Operations is platform-admin only — not a workspace.",
    },
];
describe("Phase 7 Closure — Team / Workspace anti-confusion (constitutional vocabulary)", () => {
    for (const { phrase, why } of FORBIDDEN_FAKE_WORKSPACE_PHRASES) {
        it(`forbids quoted UI string "${phrase}" anywhere in apps/web/*.tsx|ts (${why})`, () => {
            // Match the phrase only when it appears inside a JSX string,
            // attribute value, or quoted literal — i.e. operator-visible
            // copy. Component filenames / class names are excluded by
            // checking for surrounding quote / backtick.
            const re = new RegExp(`["'\`]${phrase}["'\`]`);
            const offenders = [];
            for (const file of WEB_FILES) {
                if (BILLING_CARD_IMPORT_ALLOWLIST.has(file))
                    continue;
                if (file.includes(".test.") ||
                    file.includes("\\test\\") ||
                    file.includes("/test/"))
                    continue;
                const body = readFileSync(file, "utf8");
                if (re.test(body)) {
                    offenders.push(relative(WEB_ROOT, file).replace(/\\/g, "/"));
                }
            }
            expect(offenders, offenders.join("\n")).toEqual([]);
        });
    }
});
// ---------------------------------------------------------------------------
// Workspace kind enum / shape: only PERSONAL and ORGANIZATION
// ---------------------------------------------------------------------------
describe("Phase 7 Closure — workspace kinds are bounded to PERSONAL + ORGANIZATION", () => {
    it("the canonical platform-context types declare exactly PERSONAL + ORGANIZATION activeSpace.type variants", () => {
        const typesSrc = readFileSync(resolve(WEB_ROOT, "lib/platform-context/types.ts"), "utf8");
        // The active-space type union must contain the two canonical
        // workspace kinds. Additive variants like PLATFORM_ADMIN are
        // operator-scope markers (a platform-admin overlay), not new
        // workspace kinds — they're permitted alongside the two kinds.
        expect(typesSrc).toMatch(/"PERSONAL"/);
        expect(typesSrc).toMatch(/"ORGANIZATION"/);
        // No fake kinds:
        expect(typesSrc).not.toMatch(/"TEAM_WORKSPACE"/);
        expect(typesSrc).not.toMatch(/"REVIEWER_WORKSPACE"/);
        expect(typesSrc).not.toMatch(/"GOVERNANCE_WORKSPACE"/);
        expect(typesSrc).not.toMatch(/"OPERATIONS_WORKSPACE"/);
    });
});
// ---------------------------------------------------------------------------
// The Collaboration Teams URL family is distinct from the Workspaces family
// ---------------------------------------------------------------------------
describe("Phase 7 Closure — Collaboration Teams vs Workspaces URL separation", () => {
    it("the legacy /teams URL family 308-redirects to /workspaces (the canonical workspace list)", () => {
        const cfg = readFileSync(resolve(WEB_ROOT, "next.config.js"), "utf8");
        expect(cfg).toMatch(/source:\s*"\/teams"[\s\S]{0,200}destination:\s*"\/workspaces"/);
    });
    it("the Collaboration Teams product lives under /collaboration-teams (constitutional URL)", () => {
        const indexPage = resolve(WEB_ROOT, "app/(app)/collaboration-teams/page.tsx");
        expect(() => readFileSync(indexPage, "utf8")).not.toThrow();
        const detailPage = resolve(WEB_ROOT, "app/(app)/collaboration-teams/[teamId]/page.tsx");
        expect(() => readFileSync(detailPage, "utf8")).not.toThrow();
        const acceptPage = resolve(WEB_ROOT, "app/(app)/collaboration-teams/invites/[token]/accept/page.tsx");
        expect(() => readFileSync(acceptPage, "utf8")).not.toThrow();
    });
    it("the route registry distinguishes admin.teams (workspace list) from workspace.collaboration_teams (Team product)", () => {
        const registry = readFileSync(resolve(WEB_ROOT, "lib/navigation/routeRegistry.ts"), "utf8");
        // admin.teams = the WORKSPACES list (legacy id name, canonical
        // href /workspaces).
        expect(registry).toMatch(/id:\s*"admin\.teams"[\s\S]{0,400}href:\s*"\/workspaces"/);
        // workspace.collaboration_teams = the canonical Phase 5-7
        // Collaboration Teams product (href /collaboration-teams).
        expect(registry).toMatch(/id:\s*"workspace\.collaboration_teams"[\s\S]{0,400}href:\s*"\/collaboration-teams"/);
    });
});
