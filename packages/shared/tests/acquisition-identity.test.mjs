/**
 * THE ACQUISITION IDENTITY SNAPSHOT — capture-time identity, never re-derived.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  EVIDENCE_ACQUISITION_MODES,
  acquisitionAccountLabel,
  acquisitionIdentityLevelLabel,
  acquisitionIdentitySummary,
  acquisitionOrganizationVerificationLabel,
  acquisitionWorkspaceLabel,
  identityLevelLabel,
  resolveAcquisitionIdentitySnapshot,
  acquisitionActorLabel,
  acquisitionAccountRoleLabel,
} from "../dist/index.js";

const created = (payload) => ({ eventType: "IDENTITY_SNAPSHOT_RECORDED", atUtc: "2026-10-07T04:52:01.000Z", payload });

const PERSONAL_VERIFIED_EMAIL = created({
  identityLevelSnapshot: "VERIFIED_EMAIL",
  submittedByEmail: "a@example.test",
  submittedByAuthProvider: "EMAIL",
  emailVerified: true,
  workspaceKind: "PERSONAL",
  organizationVerifiedSnapshot: false,
});

const RAW_ENUM = /\b(VERIFIED_EMAIL|ORGANIZATION_ACCOUNT|OAUTH_BACKED_IDENTITY|BASIC_ACCOUNT|VERIFIED_ORGANIZATION|EMAIL_PASSWORD|GOOGLE|APPLE|PERSONAL|SHARED)\b/;

test("the incident shape: a verified-email user in a personal workspace", () => {
  // The record row was later rewritten (ORGANIZATION_ACCOUNT) by a report run
  // that re-derived identity; the creation event is the truth.
  const s = resolveAcquisitionIdentitySnapshot({
    custodyEvents: [PERSONAL_VERIFIED_EMAIL],
    row: { identityLevelSnapshot: "ORGANIZATION_ACCOUNT", organizationVerifiedSnapshot: true },
  });
  assert.equal(s.basis, "OBSERVED_AT_CAPTURE");
  assert.equal(acquisitionAccountLabel(s), "Authenticated email account");
  assert.equal(acquisitionWorkspaceLabel(s.workspaceKind), "Personal workspace");
  assert.equal(acquisitionOrganizationVerificationLabel(s), "Not established");
  assert.equal(acquisitionIdentityLevelLabel(s), "Authenticated email account");
  const line = acquisitionIdentitySummary(s);
  assert.equal(line, "Authenticated email account · Personal workspace · Organization verification: not established.");
  assert.doesNotMatch(line, /oauth|organization account/i);
  assert.doesNotMatch(line, RAW_ENUM);
});

test("an EMAIL account is never described as OAuth-backed; providers are named", () => {
  for (const [provider, label] of [
    ["EMAIL", "Authenticated email account"],
    ["GOOGLE", "Google account"],
    ["APPLE", "Apple account"],
    ["GUEST", "Guest session"],
  ]) {
    const s = resolveAcquisitionIdentitySnapshot({ custodyEvents: [created({ submittedByAuthProvider: provider, emailVerified: true })] });
    assert.equal(acquisitionAccountLabel(s), label);
  }
  const unverified = resolveAcquisitionIdentitySnapshot({ custodyEvents: [created({ submittedByAuthProvider: "EMAIL", emailVerified: false, identityLevelSnapshot: "BASIC_ACCOUNT" })] });
  assert.match(acquisitionAccountLabel(unverified), /not verified/);
});

test("workspace membership never implies organization verification", () => {
  const shared = resolveAcquisitionIdentitySnapshot({
    custodyEvents: [created({ identityLevelSnapshot: "ORGANIZATION_ACCOUNT", submittedByAuthProvider: "EMAIL", emailVerified: true, workspaceKind: "SHARED", organizationVerifiedSnapshot: false })],
  });
  assert.equal(acquisitionOrganizationVerificationLabel(shared), "Not established");
  assert.equal(acquisitionIdentityLevelLabel(shared), "Shared-workspace member account");
  const verified = resolveAcquisitionIdentitySnapshot({
    custodyEvents: [created({ identityLevelSnapshot: "VERIFIED_ORGANIZATION", submittedByAuthProvider: "GOOGLE", workspaceKind: "SHARED", organizationVerifiedSnapshot: true })],
  });
  assert.equal(acquisitionOrganizationVerificationLabel(verified), "Established at capture");
  assert.equal(acquisitionIdentityLevelLabel(verified), "Verified organization");
});

test("a later account / workspace change cannot rewrite the capture snapshot", () => {
  const events = [PERSONAL_VERIFIED_EMAIL, { eventType: "REPORT_IDENTITY_CONTEXT_RECORDED", payload: { identityLevelSnapshot: "VERIFIED_ORGANIZATION", organizationVerifiedSnapshot: true } }];
  const s = resolveAcquisitionIdentitySnapshot({
    custodyEvents: events,
    row: { identityLevelSnapshot: "VERIFIED_ORGANIZATION", organizationVerifiedSnapshot: true, submittedByAuthProvider: "GOOGLE" },
  });
  assert.equal(s.identityLevel, "VERIFIED_EMAIL");
  assert.equal(s.authProvider, "EMAIL");
  assert.equal(s.organizationVerified, false);
});

test("a legacy record without a creation event is shown, bounded, never strengthened", () => {
  const legacy = resolveAcquisitionIdentitySnapshot({
    custodyEvents: [],
    row: { identityLevelSnapshot: "ORGANIZATION_ACCOUNT", submittedByAuthProvider: "EMAIL", organizationVerifiedSnapshot: false },
  });
  assert.equal(legacy.basis, "RECORDED_ON_RECORD");
  assert.equal(legacy.workspaceKind, "NOT_RECORDED");
  // ORGANIZATION_ACCOUNT on a row that a report may have rewritten is not
  // stated as an organization or shared-workspace account.
  assert.equal(acquisitionIdentityLevelLabel(legacy), "Authenticated email account");
  assert.match(acquisitionIdentitySummary(legacy), /not bound to the capture time/);
  const none = resolveAcquisitionIdentitySnapshot({ custodyEvents: [], row: {} });
  assert.equal(none.basis, "UNAVAILABLE");
  assert.equal(acquisitionIdentitySummary(none), "Historical identity snapshot unavailable.");
  assert.equal(acquisitionOrganizationVerificationLabel(none), "Not recorded");
  // An older creation event without the new fields reads "not recorded".
  const old = resolveAcquisitionIdentitySnapshot({ custodyEvents: [created({ identityLevelSnapshot: "ORGANIZATION_ACCOUNT", submittedByAuthProvider: "EMAIL" })] });
  assert.equal(old.workspaceKind, "NOT_RECORDED");
  assert.equal(old.emailVerified, null);
  assert.equal(acquisitionIdentityLevelLabel(old), "Authenticated email account");
});

test("every stored level has a customer label; none is a raw enum or names OAuth", () => {
  for (const level of ["BASIC_ACCOUNT", "VERIFIED_EMAIL", "OAUTH_BACKED_IDENTITY", "ORGANIZATION_ACCOUNT", "VERIFIED_ORGANIZATION", null, "SOMETHING_NEW"]) {
    const label = identityLevelLabel(level);
    assert.doesNotMatch(label, RAW_ENUM, String(level));
    assert.doesNotMatch(label, /oauth/i, String(level));
    assert.notEqual(label, "Organization account");
  }
});

test("the snapshot is channel-independent: every acquisition mode reads the same event", () => {
  // createEvidence writes IDENTITY_SNAPSHOT_RECORDED for every channel; the
  // resolver reads it the same way whatever the mode.
  for (const mode of EVIDENCE_ACQUISITION_MODES) {
    const s = resolveAcquisitionIdentitySnapshot({
      custodyEvents: [{ eventType: "EVIDENCE_CREATED", payload: { acquisitionMode: mode } }, PERSONAL_VERIFIED_EMAIL],
    });
    assert.equal(s.basis, "OBSERVED_AT_CAPTURE", mode);
    assert.equal(acquisitionWorkspaceLabel(s.workspaceKind), "Personal workspace", mode);
  }
});

test("the ACTOR is recorded at capture: intake contributor, account, guest — and legacy reads only immutable facts", () => {
  const snap = (payload, acquisitionMode = null) =>
    resolveAcquisitionIdentitySnapshot({
      custodyEvents: [{ eventType: "IDENTITY_SNAPSHOT_RECORDED", atUtc: "2026-10-01T00:00:00.000Z", payload }],
      acquisitionMode,
    });
  const intake = snap(
    { submittedByAuthProvider: "EMAIL", actorKind: "INTAKE_CONTRIBUTOR", accountRole: "INTAKE_LINK_ISSUER", contributorEmailProvided: false },
    "SECURE_INTAKE_LINK",
  );
  assert.equal(intake.actorKind, "INTAKE_CONTRIBUTOR");
  assert.equal(intake.accountRole, "INTAKE_LINK_ISSUER");
  assert.equal(intake.contributorEmailProvided, false);
  assert.match(acquisitionActorLabel(intake), /not signed in; no email address was provided/);
  assert.match(acquisitionAccountRoleLabel(intake.accountRole), /issued the intake link \(not the contributor\)/);

  const account = snap({ submittedByAuthProvider: "GOOGLE", actorKind: "ACCOUNT_USER", accountRole: "SUBMITTER" }, "PROOVRA_WEB_UPLOAD");
  assert.equal(account.actorKind, "ACCOUNT_USER");
  assert.equal(acquisitionActorLabel(account), "Signed-in PROOVRA account");
  assert.equal(account.contributorEmailProvided, null);

  // An older event without the field: the actor comes from the IMMUTABLE
  // acquisition mode and the recorded provider — never from current state.
  assert.equal(snap({ submittedByAuthProvider: "EMAIL" }, "SECURE_INTAKE_LINK").actorKind, "INTAKE_CONTRIBUTOR");
  assert.equal(snap({ submittedByAuthProvider: "GUEST" }, "PROOVRA_WEB_UPLOAD").actorKind, "GUEST_SESSION");
  assert.equal(snap({ submittedByAuthProvider: "EMAIL" }, "DIRECT_SCREEN_CAPTURE_IOS").actorKind, "ACCOUNT_USER");
  assert.equal(snap({}, null).actorKind, "NOT_RECORDED");
});

test("a LEGACY record never claims organization verification its row may have been rewritten to", () => {
  const legacy = resolveAcquisitionIdentitySnapshot({
    custodyEvents: [],
    row: { identityLevelSnapshot: "ORGANIZATION_ACCOUNT", submittedByAuthProvider: "EMAIL", organizationVerifiedSnapshot: true },
    acquisitionMode: "PROOVRA_WEB_UPLOAD",
  });
  assert.equal(legacy.basis, "RECORDED_ON_RECORD");
  assert.equal(legacy.organizationVerified, null);
  assert.equal(legacy.actorKind, "ACCOUNT_USER");
});

test("a LEGACY intake record never presents the contributor's address as the issuing account's email", () => {
  const legacy = resolveAcquisitionIdentitySnapshot({
    custodyEvents: [],
    row: { identityLevelSnapshot: "VERIFIED_EMAIL", submittedByAuthProvider: "EMAIL", submittedByEmail: "contributor@example.test" },
    acquisitionMode: "SECURE_INTAKE_LINK",
  });
  assert.equal(legacy.accountRole, "INTAKE_LINK_ISSUER");
  assert.equal(legacy.submittedByEmail, null);
});
