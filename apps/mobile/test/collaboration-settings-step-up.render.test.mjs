/**
 * ARCHIVE COLLABORATION TEAM on native (2026-10-28). A Collaboration Team is
 * never deleted. The settings section shows the server's impact preview,
 * requires the exact team name, and runs the archive through the one challenge
 * flow — whose sheet must be on screen. Nothing is archived before the factor
 * is verified, and the retry carries the challenge.
 *
 * (The file keeps its name from the step-up delete it used to cover; that
 * delete was retired with the hard-delete route.)
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadWithProviders, renderInProviders, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let requests = [];
let archived = 0;
let archiveCalls = 0;

const TEAM = {
  id: "t1",
  workspaceId: "ws1",
  name: "Claims",
  description: null,
  status: "ACTIVE",
  viewerRole: "LEAD",
  activeMemberCount: 1,
  pendingInviteCount: 0,
  members: [],
  invites: [],
};

const IMPACT = {
  teamId: "t1",
  teamName: "Claims",
  status: "ACTIVE",
  acceptedMembers: 2,
  caseGrants: 1,
  openAssignments: 4,
  pendingInvites: 0,
  unavailable: ["case_access_through_team"],
  preserved: ["team_record"],
  restore: { requestable: true, rechecks: [] },
};

before(async () => {
  M = await loadWithProviders("src/ui/collaboration-settings.tsx");
});
beforeEach(() => {
  requests = [];
  archived = 0;
  archiveCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const method = init.method ?? "GET";
    const headers = init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : { ...(init.headers ?? {}) };
    requests.push({ path, method, headers, body: init.body ? JSON.parse(init.body) : null });
    const reply = (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (path === "/v1/collaboration-teams/t1/activity") return reply(200, { items: [], nextCursor: null });
    if (path === "/v1/collaboration-teams/t1/archive-impact") return reply(200, { impact: IMPACT });
    if (path === "/v1/collaboration-teams/t1/archive" && method === "POST") {
      archiveCalls += 1;
      const challenge = Object.entries(headers).find(([k]) => k.toLowerCase() === "x-proovra-step-up-challenge-id");
      if (!challenge) {
        return reply(401, { error: { code: "STEP_UP_REQUIRED", details: { purpose: "COLLABORATION_TEAM_ARCHIVE" } } });
      }
      return reply(200, { ok: true, alreadyArchived: false });
    }
    if (path === "/v1/identity-security/step-up/start") {
      return reply(200, { challenge: { id: "ch-1" }, method: "TOTP", destinationMask: null, availableMethods: ["TOTP"] });
    }
    if (path === "/v1/identity-security/step-up/check") return reply(200, { status: "approved" });
    return reply(500, { message: "unstubbed" });
  };
});

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};

/** The sheet's confirm button — the last control carrying the action's name. */
async function pressSheetArchive(r) {
  const hits = r.byLabel("Archive Collaboration Team").filter((n) => n.props.onPress);
  const target = hits.at(-1);
  if (!target || target.props.disabled || target.props.accessibilityState?.disabled) return false;
  await act(async () => {
    await target.props.onPress();
  });
  return true;
}

test("archive: impact preview, exact name, then the challenge; nothing archived before the factor", async () => {
  const r = await renderInProviders(
    M,
    h(M.CollaborationSettingsSection, { team: TEAM, onChanged: () => {}, onArchived: () => { archived += 1; } }),
  );
  await settle();
  assert.equal(r.hasText("Delete this group"), false, "no delete action remains");
  await r.press("Archive Collaboration Team");
  await settle();
  assert.ok(r.hasText("2 members lose access through this team"));
  assert.ok(r.hasText("4 open tasks will be cancelled"));

  // A wrong-case name does not arm the action.
  await r.type("Collaboration Team name confirmation", "claims");
  await settle();
  assert.equal(await pressSheetArchive(r), false, "the action was armed by a non-matching name");
  assert.equal(archiveCalls, 0);

  await r.type("Collaboration Team name confirmation", "Claims");
  await settle();
  assert.equal(await pressSheetArchive(r), true);
  await settle();

  assert.equal(archiveCalls, 1);
  assert.ok(r.hasText("Archive this Collaboration Team"), "the verification sheet never appeared");
  const start = requests.find((q) => q.path === "/v1/identity-security/step-up/start");
  assert.equal(start?.body?.teamId, "ws1", "the challenge is bound to the group's workspace");
  assert.equal(start?.body?.handoff, true, "the app asks for a system-browser handoff");
  assert.equal(archived, 0, "archived before the factor was verified");

  await r.type("Verification code", "123456");
  await r.press("Confirm + retry");
  await settle();

  assert.equal(archiveCalls, 2);
  const retried = requests.filter((q) => q.path === "/v1/collaboration-teams/t1/archive").at(-1);
  const header = Object.entries(retried.headers).find(([k]) => k.toLowerCase() === "x-proovra-step-up-challenge-id");
  assert.equal(header?.[1], "ch-1");
  assert.deepEqual(retried.body, { confirmName: "Claims" });
  assert.equal(archived, 1);
});

test("an archived team offers Restore Collaboration Team, never archive or delete", async () => {
  const r = await renderInProviders(
    M,
    h(M.CollaborationSettingsSection, { team: { ...TEAM, status: "ARCHIVED" }, onChanged: () => {}, onArchived: () => {} }),
  );
  await settle();
  assert.equal(r.byLabel("Restore Collaboration Team").length > 0, true);
  assert.equal(r.byLabel("Archive Collaboration Team").length, 0);
  assert.equal(r.hasText("Delete"), false);
});
