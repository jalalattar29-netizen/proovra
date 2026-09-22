/**
 * DISCUSSION — collaboration thread and message projections.
 *
 * The claim that carries the most weight: a 404 from a collaboration route is
 * an AUTHORIZATION answer, not an empty list. Every route in that family
 * answers 404 — never 403 — to a non-member or a member without the reviewer
 * permission, deliberately, so a denial never confirms a group exists.
 * Rendering that as "no discussions yet" would tell a reader there is nothing
 * to see when in fact they cannot see it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/product/discussion.ts"), "utf8").replace(
  /^import type .*$/m,
  "",
);
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const D = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const thread = (over = {}) => ({
  id: "t1",
  title: "Missing timestamp",
  status: "OPEN",
  kind: "QUESTION",
  visibility: "TEAM",
  evidenceId: "ev-1",
  assignedToUserId: null,
  resolvedAtUtc: null,
  escalatedAtUtc: null,
  reopenCount: 0,
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:00:00.000Z",
  ...over,
});

/* -------------------------------------------------------------------- paths */

test("the paths address the canonical collaboration endpoints", () => {
  assert.equal(D.buildThreadsPath("t1"), "/v1/collaboration/threads?teamId=t1");
  assert.equal(
    D.buildThreadsPath("t1", "OPEN"),
    "/v1/collaboration/threads?teamId=t1&status=OPEN",
  );
  assert.equal(D.buildThreadMessagesPath("x1"), "/v1/collaboration/threads/x1/messages");
  assert.equal(D.buildThreadResolvePath("x1"), "/v1/collaboration/threads/x1/resolve");
  assert.equal(D.buildThreadReopenPath("x1"), "/v1/collaboration/threads/x1/reopen");
});

/* ----------------------------------------------------- denial vs emptiness */

test("a 404 is a denial, never an empty discussion", () => {
  assert.equal(D.isCollaborationDenial({ statusCode: 404 }), true);
  assert.equal(D.isCollaborationDenial({ kind: "notFound" }), true);
  assert.equal(D.isCollaborationDenial({ statusCode: 500 }), false);
  assert.equal(D.isCollaborationDenial(new Error("network")), false);
});

/* ------------------------------------------------------------------ threads */

test("a thread with no title is untitled, never a blank row", () => {
  const [t] = D.parseDiscussionThreads({ threads: [thread({ title: null })] });
  assert.equal(t.title, "Untitled thread");
});

test("a thread with no id is dropped", () => {
  const list = D.parseDiscussionThreads({ threads: [thread(), { title: "x" }, null] });
  assert.equal(list.length, 1);
});

test("escalated first, then open, then everything settled", () => {
  const list = D.sortThreads(
    D.parseDiscussionThreads({
      threads: [
        thread({ id: "resolved", status: "RESOLVED", updatedAt: "2026-09-20T00:00:00.000Z" }),
        thread({ id: "open-old", status: "OPEN", updatedAt: "2026-09-01T00:00:00.000Z" }),
        thread({ id: "escalated", status: "ESCALATED", updatedAt: "2026-08-01T00:00:00.000Z" }),
        thread({ id: "open-new", status: "OPEN", updatedAt: "2026-09-19T00:00:00.000Z" }),
      ],
    }),
  );

  // A resolved thread at the top is a thread nobody needs, and an open one
  // buried beneath it is work somebody is waiting on — even when the resolved
  // one was touched most recently.
  assert.deepEqual(
    list.map((t) => t.id),
    ["escalated", "open-new", "open-old", "resolved"],
  );
});

test("status tones never render an escalation as healthy", () => {
  assert.equal(D.threadStatusTone("ESCALATED"), "risk");
  assert.equal(D.threadStatusTone("OPEN"), "pending");
  assert.equal(D.threadStatusTone("RESOLVED"), "verified");
  assert.equal(D.threadStatusTone("SOMETHING_NEW"), "neutral");
  assert.equal(D.threadStatusLabel("SOMETHING_NEW"), "Something new");
  assert.equal(D.threadStatusLabel(""), "Unknown");
});

test("the offered transition is the one the thread can actually take", () => {
  assert.equal(D.nextTransition({ status: "OPEN" }), "resolve");
  assert.equal(D.nextTransition({ status: "ESCALATED" }), "resolve");
  assert.equal(D.nextTransition({ status: "RESOLVED" }), "reopen");
  assert.equal(D.nextTransition({ status: "CLOSED" }), "reopen");
});

/* ----------------------------------------------------------------- messages */

test("a conversation reads forwards, oldest first", () => {
  const msgs = D.parseDiscussionMessages({
    messages: [
      { id: "m2", body: "second", createdAt: "2026-09-02T00:00:00.000Z" },
      { id: "m1", body: "first", createdAt: "2026-09-01T00:00:00.000Z" },
      { id: "m3", body: "third", createdAt: "2026-09-03T00:00:00.000Z" },
    ],
  });
  assert.deepEqual(msgs.map((m) => m.id), ["m1", "m2", "m3"]);
});

test("an author with no name is 'someone', and a message with no id is dropped", () => {
  const msgs = D.parseDiscussionMessages({
    messages: [
      { id: "m1", body: "hi", author: { id: "u1" } },
      { body: "orphan" },
    ],
  });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].authorName, null);
  assert.equal(msgs[0].authorUserId, "u1");
});

test("whitespace is not a message", () => {
  assert.equal(D.isSendableMessage(""), false);
  assert.equal(D.isSendableMessage("   \n  "), false);
  assert.equal(D.isSendableMessage("ok"), true);
  assert.equal(D.isSendableMessage("x".repeat(10001)), false);
});
