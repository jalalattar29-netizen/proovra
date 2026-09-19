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
const src = readFileSync(resolve(HERE, "../src/product/collaboration.ts"), "utf8")
  .replace(/^import \{ humanizeEnum \}.*$/m, "function humanizeEnum(v){return v.charAt(0)+v.slice(1).toLowerCase();}");
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
  assert.equal(mod.collaborationTeamSubtitle({ id: "t", name: "n", memberCount: 4, pendingInviteCount: 2 }), "4 members · 2 pending invites");
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
