/**
 * B5B-F-105 — native verification-link management stays on the web (owner
 * directive): the phone hands off to the web record's Verification page
 * section (web `evidenceVerificationPageHref`: /evidence/<id>?tab=artifacts#verification-page),
 * where reviewer links are revoked and the page is withdrawn. The handoff
 * carries the record id only (an owner surface behind sign-in) — never a
 * session token, never a verify token. When the record's workspace cannot be
 * confirmed, it opens the authenticated workspaces entry with instructions.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./support/render.mjs";

let PV;
before(async () => {
  PV = await loadModule("src/product/public-verify.ts");
});

const ORIGIN = "https://www.proovra.com";
const EV = "5b0a3c1e-0000-4000-8000-000000000001";
const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const base = { origin: ORIGIN, evidenceId: EV, signedIn: true, recordTeamId: TEAM, activeTeamId: TEAM, workspaceName: "Acme Claims" };

test("same workspace: the record's Verification page section on the web, by record id only", () => {
  const h = PV.verificationManagementHandoff(base);
  assert.equal(h.target, "record");
  assert.equal(h.url, `${ORIGIN}/evidence/${EV}?tab=artifacts#verification-page`);
  assert.match(h.instructions, /same account/);
  assert.match(h.instructions, /“Acme Claims”/);
  assert.match(h.instructions, /revoke reviewer links|withdraw/);
});

test("the URL never carries a token, a pvr_/pvs_ reference or a query beyond the tab", () => {
  for (const over of [{}, { recordTeamId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, { recordTeamId: null }]) {
    const h = PV.verificationManagementHandoff({ ...base, ...over });
    const u = new URL(h.url);
    assert.equal(u.origin, ORIGIN);
    assert.ok(!/token|pvr_|pvs_|session|auth/i.test(h.url), h.url);
    assert.ok([...u.searchParams.keys()].every((k) => k === "tab"), h.url);
  }
  // An odd id is encoded into one path segment, never a second path or query.
  const odd = PV.verificationManagementHandoff({ ...base, evidenceId: "a/b?c=d" });
  assert.equal(odd.url, `${ORIGIN}/evidence/a%2Fb%3Fc%3Dd?tab=artifacts#verification-page`);
});

test("wrong workspace: the record is not in this app's active workspace → the web workspaces entry, with instructions", () => {
  const h = PV.verificationManagementHandoff({ ...base, recordTeamId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
  assert.equal(h.target, "workspaces");
  assert.equal(h.url, `${ORIGIN}/workspaces`);
  assert.match(h.instructions, /switch to the workspace that holds this record/);
  assert.match(h.instructions, /Artifacts → Verification page/);
  assert.ok(!h.instructions.includes("Acme Claims"), "named a workspace the record is not in");
});

test("unknown record workspace is treated like a wrong one (never routed blind to the record)", () => {
  assert.equal(PV.verificationManagementHandoff({ ...base, recordTeamId: null }).target, "workspaces");
  assert.equal(PV.verificationManagementHandoff({ ...base, activeTeamId: null }).target, "workspaces");
});

test("signed out: no link, and the copy says to sign in", () => {
  const h = PV.verificationManagementHandoff({ ...base, signedIn: false });
  assert.equal(h.url, null);
  assert.equal(h.target, "none");
  assert.match(h.instructions, /Sign in/);
});

test("no web origin in this build, or no record: no link, the web app is still named", () => {
  for (const over of [{ origin: null }, { evidenceId: "" }]) {
    const h = PV.verificationManagementHandoff({ ...base, ...over });
    assert.equal(h.url, null);
    assert.equal(h.target, "none");
    assert.match(h.instructions, /PROOVRA web app/);
  }
});
