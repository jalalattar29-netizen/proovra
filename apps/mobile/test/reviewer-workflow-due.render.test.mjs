/**
 * T-14 — the reviewer workflow's editable Due date (evidence/[id]/page.tsx:1548).
 * Native could set status and priority but showed the due date read-only; the
 * PATCH builder already carried dueAt, the sheet never offered it.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let patches = [];
let wf;
before(async () => {
  M = await loadModule("src/ui/reviewer-workflow-panel.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(() => {
  patches = [];
  wf = { status: "IN_REVIEW", priority: "NORMAL", dueAt: "2026-10-01T15:00:00.000Z" };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (init.method === "PATCH") {
      const body = JSON.parse(init.body);
      patches.push(body);
      if ("dueAt" in body) wf = { ...wf, dueAt: body.dueAt };
    }
    const res = path.endsWith("/events") ? { items: [] } : { available: true, workflow: wf };
    return new Response(JSON.stringify(res), { status: 200, headers: { "content-type": "application/json" } });
  };
});
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};

test("the due date is editable in local time, sent as that instant, and clearable", async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.ReviewerWorkflowPanel, { evidenceId: "ev-1" })));
  await settle();
  await r.press("Update review state");
  await r.type("Due date", "2026-11-02 09:30");
  await act(async () => { await r.byLabel("Save").find((n) => n.props.onPress).props.onPress(); });
  await settle();
  assert.deepEqual(patches.at(-1), { dueAt: new Date(2026, 10, 2, 9, 30).toISOString() });
  await r.press("Update review state");
  await r.type("Due date", "");
  await act(async () => { await r.byLabel("Save").find((n) => n.props.onPress).props.onPress(); });
  await settle();
  assert.deepEqual(patches.at(-1), { dueAt: null }, "clearing the due date did not send null");
});

test("a malformed due date is refused before any request", async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.ReviewerWorkflowPanel, { evidenceId: "ev-1" })));
  await settle();
  await r.press("Update review state");
  await r.type("Due date", "next tuesday");
  await act(async () => { await r.byLabel("Save").find((n) => n.props.onPress).props.onPress(); });
  await settle();
  assert.equal(patches.length, 0);
  assert.ok(r.hasText("Use YYYY-MM-DD HH:MM, in your local time."));
});

test("the panel names who assigned the review and counts the recorded events (ReviewerWorkflowCard :108, :126)", async () => {
  wf = { ...wf, assignedTo: { id: "u2", displayName: "Rae" }, assignedBy: { id: "u1", displayName: "Morgan Lead" } };
  const r = await renderComponent(h(M.TestProviders, null, h(M.ReviewerWorkflowPanel, { evidenceId: "ev-1" })));
  await settle();
  assert.ok(r.texts().some((t) => t.includes("Assigned to Rae") && t.includes("Assigned by Morgan Lead")), r.texts().join(" | "));
  assert.ok(r.hasText("0 recorded events"));
});
