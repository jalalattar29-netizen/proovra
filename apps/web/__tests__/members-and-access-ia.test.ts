/**
 * MEMBERS & ACCESS ↔ COLLABORATION TEAMS — the product IA, pinned.
 *
 * ===========================================================================
 * THE MODEL A FIRST-TIME OPERATOR HAS TO GRASP WITHOUT DOCUMENTATION
 * ===========================================================================
 *
 *   Members & Access      decides WHO can reach this workspace
 *   Collaboration Teams   decides HOW those members work together
 *
 * The two surfaces used to read as unrelated product areas: one was called
 * "People" (a population, not a job) and the other "Teams" (the most
 * overloaded word in the navigation — it sat beside "Workspaces", which the
 * legacy `Team` model actually backs). Neither said what it was for, and
 * nothing linked them.
 *
 * These are source-level contracts, deliberately. They pin the vocabulary and
 * the reciprocal links; they do not re-test the membership, invitation or
 * Collaboration Team authorities, which are unchanged and proven elsewhere.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const WEB = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(WEB, p), "utf8");

const REGISTRY = "lib/navigation/routeRegistry.ts";
const MEMBERS_PAGE = "app/(app)/teams/[id]/page.tsx";
const TEAMS_PAGE = "app/(app)/collaboration-teams/page.tsx";
const LOCATOR = "lib/navigation/workspacePeopleLocator.ts";

test("the workspace membership surface is named 'Members & Access'", () => {
  const registry = read(REGISTRY);
  const entry = registry.slice(
    registry.indexOf('id: "workspace.people"'),
    registry.indexOf('id: "workspace.people"') + 2000,
  );
  assert.match(entry, /label: "Members & Access"/);
  // "People" named a population and not a job. It must not come back as the
  // label for THIS surface.
  assert.doesNotMatch(entry, /label: "People"/);
});

test("the platform-wide roster is NOT renamed — it is a different concept", () => {
  /*
   * `platform.users` (/admin/users) lists every person on the PLATFORM. It is
   * not the workspace membership surface, and renaming it would be exactly the
   * blind find-and-replace this reconciliation is supposed to avoid.
   */
  const registry = read(REGISTRY);
  const entry = registry.slice(
    registry.indexOf('id: "platform.users"'),
    registry.indexOf('id: "platform.users"') + 800,
  );
  assert.match(entry, /label: "People"/);
});

test("'Teams' is disambiguated to 'Collaboration Teams' in navigation", () => {
  const registry = read(REGISTRY);
  const entry = registry.slice(
    registry.indexOf('id: "workspace.collaboration_teams"'),
    registry.indexOf('id: "workspace.collaboration_teams"') + 1600,
  );
  assert.match(entry, /label: "Collaboration Teams"/);
});

test("the route stays /people — the rename is a product name, not a URL change", () => {
  /*
   * Renaming the URL for label consistency buys nothing and costs redirects,
   * dead bookmarks, analytics fragmentation and test churn. The locator is the
   * single definition of the path, which is what would make a future rename a
   * one-file change if it ever became worth doing.
   */
  assert.match(read(LOCATOR), /WORKSPACE_PEOPLE_PATH\s*=\s*"\/people"/);
  const registry = read(REGISTRY);
  const entry = registry.slice(
    registry.indexOf('id: "workspace.people"'),
    registry.indexOf('id: "workspace.people"') + 2000,
  );
  assert.match(entry, /href: "\/people"/);
});

test("Members & Access says what it decides, and names the other surface", () => {
  const page = read(MEMBERS_PAGE);
  assert.match(page, /<h1 className="app-page-header__title">Members &amp; Access<\/h1>/);
  // The purpose line answers "what does this page govern?" rather than only
  // naming the reader's role.
  assert.match(page, /Who can access \{team\.name\}/);
});

test("Members & Access links contextually to Collaboration Teams", () => {
  const page = read(MEMBERS_PAGE);
  assert.match(page, /data-testid="people-to-collaboration-teams"/);
  assert.match(page, /href="\/collaboration-teams"/);
  // A contextual bridge, NOT a second front door: the secondary action class,
  // never the page-primary one.
  const bridge = page.slice(
    page.indexOf('data-testid="people-collaboration-bridge"'),
    page.indexOf('data-testid="people-to-collaboration-teams"') + 200,
  );
  assert.match(bridge, /app-secondary-action/);
  assert.doesNotMatch(bridge, /app-primary-action/);
  // And it teaches the architecture: teams group members who already have
  // access, they do not grant it.
  assert.match(bridge, /do not grant it/);
});

test("Collaboration Teams links back to Members & Access", () => {
  const page = read(TEAMS_PAGE);
  assert.match(page, /data-testid="teams-to-members-and-access"/);
  // Through the canonical locator, not a hand-written path.
  assert.match(page, /href=\{WORKSPACE_PEOPLE_PATH\}/);
  assert.match(page, /WORKSPACE_PEOPLE_PATH \} from ".*workspacePeopleLocator"/);
});

test("Collaboration Teams states that it groups EXISTING members", () => {
  const page = read(TEAMS_PAGE);
  assert.match(page, /<h1 className="app-page-header__title">Collaboration Teams<\/h1>/);
  // The distinction in three words: "members who already have access".
  assert.match(page, /already have access/);
  assert.match(page, /they do not grant it/);
});

test("no CollaborationTeamInvite writer was restored by this reconciliation", () => {
  /*
   * The retired invitation authority stays retired. A Collaboration Team must
   * never mint its own invitation: a person becomes eligible for a team by
   * being a WORKSPACE member first, through the canonical workspace invitation.
   */
  const page = read(TEAMS_PAGE);
  assert.doesNotMatch(page, /collaborationTeamInvite\.(create|upsert)/);
  const members = read(MEMBERS_PAGE);
  assert.doesNotMatch(members, /collaborationTeamInvite\.(create|upsert)/);
});
