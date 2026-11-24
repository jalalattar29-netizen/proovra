/**
 * Team remediation T-121 (ARCH-13, MEM-10) — ONE name for each thing.
 *
 *   - "Team" alone means the PLAN (Team plan) and nothing else;
 *   - groups of workspace members are "Collaboration Teams", every time;
 *   - the workspace people page is "Members & Access".
 *
 * A label inventory over the surfaces this remediation owns: every piece of
 * user-visible text (JSX text and string literals that read as words) is
 * collected and any bare "Team"/"Teams"/"team"/"teams" that is not part of
 * "Collaboration Team(s)" or "Team plan" fails, with the file and the text.
 * Navigation labels live in lib/navigation/routeRegistry.ts, which another
 * stage owns; they are not inventoried here.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const OWNED_SURFACES = [
  "app/(app)/teams/[id]/page.tsx",
  "app/(app)/teams/[id]/components/MemberRemovalDialog.tsx",
  "app/(app)/teams/[id]/components/WorkspaceMembersPanel.tsx",
  "app/(app)/collaboration-teams/page.tsx",
  "app/(app)/collaboration-teams/[teamId]/_tabs/MembersTab.tsx",
  "app/(app)/collaboration-teams/invites/[token]/accept/page.tsx",
  "components/reviewer-experience/ReviewerPickerModal.tsx",
  "app/(app)/reviewer-ops/[reviewId]/_components/InspectorDialogs.tsx",
  "lib/members/placement.ts",
  "lib/members/membership-disclosures.ts",
];

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/** Text a person can read: JSX text nodes and word-like string literals. */
export function userVisibleTexts(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  // JSX text between a closing ">" and the next "<" (or "{").
  for (const m of code.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)(?=[<{])/g)) {
    const text = m[1]!.replace(/\s+/g, " ").trim();
    // Skip TypeScript generics / comparisons that happen to sit between > and <.
    if (text && !/[;=()]|=>|&&|\|\|/.test(text)) out.push(text);
  }
  // String and template literals that read as words: a space, or a capital.
  for (const m of code.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    const text = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!text || text.startsWith("/") || text.startsWith(".")) continue;
    if (/^[a-z0-9_.:\-[\]@/]+$/.test(text)) continue; // ids, test ids, paths, enums
    if (/^[A-Z0-9_]+$/.test(text)) continue; // ENUM_CODES
    if (!/\s/.test(text) && !/^[A-Z][a-z]/.test(text)) continue;
    out.push(text);
  }
  return out;
}

/**
 * A bare "Team" that names a group or the people page (not the plan).
 *
 *   - "Collaboration Team(s)" and "Team plan" are the canonical names;
 *   - "review team" is the T-097 placement wording (register T-097: "Add
 *     <name> to a review team first", "Add to a review team now"), always
 *     beside a link into Collaboration Teams;
 *   - a capitalised "Team"/"Teams" anywhere else is a stray name;
 *   - a lowercase "team" is allowed only as a back-reference inside a full
 *     sentence ("Added to this team.") on a surface that already named the
 *     group; a LABEL (no closing punctuation: headings, buttons, options,
 *     aria labels, placeholders) must use the full name.
 */
export function strayTeamWord(text: string): boolean {
  const rest = text
    .replace(/Collaboration Teams?/g, "")
    .replace(/collaboration teams?/gi, "")
    .replace(/\bTeam plan\b/g, "")
    .replace(/\breview teams?\b/g, "")
    .replace(/\$\{[^}]*\}/g, " ");
  if (/\bTeams?\b/.test(rest)) return true;
  if (!/\bteams?\b/.test(rest)) return false;
  const isSentence = /[.?!]["”’)]?$/.test(text.trim()) || /[.?!] [A-Z]/.test(text);
  return !isSentence;
}

test("the inventory helpers catch a bare group 'Team' and accept the canonical names", () => {
  assert.equal(strayTeamWord("Create team"), true);
  assert.equal(strayTeamWord("No teams yet"), true);
  assert.equal(strayTeamWord("Team"), true);
  assert.equal(strayTeamWord("Create Collaboration Team"), false);
  assert.equal(strayTeamWord("Upgrade to the Team plan"), false);
  assert.deepEqual(userVisibleTexts(`<th scope="col">Team</th>`).includes("Team"), true);
  assert.deepEqual(userVisibleTexts(`const x = "team-invite-retired";`), []);
});

test("owned surfaces never call a group or the members page a bare 'Team'", () => {
  const offenders: string[] = [];
  for (const rel of OWNED_SURFACES) {
    const src = readFileSync(resolve(webRoot, rel), "utf8");
    for (const text of userVisibleTexts(src)) {
      if (strayTeamWord(text)) offenders.push(`${rel}: ${JSON.stringify(text)}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the people page is titled Members & Access", () => {
  const src = readFileSync(resolve(webRoot, "app/(app)/teams/[id]/page.tsx"), "utf8");
  const titles = [...stripComments(src).matchAll(/app-page-header__title">([^<]+)</g)].map((m) => m[1]!.trim());
  assert.ok(titles.length > 0);
  for (const t of titles) assert.equal(t, "Members &amp; Access");
});
