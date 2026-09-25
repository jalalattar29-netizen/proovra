/**
 * T-12 / RC-13 — declarations on the evidence record
 * (EvidenceCertificationsPanel.tsx: request :544, sign, revoke/withdraw).
 *
 * Before: native listed declarations read-only, and a FAILED read became an
 * empty list, so the section silently vanished. Now the panel owns its read,
 * says when it failed, and runs request → sign → revoke with a reread after
 * every write; success is announced only when the reread shows it.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadWithProviders, renderInProviders, React, act } from "./support/render.mjs";

const h = React.createElement;
let Screen;
let requests = [];
let certs = [];
let listFails = false;
let applyWrites = true;

const LIST = "/v1/evidence/ev-1/certifications";
const STATEMENT = "I am the custodian of these records and they were kept in the ordinary course.";

before(async () => {
  Screen = await loadWithProviders("app/(stack)/evidence/[id].tsx");
});
beforeEach(() => {
  requests = [];
  certs = [];
  listFails = false;
  applyWrites = true;
  globalThis.__EXPO_PARAMS__ = { id: "ev-1" };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ path, method, body });
    const json = (v, status = 200) =>
      new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (path === LIST) return listFails ? json({ message: "boom" }, 500) : json({ evidenceId: "ev-1", certifications: certs });
    if (path === `${LIST}/request` && method === "POST") {
      if (applyWrites) certs = [...certs, { id: "c-new", declarationType: body.declarationType, status: "REQUESTED", version: 1, requestedAtUtc: "2026-09-24T10:00:00Z", statementMarkdown: body.statementMarkdown }];
      return json({ evidenceId: "ev-1", certification: {} });
    }
    if (path === `${LIST}/attest` && method === "POST") {
      if (applyWrites) certs = certs.map((c) => (c.declarationType === body.declarationType ? { ...c, status: "ATTESTED", attestedAtUtc: "2026-09-24T11:00:00Z", attestorName: body.attestorName } : c));
      return json({ evidenceId: "ev-1", certification: {} });
    }
    if (path === `${LIST}/revoke` && method === "POST") {
      if (applyWrites) certs = certs.map((c) => (c.declarationType === body.declarationType ? { ...c, status: "REVOKED", revokedAtUtc: "2026-09-24T12:00:00Z", revokeReason: body.reason } : c));
      return json({ evidenceId: "ev-1", certification: {} });
    }
    if (path.startsWith("/v1/evidence/ev-1/review-workspace")) return json({ relationships: { items: [] } });
    if (path === "/v1/evidence/ev-1") return json({ evidence: { id: "ev-1", status: "SIGNED", type: "PHOTO" } });
    return json({ message: "unstubbed" }, 500);
  };
});

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
/** The confirm sheet renders after the panel, so its button is the LAST hit. */
const confirmSheet = async (r, label) => {
  const hits = r.byLabel(label).filter((n) => n.props.onPress);
  assert.ok(hits.length >= 1, `confirm sheet "${label}" did not open`);
  await act(async () => { await hits.at(-1).props.onPress(); });
  await settle();
};
const openIntegrity = async () => {
  const r = await renderInProviders(Screen, h(Screen.default, {}));
  await settle();
  await r.press("Integrity");
  await settle();
  return r;
};

test("a failed declarations read is SAID, not shown as an empty record", async () => {
  listFails = true;
  const r = await openIntegrity();
  assert.equal(r.byTestId("evidence-declarations").length, 1, "the declarations section vanished on a failed read");
  assert.ok(!r.hasText("No declaration is attached to this record."), "a failed read was presented as 'none'");
  assert.ok(r.byLabel("Request declaration").every((n) => n.props.disabled || n.props.accessibilityState?.disabled), "writes offered on an unloaded list");
});

