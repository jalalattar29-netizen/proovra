/**
 * The intake card and the review queue read the workflow STATE and the
 * server's current-round DECISION separately (2026-10-24, fifth audit).
 *
 * The intake card showed the state only and re-derived "this verdict is
 * recorded" on the client as `status === the verdict's stage` — so after
 * Approve then Close nothing on it read Approved. The review queue printed
 * the raw stage and SLA enums and ignored the decision the server sends.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

let reply: (path: string, method: string) => unknown = () => ({});

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string }) => {
    const r = await reply(path, init?.method ?? "GET");
    if (r instanceof Error) throw r;
    return r;
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import ExternalIntakeSourceCard from "../../app/(app)/evidence/[id]/components/ExternalIntakeSourceCard";

afterEach(() => cleanup());

const intakeSummary = {
  source: "external_intake",
  intakeMode: "LINK",
  isAnonymous: false,
  workflowTemplateSlug: "general",
  workflowTemplateName: "General",
  workflowTemplateVersion: 1,
  caseId: null,
  link: {
    id: "l1",
    status: "USED",
    expiresAtUtc: "2026-11-01T00:00:00.000Z",
    usedCount: 1,
    maxUses: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    createdByUserId: "u1",
    recipientLabel: null,
    customerId: null,
    recipientEmailMasked: null,
    recipientPhoneMasked: null,
    recipientEmail: null,
    recipientPhone: null,
    hasRecipientEmail: false,
    hasRecipientPhone: false,
    recipientContactRevealAuthorized: false,
    revokedAtUtc: null,
  },
  session: {
    id: "s1",
    status: "SUBMITTED",
    submitterDisplayName: null,
    submitterEmail: null,
    submitterPhone: null,
    pseudonym: null,
    openedAtUtc: null,
    uploadStartedAtUtc: null,
    uploadCompletedAtUtc: null,
    submittedAtUtc: null,
    consentAcceptedAtUtc: null,
    consentPolicyVersion: null,
  },
};

function serve(workflow: Record<string, unknown>) {
  reply = (path) => {
    if (path.endsWith("/external-intake-summary")) return { summary: intakeSummary };
    if (path.endsWith("/reviewer-workflow")) return { available: true, workflow };
    return {};
  };
}

describe("intake card — state and decision from the server", () => {
  it("Approve then Close: the card reads Closed and Decision: Approved, and the Approve verdict shows as recorded", async () => {
    serve({ id: "w1", status: "CLOSED", workflowStateLabel: "Closed", decision: "APPROVED", decisionLabel: "Approved" });
    const { container } = render(<ExternalIntakeSourceCard evidenceId="e1" />);
    await waitFor(() => expect(container.querySelector("[data-evidence-reviewer-current-status]")?.textContent).toBe("Closed"));
    expect(container.querySelector("[data-evidence-reviewer-current-decision]")?.textContent).toBe("Decision: Approved");
    const approve = container.querySelector('[data-evidence-reviewer-decision-btn="APPROVE_INTERNAL"]');
    const reject = container.querySelector('[data-evidence-reviewer-decision-btn="REJECT_INSUFFICIENT"]');
    expect(approve?.getAttribute("aria-pressed")).toBe("true");
    expect(reject?.getAttribute("aria-pressed")).toBe("false");
  });

  it("Close with no verdict: Decision: No decision, and no verdict shows as recorded", async () => {
    serve({ id: "w1", status: "CLOSED", workflowStateLabel: "Closed", decision: "NO_DECISION", decisionLabel: "No decision" });
    const { container } = render(<ExternalIntakeSourceCard evidenceId="e1" />);
    await waitFor(() => expect(container.querySelector("[data-evidence-reviewer-current-status]")?.textContent).toBe("Closed"));
    expect(container.querySelector("[data-evidence-reviewer-current-decision]")?.textContent).toBe("Decision: No decision");
    for (const d of ["APPROVE_INTERNAL", "REJECT_INSUFFICIENT", "REQUEST_MORE_INFO"]) {
      expect(container.querySelector(`[data-evidence-reviewer-decision-btn="${d}"]`)?.getAttribute("aria-pressed"), d).toBe("false");
    }
  });
});

describe("review queue — shared labels, never raw enums", () => {
  it("the shared presenters name every stage and SLA state for people", async () => {
    const { reviewSlaLabel, reviewStageFilterLabel, reviewStatusLabel, reviewWorkflowStateLabel } = await import("@proovra/shared");
    expect(reviewStageFilterLabel("APPROVED_INTERNAL")).toBe("Approved, not yet closed");
    expect(reviewStageFilterLabel("REJECTED_INSUFFICIENT")).toBe("Not accepted, not yet closed");
    for (const sla of ["ON_TRACK", "DUE_SOON", "OVERDUE", "BREACHED", "PAUSED"]) {
      expect(reviewSlaLabel(sla)).not.toMatch(/^[A-Z_]+$/);
    }
    for (const stage of ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_MORE_INFO", "RESPONSE_RECEIVED", "APPROVED_INTERNAL", "REJECTED_INSUFFICIENT", "ESCALATED", "REOPENED", "CLOSED"]) {
      expect(reviewStatusLabel(stage)).not.toMatch(/^[A-Z_]+$/);
      expect(reviewWorkflowStateLabel(stage)).not.toMatch(/^[A-Z_]+$/);
      expect(reviewStageFilterLabel(stage)).not.toMatch(/^[A-Z_]+$/);
    }
  });
});

describe("review queue page — source pins", () => {
  it("renders the state label and the server decision, never the raw stage or SLA enum", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../../app/(app)/review/operations/page.tsx"), "utf8");
    expect(src).not.toMatch(/>\{w\.stage\}</);
    expect(src).not.toMatch(/\{w\.slaStatus\}\n/);
    expect(src).toMatch(/data-review-queue-decision/);
    expect(src).toMatch(/w\.decisionLabel/);
    expect(src).not.toMatch(/label="Approved \(internal\)"/);
    expect(src).not.toMatch(/reviewStatusLabel\(/);
    expect(src).toMatch(/reviewStageFilterLabel\(s\)/);
  });
});
