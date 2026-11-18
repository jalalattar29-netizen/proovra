/**
 * WS-CAP — native context boundaries.
 *
 *   PRO-NC-11 — the assistant conversation is cleared only by a real account,
 *               workspace or plan change, never by an envelope re-read.
 *   PRO-N1-09 — Home activity keeps only the active workspace's entries.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

import { loadModule } from "./support/render.mjs";

let CHAT;
let HOME;
before(async () => {
  CHAT = await loadModule("src/ui/native-chat-assistant.tsx", []);
  HOME = await loadModule("src/product/home-operations.ts", []);
});

const ENV = (extra = {}) => ({ account: { userId: "u-1" }, generatedAt: "2026-11-18T10:00:00Z", requestId: "r-1", ...extra });
const CTX = { activeTeamId: "t-1", activeSpaceType: "ORGANIZATION", activeSpacePlan: "PRO" };

test("PRO-NC-11: a context re-read (new generatedAt / requestId) keeps the conversation", () => {
  const a = CHAT.assistantConversationBoundary(ENV(), CTX);
  const b = CHAT.assistantConversationBoundary(ENV({ generatedAt: "2026-11-18T10:05:00Z", requestId: "r-2" }), CTX);
  assert.equal(a, b);
});

test("PRO-NC-11: a workspace switch, another account or sign-out clears it", () => {
  const a = CHAT.assistantConversationBoundary(ENV(), CTX);
  assert.notEqual(a, CHAT.assistantConversationBoundary(ENV(), { ...CTX, activeTeamId: "t-2" }));
  assert.notEqual(a, CHAT.assistantConversationBoundary(ENV({ account: { userId: "u-2" } }), CTX));
  assert.notEqual(a, CHAT.assistantConversationBoundary(null, null));
});

test("PRO-N1-09: Home activity drops another workspace's 'request more' entries", () => {
  const inbox = {
    items: [
      { id: "a", category: "intake_required_items_missing", occurredAt: "2026-11-18T09:00:00Z", title: "Mine", context: { teamId: "t-1" } },
      { id: "b", category: "intake_required_items_missing", occurredAt: "2026-11-18T09:01:00Z", title: "Other", context: { teamId: "t-2" } },
    ],
  };
  const groups = HOME.buildActivityGroups({ inbox, workspaceId: "t-1", nowMs: Date.parse("2026-11-18T12:00:00Z") });
  const titles = groups.flatMap((g) => (g.events ?? g.items ?? []).map((e) => e.title));
  assert.ok(titles.some((t) => t.includes("Mine")), JSON.stringify(groups));
  assert.ok(!titles.some((t) => t.includes("Other")));
});
