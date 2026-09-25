/**
 * GUARD — native collaboration list projection (Master Program §15, N4).
 * Parses GET /v1/collaboration-teams { teams, nextCursor } defensively and builds
 * honest display strings. Pure module → transpile-and-import (stub humanizeEnum).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The generated enum module, inlined as a data URL.
 *
 * collaboration.ts imports the canonical assignment / role / type vocabularies
 * from ./domain-enums.generated rather than retyping them. A data-URL module
 * cannot resolve a relative specifier, so the real generated file is compiled
 * and substituted — the values under test are still the generated ones, not a
 * stub, which is the whole point of generating them.
 */
const ENUMS_URL =
  "data:text/javascript," +
  encodeURIComponent(
    ts.transpileModule(
      readFileSync(resolve(HERE, "../src/product/domain-enums.generated.ts"), "utf8"),
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
    ).outputText,
  );

const src = readFileSync(resolve(HERE, "../src/product/collaboration.ts"), "utf8")
  .replace(
    /^import \{ humanizeEnum \}.*$/m,
    "function humanizeEnum(v){return v.charAt(0)+v.slice(1).toLowerCase();}",
  )
  .replace(/^import type \{ ProovraStatusTone \}.*$/m, "")
  .replace(/from "\.\/domain-enums\.generated"/g, `from "${ENUMS_URL}"`);

const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);

test("parses only valid team rows from the envelope", () => {
  const data = {
    teams: [
      { id: "t1", name: "Field Ops", memberCount: 3, pendingInviteCount: 1, viewerRole: "OWNER" },
      { id: null, name: "bad" }, // invalid id → dropped
      { name: "no id" }, // dropped
    ],
    nextCursor: "c2",
  };
  const rows = mod.parseCollaborationTeams(data);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "t1");
  assert.equal(mod.parseCollaborationNextCursor(data), "c2");
});

test("empty / garbage envelopes fail safely", () => {
  assert.deepEqual(mod.parseCollaborationTeams(null), []);
  assert.deepEqual(mod.parseCollaborationTeams({}), []);
  assert.equal(mod.parseCollaborationNextCursor({}), null);
});

test("subtitle pluralizes and omits the pending clause when zero", () => {
  assert.equal(mod.collaborationTeamSubtitle({ id: "t", name: "n", memberCount: 1, pendingInviteCount: 0 }), "1 member");
  // Retired group invitations are not a clause (web collaboration-teams/page.tsx:906).
  assert.equal(mod.collaborationTeamSubtitle({ id: "t", name: "n", memberCount: 4, pendingInviteCount: 2 }), "4 members");
  assert.equal(mod.collaborationTeamSubtitle({ id: "t", name: "n" }), "0 members");
});

test("role label humanizes, null when absent", () => {
  assert.equal(mod.collaborationRoleLabel("OWNER"), "Owner");
  assert.equal(mod.collaborationRoleLabel(null), null);
});

test("parseCollaborationTeamDetail reads members + invites, drops malformed", () => {
  const detail = mod.parseCollaborationTeamDetail({
    team: {
      id: "t1",
      name: "Field Ops",
      description: "Site team",
      status: "ACTIVE",
      viewerRole: "LEAD",
      activeMemberCount: 2,
      pendingInviteCount: 1,
      members: [
        { id: "m1", role: "LEAD", status: "ACTIVE", user: { id: "u1", email: "a@x.com", displayName: "Alice" } },
        { id: "m2", role: "MEMBER", status: "ACTIVE", user: { id: "u2", email: null, displayName: null } },
        { role: "MEMBER" }, // no id → dropped
      ],
      invites: [{ id: "i1", email: "new@x.com", role: "MEMBER", status: "PENDING" }],
    },
  });
  assert.equal(detail.name, "Field Ops");
  assert.equal(detail.members.length, 2);
  assert.equal(detail.members[0].displayName, "Alice");
  assert.equal(detail.members[1].displayName, "Member"); // no name/email → fallback
  assert.equal(detail.invites.length, 1);
  assert.equal(detail.viewerRole, "LEAD");
});

test("parseCollaborationTeamDetail returns null for a missing team", () => {
  assert.equal(mod.parseCollaborationTeamDetail(null), null);
  assert.equal(mod.parseCollaborationTeamDetail({ team: { id: "x" } }), null); // no name
});

/* ------------------------------------------------- entitlement and creation */

/**
 * The client computes NO capacity. The entitlement envelope decides, and the
 * web console's own comment records what happens otherwise: a user who "saw
 * '1 of 2', got an enabled Create button, and met a 409".
 */
