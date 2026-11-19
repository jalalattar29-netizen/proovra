/**
 * T-14 — portal review (portal/[token]/work/[workflowId]/page.tsx :478
 * recorded decision + Retry, :705 Reply) and a DEFECT found with them:
 * native posted `{ decision: "APPROVED", note }` while the server parses
 * `{ verdict: EXTERNAL_DECISION_VERDICTS, rationale? }` — every native decision
 * failed validation, and its confirm said a decision could not be changed
 * when a resubmission in fact replaces it.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EXTERNAL_DECISION_VERDICTS } from "@proovra/shared";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let posts = [];
let decisions = [];
let caps = ["portal.decide", "portal.comment"];
let decisionsStatus = 200;
let packageReply = null;
const WF = "3f0c2a1e-0000-4000-8000-00000000000a";
const COMMENTS = [
  { id: "c1", body: "Is the timestamp local?", authorDisplay: "Rae", createdAtUtc: "2026-09-20T10:00:00Z", parentCommentId: null },
  { id: "c2", body: "Yes, UTC+1.", authorDisplay: "Ops", createdAtUtc: "2026-09-20T11:00:00Z", parentCommentId: "c1" },
];

before(async () => {
  M = await loadModule("app/(stack)/portal/work/[workflowId].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(() => {
  posts = [];
  decisions = [];
  caps = ["portal.decide", "portal.comment"];
  decisionsStatus = 200;
  packageReply = { body: { url: "https://storage.example.test/pkg.zip", reportVersion: 1 }, status: 200 };
  globalThis.__LINKING_OPENED__ = [];
  globalThis.__EXPO_PARAMS__ = { workflowId: WF };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    const send = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (method === "POST") posts.push({ path, body });
    if (path === "/v1/portal/dashboard") return send({ portal: { reviewer: { capabilities: caps }, scope: {}, assigned: [], limitations: [] } });
    if (path === `/v1/portal/work/${WF}/comments`) return method === "POST" ? send({ commentId: "c3" }, 201) : send({ comments: COMMENTS });
    if (path === `/v1/portal/work/${WF}/decision`) {
      const replaced = decisions.length > 0;
      decisions = [{ id: "d1", workflowId: WF, verdict: body.verdict, rationale: body.rationale ?? null, submittedAtUtc: "2026-09-24T09:00:00.000Z" }];
      return send({ decisionId: "d1", replaced });
    }
    if (path === `/v1/portal/work/${WF}/decisions`) return decisionsStatus === 200 ? send({ decisions }) : send({ denial: "NOT_PERMITTED" }, decisionsStatus);
    if (path === `/v1/portal/work/${WF}/view`) return send({ ok: true });
    if (path === `/v1/portal/work/${WF}/verification-package`) return send(packageReply.body, packageReply.status);
    return send({ message: "unstubbed" }, 500);
  };
});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const confirm = async (r, label) => {
  const node = r.byLabel(label).filter((n) => n.props.onPress).at(-1);
  await act(async () => { await node.props.onPress(); });
  await settle();
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};
const openMaterial = async (r) => {
  await r.press("Open verification package");
  await settle();
};

test("PRO-NC-09 / PRO-R13Z-01: the package is offered first; viewed and the decision follow opening it", async () => {
  const r = await render();
  assert.equal(posts.some((p) => p.path.endsWith("/view")), false, "viewed was recorded before any material was shown");
  assert.equal(r.byLabel("Approve").length, 0, "a decision was offered before the material was opened");
  assert.ok(r.hasText("Open the verification package above before recording a decision."));
  await openMaterial(r);
  assert.deepEqual(globalThis.__LINKING_OPENED__, ["https://storage.example.test/pkg.zip"]);
  assert.equal(posts.filter((p) => p.path.endsWith("/view")).length, 1);
  assert.ok(r.byLabel("Approve").length > 0);
});

test("PRO-NC-09: a refused package records no view and offers no decision", async () => {
  packageReply = { body: { error: { code: "package_download_not_granted" } }, status: 403 };
  const r = await render();
  await openMaterial(r);
  assert.ok(r.hasText("Your access does not include the file for this review. Ask the person who invited you."));
  assert.equal(posts.some((p) => p.path.endsWith("/view")), false);
  assert.equal(r.byLabel("Approve").length, 0);
});

test("native offers exactly the server's verdicts", async () => {
  const P = await loadModule("src/product/portal.ts", []);
  assert.deepEqual([...P.PORTAL_DECISIONS], [...EXTERNAL_DECISION_VERDICTS], "native verdicts drifted from the shared vocabulary");
});

test("a decision posts { verdict, rationale }, is re-read, and a second one replaces it", async () => {
  const r = await render();
  await openMaterial(r);
  assert.ok(r.hasText("You have not recorded a decision for this review yet."));
  await r.type("Decision rationale", "Metadata is incomplete.");
  await r.press("Request changes");
  await confirm(r, "Request changes");
  const post = posts.find((p) => p.path.endsWith("/decision"));
  assert.deepEqual(post.body, { verdict: "REQUEST_CHANGES", rationale: "Metadata is incomplete." });
  assert.ok(r.hasText("Decision recorded: Request changes."));
  assert.ok(r.hasText("Submitting again replaces this decision."));
  await r.press("Approve");
  await confirm(r, "Approve");
  assert.ok(r.hasText("Decision recorded: Approve. It replaces your previous decision."));
});

test("a verdict other than Approve needs a rationale before it can be chosen", async () => {
  const r = await render();
  await openMaterial(r);
  const reject = r.byLabel("Reject").find((n) => n.props.onPress);
  assert.equal(reject.props.disabled ?? reject.props.accessibilityState?.disabled, true);
});

test("a failed read offers Retry; a read-only role gets no decision controls", async () => {
  decisionsStatus = 500;
  let r = await render();
  assert.ok(r.hasText("Your recorded decision could not be loaded."));
  decisionsStatus = 200;
  await r.press("Retry");
  await settle();
  assert.ok(r.hasText("You have not recorded a decision for this review yet."));
  r.unmount();
  caps = ["portal.history.read"];
  r = await render();
  assert.ok(r.hasText("Your role is read-only for decisions. You may still annotate and comment when permitted."));
  assert.equal(r.byLabel("Approve").length, 0);
});

test("replies nest under their comment and post with parentCommentId", async () => {
  const r = await render();
  assert.ok(r.hasText("Yes, UTC+1."));
  await r.type("Reply to this comment", "Thanks.");
  await r.press("Reply");
  await settle();
  const reply = posts.find((p) => p.path.endsWith("/comments"));
  assert.deepEqual(reply.body, { body: "Thanks.", parentCommentId: "c1" });
});
