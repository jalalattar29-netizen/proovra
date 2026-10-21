/**
 * Independent forward audit closure — F-03 / F-04 (shared authorities).
 *
 * F-03: the custody-timeline line of an intake record's identity snapshot
 *       states the account fields as the LINK ISSUER's and never prints the
 *       issuer's email beside the contributor.
 * F-04: an intake fix measured by an app is recorded and described as the
 *       app's, never as browser GPS, and its provider mock flag is read from
 *       the submission event bound at the seal.
 *
 * Expected values are literal strings, not re-derived through the helpers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  acquisitionIdentityCustodyParts,
  resolveAcquisitionIdentitySnapshot,
  intakeLinkLocationSourceFor,
  intakeLinkLocationProvenanceSentence,
  isIntakeLinkLocationSource,
  evidenceLocationSourceLabel,
  locationProviderMockFromCustody,
} from "../dist/index.js";

const snapshotOf = (payload) =>
  resolveAcquisitionIdentitySnapshot({
    custodyEvents: [{ eventType: "IDENTITY_SNAPSHOT_RECORDED", atUtc: "2028-10-21T10:00:00.000Z", payload }],
  });

test("F-03: an intake snapshot's account fields are stated as the link issuer's, with no email", () => {
  const s = snapshotOf({
    identityLevelSnapshot: "VERIFIED_EMAIL",
    submittedByEmail: "issuer@example.test",
    submittedByAuthProvider: "GOOGLE",
    emailVerified: true,
    workspaceKind: "SHARED",
    actorKind: "INTAKE_CONTRIBUTOR",
    accountRole: "INTAKE_LINK_ISSUER",
    contributorEmailProvided: true,
  });
  const parts = acquisitionIdentityCustodyParts(s, "issuer@example.test");
  const line = parts.join(" • ");
  assert.equal(parts[0], "Contributor via a secure intake link (not signed in; an email address was provided)");
  assert.match(parts[1], /^The workspace account that issued the intake link \(not the contributor\): /);
  assert.ok(!line.includes("issuer@example.test"), line);
  assert.ok(!/Email:/.test(line), line);
});

test("F-03: an ordinary account snapshot keeps its submitter email", () => {
  const s = snapshotOf({
    identityLevelSnapshot: "VERIFIED_EMAIL",
    submittedByEmail: "owner@example.test",
    submittedByAuthProvider: "EMAIL",
    emailVerified: true,
    workspaceKind: "PERSONAL",
    actorKind: "ACCOUNT_USER",
    accountRole: "SUBMITTER",
  });
  const parts = acquisitionIdentityCustodyParts(s, "owner@example.test");
  assert.equal(parts.at(-1), "Email: owner@example.test");
  assert.ok(!parts.join(" ").includes("issued the intake link"));
});

test("F-04: the intake location source names who measured the fix", () => {
  assert.equal(intakeLinkLocationSourceFor("BROWSER_GEOLOCATION"), "INTAKE_LINK_GEOLOCATION");
  assert.equal(intakeLinkLocationSourceFor("DEVICE_GEOLOCATION"), "INTAKE_LINK_DEVICE_GEOLOCATION");
  assert.equal(isIntakeLinkLocationSource("INTAKE_LINK_GEOLOCATION"), true);
  assert.equal(isIntakeLinkLocationSource("INTAKE_LINK_DEVICE_GEOLOCATION"), true);
  assert.equal(isIntakeLinkLocationSource("CLIENT_APP_DEVICE_LOCATION"), false);
  assert.equal(evidenceLocationSourceLabel("INTAKE_LINK_DEVICE_GEOLOCATION"), "Reported by the contributor's app from its device");
  assert.equal(
    intakeLinkLocationProvenanceSentence("INTAKE_LINK_DEVICE_GEOLOCATION"),
    "Location was reported by the contributor's app from its device during upload.",
  );
  assert.ok(!/browser/i.test(intakeLinkLocationProvenanceSentence("INTAKE_LINK_DEVICE_GEOLOCATION")));
  assert.equal(
    intakeLinkLocationProvenanceSentence("INTAKE_LINK_GEOLOCATION"),
    "Location was provided by the contributor's browser during upload.",
  );
});

test("F-04: an intake fix's mock flag is read from the submission event bound at the seal", () => {
  assert.equal(
    locationProviderMockFromCustody([
      { eventType: "EVIDENCE_CREATED", payload: {} },
      { eventType: "EXTERNAL_INTAKE_SUBMITTED", payload: { gps: { source: "DEVICE_GEOLOCATION", providerReportedMock: true } } },
    ]),
    true,
  );
  assert.equal(
    locationProviderMockFromCustody([{ eventType: "EXTERNAL_INTAKE_SUBMITTED", payload: { gps: { source: "BROWSER_GEOLOCATION" } } }]),
    false,
  );
  // Any other event type never carries the flag.
  assert.equal(locationProviderMockFromCustody([{ eventType: "UPLOAD_COMPLETED", payload: { gps: { providerReportedMock: true } } }]), false);
});