test("the create affordance comes from the server, never from the counts", () => {
  // Counts that look like room to spare, but the server says no.
  const e = mod.parseCollaborationEntitlement({
    canCreateCollaborationTeam: false,
    collaborationTeams: { used: 1, limit: 2 },
    exceededDimensions: [],
  });
  assert.equal(e.canCreate, false);
  assert.ok(mod.createDisabledReason(e));

  // And counts that look full, but the server says yes.
  const ok = mod.parseCollaborationEntitlement({
    canCreateCollaborationTeam: true,
    collaborationTeams: { used: 2, limit: 2 },
  });
  assert.equal(ok.canCreate, true);
  assert.equal(mod.createDisabledReason(ok), null);
});

test("a refusal is explained from the dimension the server named", () => {
  const overTeams = mod.parseCollaborationEntitlement({
    canCreateCollaborationTeam: false,
    collaborationTeams: { used: 5, limit: 5 },
    exceededDimensions: ["COLLABORATION_TEAMS"],
  });
  assert.match(mod.createDisabledReason(overTeams), /allows up to 5 active Teams. Upgrade to add more./);

  const overSeats = mod.parseCollaborationEntitlement({
    canCreateCollaborationTeam: false,
    exceededDimensions: ["WORKSPACE_SEATS"],
  });
  assert.match(mod.createDisabledReason(overSeats), /seat allowance/);

  const locked = mod.parseCollaborationEntitlement({
    canCreateCollaborationTeam: false,
    featureIncluded: false,
  });
  assert.equal(mod.createDisabledReason(locked), "Teams are available on Pro, Team, and Enterprise plans.");
  const restricted = mod.parseCollaborationEntitlement({ canCreateCollaborationTeam: false, featureIncluded: true, mutationsAllowed: false });
  assert.match(mod.createDisabledReason(restricted), /billing needs attention/);

  // No stated reason still gets an honest sentence rather than silence.
  const unknown = mod.parseCollaborationEntitlement({ canCreateCollaborationTeam: false });
  assert.ok(mod.createDisabledReason(unknown).length > 0);
});

test("a plan with no published limit is not a limit of zero", () => {
  const e = mod.parseCollaborationEntitlement({ canCreateCollaborationTeam: true });
  assert.equal(e.teamsLimit, null);
  assert.equal(e.teamsUsed, null);
});

test("the create body matches the route's schema and drops what it must", () => {
  assert.deepEqual(mod.buildCreateTeamBody("  Roof claims  ", "LEGAL"), {
    name: "Roof claims",
    teamType: "LEGAL",
  });
  // An empty description is omitted, not sent as "".
  assert.deepEqual(mod.buildCreateTeamBody("A", "GENERAL", "   "), {
    name: "A",
    teamType: "GENERAL",
  });
  assert.equal(mod.buildCreateTeamBody("A", "GENERAL", "why").description, "why");
});

test("the name bounds are the route's", () => {
  assert.equal(mod.isValidTeamName(""), false);
  assert.equal(mod.isValidTeamName("   "), false);
  assert.equal(mod.isValidTeamName("a"), true);
  assert.equal(mod.isValidTeamName("x".repeat(120)), true);
  assert.equal(mod.isValidTeamName("x".repeat(121)), false);
});

test("the team types are the route's enum, exactly", () => {
  assert.deepEqual(
    [...mod.COLLABORATION_TEAM_TYPES],
    ["GENERAL", "INVESTIGATION", "LEGAL", "REVIEW", "COMPLIANCE"],
  );
});

/* ------------------------------------------- WORK: the group's assignments */

const assignment = (over = {}) => ({
  id: "a1",
  targetType: "CASE",
  targetId: "c1",
  target: { resolved: true, label: "Flood claim", sublabel: null, state: "OPEN" },
  assigneeUserId: null,
  status: "OPEN",
  priority: "NORMAL",
  dueAtUtc: null,
  overdue: false,
  note: null,
  updatedAt: null,
  ...over,
});

test("every filter goes into the query, not into the page in hand", () => {
  // The web tab's own comment records what client-side narrowing did: it hid
  // rows and counted only what happened to be loaded.
  const path = mod.buildAssignmentsPath("t1", {
    status: "OPEN",
    targetType: "CASE",
    priority: "HIGH",
    assignee: "u1",
    search: "  flood ",
    limit: 25,
    cursor: "cur",
  });
  assert.match(path, /^\/v1\/collaboration-teams\/t1\/assignments\?/);
  for (const part of ["status=OPEN", "targetType=CASE", "priority=HIGH", "assignee=u1", "q=flood", "limit=25", "cursor=cur"]) {
    assert.ok(path.includes(part), `missing ${part} in ${path}`);
  }
});

