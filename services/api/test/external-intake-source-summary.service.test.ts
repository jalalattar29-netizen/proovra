/**
 * Phase 6 — external intake source summary tests.
 *
 * Pure unit tests for the projection-only `buildSummary` helper. No DB
 * required. The goal is to lock in the privacy boundary: anonymous /
 * pseudonymous sessions must never leak submitter identity even if the
 * session row erroneously stores one.
 */

import { describe, expect, it } from "vitest";

import { buildSummary } from "../src/services/external-intake-source-summary.service.js";

function fakeLink(overrides: Record<string, unknown> = {}) {
  return {
    id: "link-1",
    teamId: "team-1",
    workflowTemplateId: null,
    workflowTemplateSlug: "general-evidence-record",
    workflowTemplateVersion: 1,
    workflowTemplateSnapshot: { name: "General Evidence Record" },
    intakeMode: "EXTERNAL_ONE_TIME",
    caseId: null,
    tokenHash: "0".repeat(64),
    tokenVersion: 1,
    recipientLabel: "John Smith — claim 4842",
    // A real address in the fixture, so the masking is actually exercised
    // rather than passing because there was nothing to mask.
    recipientEmail: "recipient-privacy-canary@example.test",
    recipientPhone: "+4915112345678",
    recipientPhoneE164: null,
    customerId: null,
    maxUses: 1,
    usedCount: 1,
    maxFileCountPerSession: 10,
    maxBytesPerSession: null,
    allowedAcceptedKinds: [],
    consentPolicyVersion: "2026-05-A",
    consentDisclosureText: null,
    status: "EXPIRED",
    expiresAtUtc: new Date("2026-05-20T00:00:00Z"),
    revokedAtUtc: null,
    revokedByUserId: null,
    revokedReason: null,
    ipAllowlistCidrs: [],
    // Intake-link enterprise messaging — new sender identity columns
    // (default PROOVRA mode, no custom display name).
    senderDisplayMode: "PROOVRA",
    senderDisplayName: null,
    archivedAtUtc: null,
    archivedByUserId: null,
    locationPolicy: "NONE",
    createdByUserId: "user-admin",
    createdAt: new Date("2026-05-16T10:00:00Z"),
    updatedAt: new Date("2026-05-16T11:00:00Z"),
    ...overrides,
  } as Parameters<typeof buildSummary>[0];
}

function fakeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    intakeLinkId: "link-1",
    status: "SUBMITTED",
    openedAtUtc: new Date("2026-05-16T10:30:00Z"),
    uploadStartedAtUtc: new Date("2026-05-16T10:35:00Z"),
    uploadCompletedAtUtc: new Date("2026-05-16T10:40:00Z"),
    submittedAtUtc: new Date("2026-05-16T10:45:00Z"),
    abandonedAtUtc: null,
    revokedAtUtc: null,
    expiresAtUtc: new Date("2026-05-20T00:00:00Z"),
    guestIdentityId: null,
    pseudonym: null,
    submitterDisplayName: "Jane Doe",
    submitterEmail: "jane@example.com",
    captureSessionId: null,
    evidenceId: "evidence-1",
    consentAcceptedAtUtc: new Date("2026-05-16T10:31:00Z"),
    consentSnapshotJson: null,
    submitterIpHash: "abc".repeat(20) + "ab",
    submitterUserAgent: "Mozilla/5.0",
    createdAt: new Date("2026-05-16T10:30:00Z"),
    updatedAt: new Date("2026-05-16T10:45:00Z"),
    ...overrides,
  } as Parameters<typeof buildSummary>[1];
}

describe("buildSummary — happy path", () => {
  it("returns a stable authenticated-safe shape for a ONE_TIME submission", () => {
    const s = buildSummary(fakeLink(), fakeSession());
    expect(s.source).toBe("external_intake");
    expect(s.intakeMode).toBe("EXTERNAL_ONE_TIME");
    expect(s.workflowTemplateName).toBe("General Evidence Record");
    expect(s.workflowTemplateVersion).toBe(1);
    expect(s.link.id).toBe("link-1");
    expect(s.link.recipientLabel).toBe("John Smith — claim 4842");
    expect(s.session.submittedAtUtc).toBe("2026-05-16T10:45:00.000Z");
  });

  it("preserves contributor identity for non-anonymous modes", () => {
    const s = buildSummary(fakeLink({ intakeMode: "EXTERNAL_ONE_TIME" }), fakeSession());
    expect(s.session.submitterDisplayName).toBe("Jane Doe");
    expect(s.session.submitterEmail).toBe("jane@example.com");
    expect(s.isAnonymous).toBe(false);
  });
});

