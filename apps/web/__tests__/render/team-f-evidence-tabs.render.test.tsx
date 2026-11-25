/**
 * Team remediation stage F — Evidence Detail tab states (T-141, T-142; audit
 * JRN-08 e, f). The REAL apiFetch over a stubbed `fetch`.
 *
 *   - T-141: a failed Derived Review status read used to read as "No derived
 *     review has been generated" with a Generate button.
 *   - T-142: a failed message load used to put its error in the thread-list
 *     slot ("Discussion could not be loaded"), where it stayed after a
 *     successful reload.
 */
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../components/presence/PresenceIndicator", () => ({ PresenceIndicator: () => null }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: async () => true }) }));

import EvidenceDiscussionPanel from "../../app/(app)/evidence/[id]/components/EvidenceDiscussionPanel";
import { EvidenceDerivedReviewTab } from "../../app/(app)/evidence/[id]/_tabs/EvidenceDerivedReviewTab";
import { PlatformContextProvider } from "../../lib/platform-context";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EV = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const THREAD = "11111111-1111-4111-8111-111111111111";

type Answer = { status: number; body: unknown };
let routes: Array<{ match: (path: string, method: string) => boolean; answers: Answer[] }>;

beforeEach(() => {
  routes = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, "");
      const method = init?.method ?? "GET";
      const r = routes.find((x) => x.match(path, method));
      const a = r ? (r.answers.length > 1 ? r.answers.shift()! : r.answers[0]!) : { status: 200, body: {} };
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const flush = async () => {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};
const fail = (status = 500): Answer => ({ status, body: { error: { code: "INTERNAL_ERROR", message: "boom" } } });

describe("T-142 — Discussion: a message-load error belongs to the thread", () => {
  it("a failed then successful message load leaves no error in the list slot, and Retry clears the thread error", async () => {
    const thread = {
      id: THREAD, evidenceId: EV, kind: "EVIDENCE_GENERAL", status: "OPEN", visibility: "INTERNAL",
      title: "Custody question", createdByUserId: "u1", assignedToUserId: null, resolvedAtUtc: null,
      reopenCount: 0, escalatedAtUtc: null, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    };
    routes.push(
      { match: (p) => p.startsWith("/v1/collaboration/threads?"), answers: [{ status: 200, body: { threads: [thread] } }] },
      {
        match: (p) => p.includes("/messages"),
        answers: [
          fail(503),
          { status: 200, body: { messages: [{ id: "m1", threadId: THREAD, authorKind: "USER", authorUserId: "u1", contributorLabel: null, body: "Hello there", editedAtUtc: null, createdAt: "2026-09-01T00:00:00.000Z" }] } },
        ],
      },
      { match: (p) => p.startsWith(`/v1/collaboration/threads/${THREAD}?`), answers: [{ status: 200, body: { thread, resolutionNote: null, escalationReason: null } }] },
      { match: (p) => p.startsWith("/v1/teams/"), answers: [{ status: 200, body: { members: [], nextCursor: null } }] },
    );
    render(<EvidenceDiscussionPanel evidenceId={EV} teamId={TEAM} initialThreadId={THREAD} readOnly={false} />);
    await flush();
    expect(document.querySelector("[data-evidence-discussion-messages-unavailable]")).not.toBeNull();
    // Not in the thread-list slot.
    expect(document.querySelector("[data-evidence-discussion-error]")).toBeNull();
    await act(async () => {
      fireEvent.click(document.querySelector("[data-evidence-discussion-messages-retry]") as HTMLElement);
    });
    await flush();
    expect(document.querySelector("[data-evidence-discussion-messages-unavailable]")).toBeNull();
    expect(document.querySelector("[data-evidence-discussion-error]")).toBeNull();
    expect(document.body.textContent).toContain("Hello there");
  });
});

describe("T-141 — Derived Review: a failed status read is an error, not 'not generated'", () => {
  function mountDerived() {
    const ctx = { evidenceId: EV, workspace: { reviewWorkflow: { teamId: TEAM } } };
    return render(
      <PlatformContextProvider testEnvelope={null as never}>
        <EvidenceDerivedReviewTab ctx={ctx as never} />
      </PlatformContextProvider>,
    );
  }

  it("a 500 shows an error with Retry and no Generate", async () => {
    routes.push({ match: (p) => p.includes("/derived-review?"), answers: [fail(500)] });
    mountDerived();
    await flush();
    expect(document.querySelector("[data-derived-review-read-error]")).not.toBeNull();
    expect(document.body.textContent).not.toContain("No derived review has been generated");
    const buttons = Array.from(document.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons).not.toContain("Generate Derived Review");
    expect(buttons).toContain("Retry");
  });

  it("a genuinely not-requested review still offers Generate (control)", async () => {
    routes.push({
      match: (p) => p.includes("/derived-review?"),
      answers: [{ status: 200, body: { status: { status: "NOT_REQUESTED", lastError: null }, projection: null, release: null, keyframeBytesUrls: {} } }],
    });
    mountDerived();
    await flush();
    expect(document.querySelector("[data-derived-review-read-error]")).toBeNull();
    expect(Array.from(document.querySelectorAll("button")).map((b) => b.textContent)).toContain("Generate Derived Review");
  });
});
