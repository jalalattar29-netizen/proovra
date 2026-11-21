/**
 * NEW-RG-26-4 (owner decision E) — the organization ownership-offer handoff,
 * the pure half: which links open the organization screen (and which stay in
 * the browser), what the offer read means, and the copy the server's codes map to.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./support/render.mjs";

const D = await loadModule("src/deep-link.ts");
const O = await loadModule("src/product/org-ownership-offer.ts");

const ORG = "0a0a0a0a-0000-4000-8000-000000000001";
const OFFER = "0b0b0b0b-0000-4000-8000-000000000002";

test("an organization link from the web page or the app scheme opens the organization screen, carrying the offer", () => {
  for (const url of [
    `https://www.proovra.com/organizations/${ORG}?ownershipOffer=${OFFER}`,
    `https://proovra.com/organizations/${ORG}?ownershipOffer=${OFFER}`,
    `proovra://organizations/${ORG}?ownershipOffer=${OFFER}`,
  ]) {
    const p = D.parseOrganizationDeepLink(url);
    assert.ok(p, url);
    assert.equal(p.organizationId, ORG);
    assert.equal(p.offerId, OFFER);
    assert.equal(p.route, `/organizations/${ORG}?ownershipOffer=${OFFER}`);
  }
  const plain = D.parseOrganizationDeepLink(`https://www.proovra.com/organizations/${ORG}`);
  assert.equal(plain.route, `/organizations/${ORG}`);
  assert.equal(plain.offerId, null);
});

test("refused shapes: the admin console, a non-uuid id, the list, another scheme, a malformed offer id", () => {
  for (const url of [
    `https://www.proovra.com/organizations/${ORG}/admin/members`,
    "https://www.proovra.com/organizations/acme",
    "https://www.proovra.com/organizations",
    `http://www.proovra.com/organizations/${ORG}`,
    `javascript://organizations/${ORG}`,
    "not a url",
  ]) {
    assert.equal(D.parseOrganizationDeepLink(url), null, url);
  }
  // A malformed offer id is dropped, never forwarded into the route.
  const p = D.parseOrganizationDeepLink(`https://www.proovra.com/organizations/${ORG}?ownershipOffer=../x`);
  assert.equal(p.route, `/organizations/${ORG}`);
  assert.equal(p.offerId, null);
});

test("an organization link is not claimed by the workspace resolve gate or the credential family", () => {
  const url = `https://www.proovra.com/organizations/${ORG}?ownershipOffer=${OFFER}`;
  assert.equal(D.parseCanonicalMobileDeepLink(url), null);
  assert.equal(D.parseCredentialDeepLink(url), null);
  assert.equal(D.parseExternalFlowDeepLink(url), null);
  assert.equal(D.parsePublicDocumentDeepLink(url), null);
  assert.equal(D.workspacePageDeepLink(url), null);
});

test("the offer read: a party's offer is parsed; null, an older API's shape or junk is no offer", () => {
  const s = O.parseOrgOwnershipOffer({
    offer: { id: OFFER, organizationId: ORG, fromUserId: "u-owner", toUserId: "u-1", status: "PENDING", expiresAtUtc: "2026-11-28T00:00:00.000Z" },
    billingOwnerStays: true,
    billingOwnerUserId: "u-owner",
  });
  assert.deepEqual(s.offer, { id: OFFER, organizationId: ORG, fromUserId: "u-owner", toUserId: "u-1", status: "PENDING", expiresAtIso: "2026-11-28T00:00:00.000Z" });
  assert.equal(s.billingOwnerUserId, "u-owner");
  assert.equal(O.orgOwnershipOfferSide(s.offer, "u-1"), "recipient");
  assert.equal(O.orgOwnershipOfferSide(s.offer, "u-owner"), "offerer");
  assert.equal(O.orgOwnershipOfferSide(s.offer, "u-other"), "none");
  assert.equal(O.orgOwnershipOfferSide(s.offer, null), "none");
  for (const junk of [{ offer: null }, null, "x", { offer: { id: OFFER } }]) {
    assert.equal(O.parseOrgOwnershipOffer(junk).offer, null);
  }
});

test("paths name the organization and the offer, encoded", () => {
  assert.equal(O.buildOrgOwnershipOfferPath(ORG), `/v1/orgs/${ORG}/ownership-offer`);
  assert.equal(O.buildOrgOwnershipOfferActionPath(ORG, OFFER, "accept"), `/v1/orgs/${ORG}/ownership-offer/${OFFER}/accept`);
  assert.equal(O.buildOrgOwnershipOfferActionPath("a/b", "c d", "decline"), "/v1/orgs/a%2Fb/ownership-offer/c%20d/decline");
  for (const a of ["accept", "decline", "cancel"]) {
    const fn = { accept: O.buildOrgOwnershipOfferAcceptPath, decline: O.buildOrgOwnershipOfferDeclinePath, cancel: O.buildOrgOwnershipOfferCancelPath }[a];
    assert.equal(fn(ORG, OFFER), O.buildOrgOwnershipOfferActionPath(ORG, OFFER, a));
    assert.equal(fn("a/b", "c d"), O.buildOrgOwnershipOfferActionPath("a/b", "c d", a));
  }
});

test("refusal copy follows the server's code (nested or flattened); an unknown code is not given a reason", () => {
  assert.match(O.orgOwnershipOfferRefusal({ body: { error: { code: "ownership_offer_offerer_not_owner" } } }), /no longer owns the organization/);
  assert.match(O.orgOwnershipOfferRefusal({ code: "ownership_offer_expired" }), /expired/);
  assert.match(O.orgOwnershipOfferRefusal({ code: "WORKSPACE_SEAT_LIMIT_REACHED" }), /Nothing was transferred/);
  assert.equal(O.orgOwnershipOfferRefusal({ code: "something_else" }), null);
  assert.equal(O.orgOwnershipOfferRefusal(new Error("x")), null);
});

test("a linked offer the signed-in account is not party to is said, without naming who it was for", () => {
  const none = { offer: null, billingOwnerUserId: null };
  const msg = O.linkedOfferNotice(OFFER, none, "u-2", "b@example.test");
  assert.match(msg, /not open to the account you are signed in as \(b@example\.test\)/);
  assert.match(msg, /sign in with that account/);
  // The party, on the linked offer: nothing to say.
  const mine = { offer: { id: OFFER, organizationId: ORG, fromUserId: "u-owner", toUserId: "u-1", status: "PENDING", expiresAtIso: null }, billingOwnerUserId: null };
  assert.equal(O.linkedOfferNotice(OFFER, mine, "u-1", null), null);
  // A newer offer superseded the linked one.
  assert.match(O.linkedOfferNotice("0c0c0c0c-0000-4000-8000-000000000003", mine, "u-1", null), /no longer open\. The current offer/);
  // No link, or not read yet: nothing.
  assert.equal(O.linkedOfferNotice(null, none, "u-2", null), null);
  assert.equal(O.linkedOfferNotice(OFFER, null, "u-2", null), null);
});

test("routes and the web handoff keep the organization; a malformed id goes nowhere", () => {
  assert.equal(O.orgOwnershipOfferRoute(ORG, OFFER), `/organizations/${ORG}?ownershipOffer=${OFFER}`);
  assert.equal(O.orgOwnershipOfferRoute(ORG), `/organizations/${ORG}`);
  assert.equal(O.orgOwnershipOfferRoute("../x", OFFER), null);
  assert.equal(O.orgOwnershipOfferWebUrl("https://www.proovra.com/", ORG), `https://www.proovra.com/organizations/${ORG}`);
  assert.equal(O.orgOwnershipOfferWebUrl(null, ORG), null);
  assert.equal(O.orgOwnershipOfferWebUrl("javascript:alert(1)", ORG), null);
  assert.equal(O.orgOwnershipOfferWebUrl("https://www.proovra.com", "x"), null);
});

const L = await loadModule("src/deep-link/link-ownership.ts", ["test/support/expo-stub.mjs"]);
const Intent = await loadModule("app/+native-intent.ts");

test("one owner: the gate owns the organization link, so the router cannot open the screen before the sign-in deferral", () => {
  for (const url of [
    `https://www.proovra.com/organizations/${ORG}?ownershipOffer=${OFFER}`,
    `proovra://organizations/${ORG}`,
  ]) {
    assert.equal(L.deepLinkGateOwns(url), true, url);
    assert.equal(Intent.redirectSystemPath({ path: url, initial: false }), "", url);
    assert.equal(Intent.redirectSystemPath({ path: url, initial: true }), "/", url);
  }
  // The admin console is not the gate's: it is not claimed and stays with the router/browser.
  const admin = `https://www.proovra.com/organizations/${ORG}/admin/members`;
  assert.equal(L.deepLinkGateOwns(admin), false);
  assert.equal(Intent.redirectSystemPath({ path: admin, initial: false }), admin);
});