test("an unfiltered list asks for no parameters at all", () => {
  assert.equal(mod.buildAssignmentsPath("t1"), "/v1/collaboration-teams/t1/assignments");
});

test("the page carries the server's TRUE total, not its own length", () => {
  const page = mod.parseAssignmentPage({
    assignments: [assignment(), assignment({ id: "a2" }), { noId: true }],
    nextCursor: "c9",
    total: 380,
  });
  assert.equal(page.assignments.length, 2);
  assert.equal(page.total, 380);
  assert.equal(page.nextCursor, "c9");
  assert.match(mod.assignmentPageSummary(2, 380), /Showing 2 of 380/);
});

test("an absent total is absent, never a total of zero", () => {
  // "Showing 12 of 0" would be worse than saying nothing.
  const page = mod.parseAssignmentPage({ assignments: [assignment()] });
  assert.equal(page.total, null);
  assert.equal(mod.assignmentPageSummary(1, null), "1 assignment");
});

test("an unresolved target is named as unavailable, not blank or guessed", () => {
  // An assignment whose case was deleted is still a real assignment.
  const [a] = mod.parseAssignmentPage({
    assignments: [assignment({ target: { resolved: false, label: null } })],
  }).assignments;
  assert.equal(a.target.resolved, false);
  assert.match(mod.assignmentTargetLabel(a), /Case no longer available/);
});

test("a resolved target reads as the record's own current name", () => {
  const [a] = mod.parseAssignmentPage({ assignments: [assignment()] }).assignments;
  assert.equal(mod.assignmentTargetLabel(a), "Flood claim");
});

test("overdue is the server's, and only while the work is open", () => {
  const open = mod.parseAssignmentPage({ assignments: [assignment({ overdue: true })] }).assignments[0];
  assert.equal(mod.showsOverdue(open), true);

  // A completed assignment that was late is history, not an alert.
  for (const status of ["COMPLETED", "CANCELLED"]) {
    const done = mod.parseAssignmentPage({
      assignments: [assignment({ overdue: true, status })],
    }).assignments[0];
    assert.equal(mod.showsOverdue(done), false);
  }
});

test("terminal work is not offered another transition", () => {
  assert.equal(mod.assignmentIsTerminal("COMPLETED"), true);
  assert.equal(mod.assignmentIsTerminal("CANCELLED"), true);
  assert.equal(mod.assignmentIsTerminal("REASSIGNED"), true);
  assert.equal(mod.assignmentIsTerminal("OPEN"), false);
  assert.equal(mod.assignmentIsTerminal("IN_PROGRESS"), false);
});

test("a null assignee is SENT, because it means team-level", () => {
  // Omitting it would leave the work on whoever holds it; null is the edit.
  assert.deepEqual(mod.buildAssignmentUpdateBody({ assigneeUserId: null }), {
    assigneeUserId: null,
  });
  assert.deepEqual(mod.buildAssignmentUpdateBody({ status: "IN_PROGRESS" }), {
    status: "IN_PROGRESS",
  });
  // A field that was not given is omitted, not sent as null.
  assert.equal("assigneeUserId" in mod.buildAssignmentUpdateBody({ status: "OPEN" }), false);
});

test("a failed assignment never renders as a completed one", () => {
  assert.equal(mod.assignmentStatusTone("COMPLETED"), "verified");
  assert.equal(mod.assignmentStatusTone("IN_PROGRESS"), "pending");
  assert.equal(mod.assignmentStatusTone("CANCELLED"), "neutral");
  assert.equal(mod.assignmentStatusTone("SOMETHING_NEW"), "neutral");
});

test("the vocabularies are the generated canonical ones", () => {
  // Generated from packages/shared, so a new canonical status cannot exist
  // and be missing here.
  assert.deepEqual([...mod.COLLABORATION_TEAM_ASSIGNMENT_TARGETS], ["CASE", "EVIDENCE", "REVIEW"]);
  assert.ok(mod.COLLABORATION_TEAM_ASSIGNMENT_STATUSES.includes("REASSIGNED"));
  assert.ok(mod.COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES.includes("URGENT"));
});

/* ----------------------------------------------- SETTINGS and disposability */