test("request: type + statement → confirm → POST exactly that text → reread confirms", async () => {
  const r = await openIntegrity();
  assert.ok(r.hasText("No declaration is attached to this record."));
  assert.ok(r.hasText("Choose the declaration type to request."));
  await r.press("Declaration type: Custodian declaration");
  await r.type("Declaration statement (the signer signs exactly this text)", "too short");
  assert.ok(r.hasText("at least 20 characters"));
  await r.type("Declaration statement (the signer signs exactly this text)", `  ${STATEMENT}  `);
  await r.press("Request declaration");
  assert.ok(r.hasText("Request a custodian declaration?"), "no confirmation before a custody-recorded write");
  assert.equal(requests.filter((q) => q.method === "POST").length, 0, "wrote before confirmation");
  await confirmSheet(r, "Request declaration");
  const post = requests.find((q) => q.method === "POST" && q.path === `${LIST}/request`);
  assert.deepEqual(post?.body, { declarationType: "CUSTODIAN", statementMarkdown: STATEMENT });
  const i = requests.indexOf(post);
  assert.ok(requests.slice(i + 1).some((q) => q.path === LIST && q.method === "GET"), "no reread after the write");
  assert.ok(r.hasText("Custodian declaration requested. The saved declarations were reloaded."));
  assert.ok(r.hasText("Requested — awaiting signature"));
  const again = r.byLabel("Declaration type: Custodian declaration, already requested or signed");
  assert.equal(again.length, 1, "an open type is still offered for request");
});

test("sign: the statement is shown read-only and the signature posts the recorded text", async () => {
  certs = [{ id: "c0", declarationType: "QUALIFIED_PERSON", status: "REVOKED", version: 1, revokedAtUtc: "2026-09-19T10:00:00Z" }, { id: "c1", declarationType: "QUALIFIED_PERSON", status: "REQUESTED", version: 2, requestedAtUtc: "2026-09-20T10:00:00Z", statementMarkdown: STATEMENT }];
  const r = await openIntegrity();
  assert.ok(r.hasText("2 (1 earlier)"), "the newest version (and superseded count) is not what is shown");
  await r.press("Sign qualified-person certification");
  assert.ok(r.byTestId("declaration-statement").length === 1);
  assert.ok(r.hasText("Enter the signer's full name."));
  await r.type("Signer full name", "Dana Reyes");
  await r.type("Signer title or role", "Records manager");
  await r.type("Signer email", "not-an-email");
  assert.ok(r.hasText("Enter a valid email address for the signer."));
  await r.type("Signer email", "dana@example.com");
  await r.type("Typed signature", "Dana Reyes");
  await r.press("Submit signature");
  await confirmSheet(r, "Sign declaration");
  const post = requests.find((q) => q.method === "POST" && q.path === `${LIST}/attest`);
  assert.deepEqual(post?.body, {
    declarationType: "QUALIFIED_PERSON",
    attestorName: "Dana Reyes",
    attestorTitle: "Records manager",
    attestorEmail: "dana@example.com",
    attestorOrganization: null,
    statementMarkdown: STATEMENT,
    signatureText: "Dana Reyes",
  });
  assert.ok(r.hasText("Qualified-person certification signed. The saved declarations were reloaded."));
});

test("a request carrying no statement cannot be signed; the reason is stated", async () => {
  certs = [{ id: "c1", declarationType: "CUSTODIAN", status: "REQUESTED", version: 1, statementMarkdown: null }];
  const r = await openIntegrity();
  await r.press("Sign custodian declaration");
  assert.ok(r.hasText("No declaration statement is recorded for this request."));
  await r.press("Submit signature");
  assert.ok(!r.hasText("Sign this declaration?"), "offered to sign an empty statement");
});

test("withdraw needs a reason; a write the reread does not show is NOT announced as success", async () => {
  certs = [{ id: "c1", declarationType: "CUSTODIAN", status: "REQUESTED", version: 1, statementMarkdown: STATEMENT }];
  applyWrites = false;
  const r = await openIntegrity();
  await r.press("Withdraw request for custodian declaration");
  assert.ok(r.hasText("Enter the reason for revoking."));
  await r.type("Reason (required, recorded in custody history)", "Requested against the wrong record.");
  await r.press("Submit revocation");
  assert.ok(r.hasText("Withdraw this signature request?"));
  await confirmSheet(r, "Withdraw request");
  const post = requests.find((q) => q.method === "POST" && q.path === `${LIST}/revoke`);
  assert.deepEqual(post?.body, { declarationType: "CUSTODIAN", reason: "Requested against the wrong record." });
  assert.ok(!r.hasText("request withdrawn"), "announced success the server state does not show");
  assert.ok(r.hasText("do not show the change"));
});
