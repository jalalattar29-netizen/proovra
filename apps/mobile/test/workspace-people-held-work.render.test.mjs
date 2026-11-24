/**
 * Team remediation — Members & Access (workspace-people) on mobile.
 *
 *   T-097  the invite flow states the placement prerequisite: outside
 *          Enterprise a new member must be in a Collaboration Team before they
 *          can be assigned or claim work, with the way to the Teams screen.
 *   T-099  a role change is confirmed first with what it does to held work,
 *          read from GET …/members/:memberId/role-change-impact?role=; the
 *          PATCH runs only on the explicit confirm.
 *   T-101  "Remove" shows held reviews (in progress), held escalations, case
 *          assignments and restricted-case grants from the extended
 *          removal-impact; an older server without them is not called zero.
 *
 * Server shapes: teams.routes.ts removal-impact / role-change-impact (stage E).
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes;
let envelope;
let removalImpact;
let roleImpact;

const MEMBERS = () => [
  { id: "m-own", userId: "u-own", role: "OWNER", status: "ACTIVE", user: { displayName: "Owner" } },
  { id: "m-self", userId: "user-1", role: "ADMIN", status: "ACTIVE", user: { displayName: "Test Operator" } },
  { id: "m-dana", userId: "u-dana", role: "MEMBER", status: "ACTIVE", user: { displayName: "Dana" } },
];

const TEAM_ENVELOPE = () =>
  platformContextEnvelope({
    activeSpace: { id: "team-1", type: "PERSONAL", plan: "TEAM", displayName: "Personal Space", roleLabel: "Owner", status: "active", shared: false },
    planFeatures: { teamCollaborationIncluded: true },
    flags: { isEnterpriseWorkspace: false },
  });

before(async () => {
  M = await loadModule("app/(stack)/workspace-people.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  envelope = TEAM_ENVELOPE();
  removalImpact = {
    member: { memberId: "m-dana", userId: "u-dana", role: "MEMBER" },
    impact: {
      ownedEvidence: 0,
      ownedCases: 0,
      openAssignments: 1,
      caseAssignments: 1,
      heldReviews: 2,
      heldReviewsInProgress: 1,
      heldEscalations: 3,
      restrictedCaseGrants: 4,
      heldWork: { reviewWorkflows: 2, reviewsInProgress: 1, escalations: 3, teamTasks: 0, qcSamples: 0 },
      requiresTransfer: false,
    },
    eligibleTransferTargets: [],
  };
  roleImpact = {
    member: { memberId: "m-dana", userId: "u-dana", role: "MEMBER" },
    newRole: "VIEWER",
    impact: {
      releasesHeldWork: true,
      heldReviews: 2,
      heldReviewsInProgress: 1,
      heldEscalations: 1,
      heldWork: { reviewWorkflows: 2, reviewsInProgress: 1, escalations: 1, teamTasks: 0 },
      caseAssignmentsEnded: 1,
    },
  };
  routes = {
    ...authenticatedRoutes({ "/v1/platform/context": () => envelope }),
    "/v1/teams/team-1/members/m-dana/removal-impact": () => removalImpact,
    "/v1/teams/team-1/members/m-dana/role-change-impact": () => roleImpact,
    "/v1/teams/team-1/members/m-dana": () => ({}),
    "/v1/teams/team-1/members": () => ({ members: MEMBERS(), nextCursor: null, total: 3 }),
    "/v1/teams/team-1/invites": () => ({ invites: [] }),
    "/v1/teams/team-1/cases": () => ({ items: [] }),
    "/v1/teams/team-1/activity": () => ({ activities: [] }),
    "/v1/teams/team-1/closure": () => ({}),
    "/v1/teams/team-1": () => ({ id: "team-1", name: "Acme", canManageMembers: true, stats: { memberCount: 3 } }),
    "/v1/me/inbox/summary": () => ({ unread: 0 }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    requests.push({ path, method, body: init.body ? JSON.parse(init.body) : null });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](method) : undefined;
    if (res === undefined) return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: 404, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(res), { status: 200, headers: { "content-type": "application/json" } });
  };
  M.calls.reset();
  await signIn(M);
});
const settle = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};
const has = (r, start) => r.texts().some((t) => t.includes(start));

test("T-097: the invite sheet states the Collaboration Team prerequisite and opens the Teams screen", async () => {
  const r = await render();
  await r.press("Invite person");
  await settle();
  assert.ok(
    has(r, "Before a new member can be assigned work or claim reviews, add them to a Collaboration Team."),
    "the invite flow does not mention the placement prerequisite",
  );
  await r.press("Open Collaboration Teams");
  assert.equal(M.calls.push.at(-1), "/(tabs)/teams");
});

test("T-097: Enterprise workspaces are not told the placement rule (it does not apply there)", async () => {
  envelope = platformContextEnvelope({ planFeatures: { teamCollaborationIncluded: true }, flags: { isEnterpriseWorkspace: true } });
  const r = await render();
  await r.press("Invite person");
  await settle();
  assert.equal(has(r, "add them to a Collaboration Team"), false);
});

test("T-099: a role change is confirmed with the held work it releases; PATCH only on confirm", async () => {
  const r = await render();
  await r.press("Dana");
  await settle();
  await r.press("Viewer");
  await settle();
  const read = requests.find((q) => q.path.startsWith("/v1/teams/team-1/members/m-dana/role-change-impact"));
  assert.ok(read, "the role-change impact was never read");
  assert.match(read.path, /\?role=VIEWER$/);
  assert.equal(requests.some((q) => q.method === "PATCH"), false, "the role changed before any confirmation");
  assert.ok(
    has(r, "2 held reviews (1 in progress) · 1 held escalation · 1 case assignment ends"),
    "the confirmation does not state the counts",
  );
  await r.press("Make Viewer");
  await settle();
  const patch = requests.find((q) => q.method === "PATCH");
  assert.equal(patch?.path, "/v1/teams/team-1/members/m-dana");
});

test("T-099: an older server without the impact read is said, not presented as nothing", async () => {
  // An older server has no such route: answer 404 with the error envelope.
  routes["/v1/teams/team-1/members/m-dana/role-change-impact"] = () => undefined;
  const r = await render();
  await r.press("Dana");
  await settle();
  await r.press("Viewer");
  await settle();
  assert.ok(has(r, "could not be checked"), "a failed impact read was silent");
});

test("T-101: removal shows held reviews, escalations, case assignments and restricted grants", async () => {
  const r = await render();
  await r.press("Remove Dana");
  await settle();
  assert.ok(
    has(r, "2 held reviews (1 in progress) · 3 held escalations · 1 case assignment · 4 restricted-case grants"),
    "the removal does not disclose the work it releases",
  );
});

test("T-101: an older removal-impact without the fields is not reported as zero held work", async () => {
  removalImpact = {
    ...removalImpact,
    impact: { ownedEvidence: 0, ownedCases: 0, openAssignments: 1, requiresTransfer: false },
  };
  const r = await render();
  await r.press("Remove Dana");
  await settle();
  assert.ok(has(r, "Open assignments 1"));
  assert.equal(has(r, "held review"), false, "absent fields were rendered as counts");
});
