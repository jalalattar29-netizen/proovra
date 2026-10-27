/**
 * SEC-03 on native — deleting a Collaboration Team is irreversible, so the
 * server asks for a fresh factor (401 STEP_UP_REQUIRED). The settings section
 * runs the delete through the one challenge flow; the flow waits on its sheet,
 * so the sheet must be on screen — without it the delete waited on a prompt
 * nobody could see.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadWithProviders, renderInProviders, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let requests = [];
let deleted = 0;
let deleteCalls = 0;

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

before(async () => {
  M = await loadWithProviders("src/ui/collaboration-settings.tsx");
});
beforeEach(() => {
  requests = [];
  deleted = 0;
  deleteCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const method = init.method ?? "GET";
    const headers = init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : { ...(init.headers ?? {}) };
    requests.push({ path, method, headers, body: init.body ? JSON.parse(init.body) : null });
    const reply = (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (path === "/v1/collaboration-teams/t1/activity") return reply(200, { items: [], nextCursor: null });
    if (path === "/v1/collaboration-teams/t1/disposability") return reply(200, { disposable: true, blockers: [] });
    if (path === "/v1/collaboration-teams/t1" && method === "DELETE") {
      deleteCalls += 1;
      const challenge = Object.entries(headers).find(([k]) => k.toLowerCase() === "x-proovra-step-up-challenge-id");
      if (!challenge) {
        return reply(401, { error: { code: "STEP_UP_REQUIRED", details: { purpose: "COLLABORATION_TEAM_DELETE" } } });
      }
      return reply(200, { deleted: true });
    }
    if (path === "/v1/identity-security/step-up/start") {
      return reply(200, { challenge: { id: "ch-1" }, method: "TOTP", destinationMask: null });
    }
    if (path === "/v1/identity-security/step-up/check") return reply(200, { status: "approved" });
    return reply(500, { message: "unstubbed" });
  };
});

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};

test("a challenged delete shows the verification sheet, and the verified code retries the delete", async () => {
  const r = await renderInProviders(
    M,
    h(M.CollaborationSettingsSection, { team: TEAM, onChanged: () => {}, onDeleted: () => { deleted += 1; } }),
  );
  await settle();
  await r.press("Delete this group");
  await settle();
  await r.press("Delete permanently");
  await settle();

  assert.equal(deleteCalls, 1);
  assert.ok(r.hasText("Delete this Collaboration Team"), "the verification sheet never appeared");
  const start = requests.find((q) => q.path === "/v1/identity-security/step-up/start");
  assert.equal(start?.body?.teamId, "ws1", "the challenge is bound to the group's workspace");
  assert.equal(deleted, 0, "deleted before the factor was verified");

  await r.type("Verification code", "123456");
  await r.press("Confirm + retry");
  await settle();

  assert.equal(deleteCalls, 2);
  const retried = requests.filter((q) => q.path === "/v1/collaboration-teams/t1" && q.method === "DELETE").at(-1);
  const header = Object.entries(retried.headers).find(([k]) => k.toLowerCase() === "x-proovra-step-up-challenge-id");
  assert.equal(header?.[1], "ch-1");
  assert.equal(deleted, 1);
});
