/**
 * Phase 6 — public link projection tests.
 *
 * Locks in the projection contract for what external (unauthenticated)
 * contributors see when they hit GET /v1/external-intake/:token. The
 * projection MUST:
 *   - surface the workflow steps so the UI can render a real step picker
 *   - drop any malformed step entries safely
 *   - never leak workspace internals (recipient phone, ip allowlist,
 *     revoked reason, raw token, token hash)
 */

import { describe, expect, it } from "vitest";

import { projectIntakeLinkForExternalView } from "../src/services/workflow-intake-session.service.js";

function fakeLink(overrides: Record<string, unknown> = {}) {
  return {
    id: "link-1",
    teamId: "team-1",
    workflowTemplateId: null,
    workflowTemplateSlug: "general-evidence-record",
    workflowTemplateVersion: 1,
    workflowTemplateSnapshot: {
      id: "general-evidence-record",
      slug: "general-evidence-record",
      version: 1,
      name: "General Evidence Record",
      description: "Balanced intake for primary evidence and supporting context.",
      locationRequirement: "recommended",
      planMode: "CHECKLIST_REQUIRED",
      intakeModes: ["AUTHENTICATED_STANDARD", "AUTHENTICATED_GUIDED"],
      archived: false,
      steps: [
        {
          id: "primary_evidence",
          title: "Primary evidence file",
          description: "Upload the principal evidence item.",
          purposeLabel: "Primary evidence",
          required: true,
          acceptedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
        },
        {
          id: "supporting_context",
          title: "Supporting context",
          description: "Add supplemental files.",
          purposeLabel: "Supporting context",
          required: false,
          acceptedKinds: ["PHOTO", "DOCUMENT"],
        },
      ],
    },
    intakeMode: "EXTERNAL_ONE_TIME",
    caseId: null,
    tokenHash: "0".repeat(64),
    tokenVersion: 1,
    recipientLabel: "John Smith — claim 4842",
    recipientEmail: "jane@example.com",
    recipientPhone: "+15555555555",
    maxUses: 1,
    usedCount: 0,
    maxFileCountPerSession: 10,
    maxBytesPerSession: null,
    allowedAcceptedKinds: ["PHOTO", "VIDEO"],
    consentPolicyVersion: "2026-05-A",
    consentDisclosureText: null,
    status: "ACTIVE",
    expiresAtUtc: new Date("2026-05-20T00:00:00Z"),
    revokedAtUtc: null,
    revokedByUserId: null,
    revokedReason: "FORBIDDEN VALUE — should not leak",
    ipAllowlistCidrs: ["10.0.0.0/8"],
    createdByUserId: "user-admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Parameters<typeof projectIntakeLinkForExternalView>[0];
}

describe("projectIntakeLinkForExternalView", () => {
  it("returns the workflow steps projected from the snapshot", () => {
    const view = projectIntakeLinkForExternalView(fakeLink());
    expect(view.steps.length).toBe(2);
    expect(view.steps[0].id).toBe("primary_evidence");
    expect(view.steps[0].required).toBe(true);
    expect(view.steps[1].required).toBe(false);
    expect(view.workflowTemplatePlanMode).toBe("CHECKLIST_REQUIRED");
  });

  it("drops malformed steps but keeps valid ones", () => {
    const view = projectIntakeLinkForExternalView(
      fakeLink({
        workflowTemplateSnapshot: {
          name: "Bad Template",
          steps: [
            { id: "good", title: "OK", purposeLabel: "OK", required: true, acceptedKinds: ["PHOTO"] },
            { title: "missing id" },
            { id: "weird", required: "yes" },
            42,
            null,
          ],
        },
      }),
    );
    expect(view.steps.length).toBe(1);
    expect(view.steps[0].id).toBe("good");
  });

  it("filters unknown acceptedKinds out of each step", () => {
    const view = projectIntakeLinkForExternalView(
      fakeLink({
        workflowTemplateSnapshot: {
          name: "T",
          steps: [
            {
              id: "s",
              title: "S",
              purposeLabel: "S",
              required: true,
              acceptedKinds: ["PHOTO", "HOLOGRAM", "VIDEO", "WEAPONIZED_PDF"],
            },
          ],
        },
      }),
    );
    expect(view.steps[0].acceptedKinds).toEqual(["PHOTO", "VIDEO"]);
  });

  it("never includes workspace-internal fields", () => {
    const view = projectIntakeLinkForExternalView(fakeLink());
    const keys = Object.keys(view);
    for (const forbidden of [
      "tokenHash",
      "tokenVersion",
      "recipientEmail",
      "recipientPhone",
      "ipAllowlistCidrs",
      "revokedReason",
      "createdByUserId",
      "teamId",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("defaults planMode to FLEXIBLE when the snapshot lacks one", () => {
    const view = projectIntakeLinkForExternalView(
      fakeLink({
        workflowTemplateSnapshot: { name: "T", steps: [] },
      }),
    );
    expect(view.workflowTemplatePlanMode).toBe("FLEXIBLE");
    expect(view.steps).toEqual([]);
  });

  it("derives isAnonymous from the intake mode", () => {
    expect(
      projectIntakeLinkForExternalView(fakeLink({ intakeMode: "EXTERNAL_ANONYMOUS" }))
        .isAnonymous,
    ).toBe(true);
    expect(
      projectIntakeLinkForExternalView(fakeLink({ intakeMode: "EXTERNAL_PSEUDONYMOUS" }))
        .isAnonymous,
    ).toBe(true);
    expect(
      projectIntakeLinkForExternalView(fakeLink({ intakeMode: "EXTERNAL_ONE_TIME" }))
        .isAnonymous,
    ).toBe(false);
    expect(
      projectIntakeLinkForExternalView(fakeLink({ intakeMode: "EXTERNAL_REUSABLE" }))
        .isAnonymous,
    ).toBe(false);
  });
});