describe("buildSummary — privacy boundary", () => {
  it("scrubs submitter email and display name for ANONYMOUS mode", () => {
    const s = buildSummary(
      fakeLink({ intakeMode: "EXTERNAL_ANONYMOUS" }),
      fakeSession({
        submitterDisplayName: "Jane Doe",
        submitterEmail: "jane@example.com",
        pseudonym: "should_be_ignored",
      }),
    );
    expect(s.isAnonymous).toBe(true);
    expect(s.session.submitterDisplayName).toBeNull();
    expect(s.session.submitterEmail).toBeNull();
    // ANONYMOUS does not surface a pseudonym either.
    expect(s.session.pseudonym).toBeNull();
  });

  it("scrubs submitter email but surfaces pseudonym for PSEUDONYMOUS mode", () => {
    const s = buildSummary(
      fakeLink({ intakeMode: "EXTERNAL_PSEUDONYMOUS" }),
      fakeSession({
        submitterDisplayName: "Jane Doe",
        submitterEmail: "jane@example.com",
        pseudonym: "concerned-source",
      }),
    );
    expect(s.isAnonymous).toBe(true);
    expect(s.session.submitterDisplayName).toBeNull();
    expect(s.session.submitterEmail).toBeNull();
    expect(s.session.pseudonym).toBe("concerned-source");
  });

  it("never returns IP hash or raw user agent", () => {
    const s = buildSummary(
      fakeLink(),
      fakeSession({
        submitterIpHash: "f".repeat(64),
        submitterUserAgent: "Mozilla/5.0",
      }),
    );
    // Confirm the surface shape: pick every key and ensure these forbidden
    // ones are not in the projection at all.
    const sessionKeys = Object.keys(s.session);
    expect(sessionKeys).not.toContain("submitterIpHash");
    expect(sessionKeys).not.toContain("submitterUserAgent");
    expect(sessionKeys).not.toContain("consentSnapshotJson");
    expect(sessionKeys).not.toContain("guestIdentityId");

    const linkKeys = Object.keys(s.link);
    expect(linkKeys).not.toContain("tokenHash");
    expect(linkKeys).not.toContain("tokenVersion");
    /*
     * The raw columns ARE keys — and they are null here, because
     * `buildSummary` defaults to MASKED and this fixture passed no decision.
     * That default is the assertion worth making: a caller who forgets to
     * resolve the disclosure discloses nothing.
     *
     * An authorized operator now gets the raw value in the projection rather
     * than behind a per-row reveal (that made an operator click once per row
     * to answer "who did I send this to?"), and the test for THAT lives in
     * recipient-contact-disclosure.test.ts where the decision is an input.
     */
    expect(s.link.recipientEmail).toBeNull();
    expect(s.link.recipientPhone).toBeNull();
    expect(s.link.recipientEmailMasked).toBe("r***@example.test");
    expect(JSON.stringify(s)).not.toContain("recipient-privacy-canary@example.test");
    expect(JSON.stringify(s)).not.toContain("4915112345678");
    expect(s.link.recipientContactRevealAuthorized).toBe(false);
    expect(linkKeys).not.toContain("ipAllowlistCidrs");
    expect(linkKeys).not.toContain("revokedReason");
    expect(linkKeys).not.toContain("consentDisclosureText");
  });
});

describe("buildSummary — defensive against bad snapshot", () => {
  it("falls back to the slug when the snapshot has no name", () => {
    const s = buildSummary(
      fakeLink({ workflowTemplateSnapshot: {} }),
      fakeSession(),
    );
    expect(s.workflowTemplateName).toBe("general-evidence-record");
  });

  it("falls back to the slug when the snapshot is null", () => {
    const s = buildSummary(
      fakeLink({ workflowTemplateSnapshot: null }),
      fakeSession(),
    );
    expect(s.workflowTemplateName).toBe("general-evidence-record");
  });
});
