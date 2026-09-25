/**
 * The message projection carries the intake link a delivery was sent for.
 *
 * `relatedIntakeLinkId` is written on every intake send and GET
 * /v1/communications/messages filters by it, but projectCommunicationMessage
 * never returned it. Home (web `latestDeliveryByLink`, native `home-intake`)
 * matches each message to its link by exactly this field, so no link ever had
 * a delivery status and "Failed sends" was always 0.
 */
import { describe, expect, it } from "vitest";

import { projectCommunicationMessage } from "../src/services/communications/communication.service.js";

const row = {
  id: "m1",
  channel: "SMS",
  direction: "OUTBOUND",
  purpose: "INTAKE_LINK",
  status: "FAILED",
  provider: "twilio",
  recipientPreview: "+44 ••• 12",
  bodyPreview: null,
  attemptCount: 2,
  nextAttemptAtUtc: null,
  errorCode: "30007",
  relatedEvidenceId: null,
  relatedEvidenceRequestId: null,
  relatedDiscussionThreadId: null,
  relatedIntakeSessionId: null,
  relatedIntakeLinkId: "0f0f0f0f-0000-4000-8000-000000000001",
  createdAt: new Date("2026-09-21T10:00:00.000Z"),
  sentAtUtc: null,
  deliveredAtUtc: null,
  failedAtUtc: new Date("2026-09-21T10:00:05.000Z"),
};

describe("projectCommunicationMessage", () => {
  it("projects the intake link a message was sent for", () => {
    const out = projectCommunicationMessage(row as unknown as Parameters<typeof projectCommunicationMessage>[0]);
    expect(out.relatedIntakeLinkId).toBe("0f0f0f0f-0000-4000-8000-000000000001");
    expect(out.status).toBe("FAILED");
  });

  it("projects null when the message is not about an intake link", () => {
    const out = projectCommunicationMessage({ ...row, relatedIntakeLinkId: null } as unknown as Parameters<typeof projectCommunicationMessage>[0]);
    expect(out.relatedIntakeLinkId).toBeNull();
  });
});