test("the settings write carries exactly the three backed fields", () => {
  // updateTeam supports { name, description, teamType } and nothing else.
  assert.deepEqual(
    mod.buildTeamUpdateBody({ name: " Field ", description: " why ", teamType: "LEGAL" }),
    { name: "Field", description: "why", teamType: "LEGAL" },
  );
});

test("a cleared description is sent as empty, because clearing is an edit", () => {
  assert.equal(
    mod.buildTeamUpdateBody({ name: "x", description: "   ", teamType: "GENERAL" }).description,
    "",
  );
});

test("an absent disposability answer means NOT disposable", () => {
  // Defaulting to yes on a permanent delete would be the client deciding a
  // destructive question the server owns.
  assert.equal(mod.parseTeamDisposability({}).disposable, false);
  assert.equal(mod.parseTeamDisposability(null).disposable, false);
  assert.equal(
    mod.parseTeamDisposability({ disposition: { disposable: true, blockers: [] } }).disposable,
    true,
  );
});

test("blockers are read whether they are strings or objects", () => {
  const d = mod.parseTeamDisposability({
    disposition: {
      disposable: false,
      blockers: ["It has messages.", { message: "It has work." }, { code: "HAS_HISTORY" }, null],
    },
  });
  assert.deepEqual(d.blockers, ["It has messages.", "It has work.", "HAS_HISTORY"]);
});

test("delete and archive say different things, and delete says why", () => {
  assert.match(mod.DELETE_TEAM_CONSEQUENCE, /cannot be undone/i);
  // Archiving already frees the slot, so deletion is never the route to more
  // capacity — the surface says so rather than letting a user discover it.
  assert.match(mod.DELETE_TEAM_CONSEQUENCE, /frees the plan slot/i);
  assert.match(mod.ARCHIVE_TEAM_CONSEQUENCE, /kept/i);
  assert.match(mod.ARCHIVE_TEAM_CONSEQUENCE, /reopened/i);
});

test("only a LEAD administers the group", () => {
  assert.equal(mod.canAdministerTeam("LEAD"), true);
  assert.equal(mod.canAdministerTeam("ADMIN"), false);
  assert.equal(mod.canAdministerTeam(null), false);
});

test("the settings paths are the canonical ones", () => {
  assert.equal(mod.buildCollaborationTeamPath("t1"), "/v1/collaboration-teams/t1");
  assert.equal(mod.buildTeamArchivePath("t1"), "/v1/collaboration-teams/t1/archive");
  assert.equal(mod.buildTeamUnarchivePath("t1"), "/v1/collaboration-teams/t1/unarchive");
  assert.equal(mod.buildTeamDisposabilityPath("t1"), "/v1/collaboration-teams/t1/disposability");
  assert.equal(mod.buildTeamActivityPath("t1"), "/v1/collaboration-teams/t1/activity?limit=25");
});

test("a history row with no id is dropped rather than rendered", () => {
  const page = mod.parseTeamActivity({
    items: [{ id: "e1", eventType: "team.member_added" }, {}, null],
    nextCursor: "c1",
  });
  assert.equal(page.items.length, 1);
  assert.equal(mod.teamActivityLabel(page.items[0].eventType), "Team member added");
  assert.equal(page.nextCursor, "c1");
});

test("disposability blockers are the server's { kind, count }, said in words", () => {
  const d = mod.parseTeamDisposability({
    disposition: { disposable: false, blockers: [{ kind: "assignments", count: 3 }, { kind: "discussion", count: 1 }, { kind: "activity", count: 12 }] },
  });
  assert.equal(d.disposable, false);
  assert.deepEqual(d.blockers, ["3 assignments", "1 discussion comment", "12 activity entries"], "every blocker was dropped");
});

test("the entitlement is read at the server's keys (collaborationTeams, featureIncluded, plan)", () => {
  const e = mod.parseCollaborationEntitlement({ canCreateCollaborationTeam: true, featureIncluded: true, plan: "TEAM", collaborationTeams: { used: 2, limit: 5 } });
  assert.equal(e.teamsUsed, 2);
  assert.equal(e.teamsLimit, 5);
  assert.equal(e.plan, "TEAM");
  assert.equal(e.planLocked, false);
  // The keys native used to read are not the server's.
  const fiction = mod.parseCollaborationEntitlement({ teams: { used: 2, limit: 5 }, planLocked: true });
  assert.equal(fiction.teamsLimit, null);
  assert.equal(fiction.planLocked, false);
});
