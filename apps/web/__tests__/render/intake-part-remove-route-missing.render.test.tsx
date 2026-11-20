/**
 * WEB-OLD-API-COMPAT — the contributor removes a staged file on an API that
 * has no part-removal route (DELETE /v1/external-intake/:token/sessions/:sid
 * /parts/:partId answers the canonical 404 ROUTE_NOT_FOUND).
 *
 * Before: the generic "please try again" line under a Remove that could never
 * work, while the file stayed staged. Now Remove is withdrawn, the file stays
 * listed, and the page says it will be sent on submit and how to keep it out.
 * A current API still removes the file.
 *
 * Uses the REAL apiFetch over a stubbed fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import ExternalIntakePage from "../../app/intake/[token]/page";

function resolvedParams<T extends object>(value: T): Promise<T> {
  const p = Promise.resolve(value) as Promise<T> & { status?: string; value?: T };
  p.status = "fulfilled";
  p.value = value;
  return p;
}

const SESSION = {
  id: "5e551045-0000-4000-8000-000000000001",
  status: "UPLOAD_STARTED",
  consentAcceptedAtUtc: "2026-11-17T09:00:00.000Z",
  expiresAtUtc: "2026-12-17T09:00:00.000Z",
};
const LINK = {
  workflowTemplateSlug: "general-evidence-record",
  workflowTemplateName: "General evidence record",
  workflowTemplateDescription: "",
  workflowTemplateLocationRequirement: "NONE",
  workflowTemplatePlanMode: "FREEFORM",
  steps: [],
  intakeMode: "EXTERNAL_REUSABLE",
  isAnonymous: false,
  consentPolicyVersion: "v1",
  consentDisclosureText: null,
  allowedAcceptedKinds: [],
  maxFileCountPerSession: null,
  maxFileBytes: null,
  expiresAtUtc: "2026-12-17T09:00:00.000Z",
  locationPolicy: "NONE",
};

let deleteAnswer: { status: number; body: unknown };
const deletes: string[] = [];

beforeEach(() => {
  deletes.length = 0;
  window.sessionStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, "");
      const method = init?.method ?? "GET";
      let out: { status: number; body: unknown } = { status: 200, body: {} };
      if (method === "GET" && path.startsWith("/v1/external-intake/")) {
        out = {
          status: 200,
          body: {
            link: LINK,
            session: SESSION,
            request: null,
            resumed: true,
            parts: [
              { id: "part-1", partIndex: 0, originalFileName: "roof.jpg", mimeType: "image/jpeg", checklistStepId: null, sizeBytes: 1200, stored: true },
              { id: "part-2", partIndex: 1, originalFileName: "id-card.jpg", mimeType: "image/jpeg", checklistStepId: null, sizeBytes: 900, stored: true },
            ],
          },
        };
      } else if (method === "DELETE") {
        deletes.push(path);
        out = deleteAnswer;
      }
      return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
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

async function openAndRemoveSecond() {
  const view = render(<ExternalIntakePage params={resolvedParams({ token: "pwi_v1_compat" })} />);
  await flush();
  expect(view.container.querySelectorAll("[data-intake-part-filename]")).toHaveLength(2);
  const remove = view.container.querySelector('[data-intake-part-remove="part-2"]') as HTMLButtonElement;
  expect(remove).not.toBeNull();
  await act(async () => {
    remove.click();
  });
  await flush();
  return view;
}

describe("WEB-OLD-API-COMPAT — removing a staged file", () => {
  it("an API without the route: Remove is withdrawn, the file stays and the page says it will be sent", async () => {
    deleteAnswer = { status: 404, body: { error: { code: "ROUTE_NOT_FOUND", message: "Resource not found.", requestId: "r1" } } };
    const view = await openAndRemoveSecond();
    expect(deletes).toEqual([`/v1/external-intake/pwi_v1_compat/sessions/${SESSION.id}/parts/part-2`]);
    // Nothing was removed: both files stay listed (the server still holds them).
    expect(view.container.querySelectorAll("[data-intake-part-filename]")).toHaveLength(2);
    // No Remove control is left that could never work.
    expect(view.container.querySelectorAll("[data-intake-part-remove]")).toHaveLength(0);
    const note = view.container.querySelector("[data-intake-remove-unavailable]") as HTMLElement;
    expect(note).not.toBeNull();
    expect(note.textContent).toContain("still included and will be sent if you submit");
    // Not the generic retry line.
    expect(view.container.textContent).not.toContain("Please try again, or contact the sender.");
  });

  it("a current API removes the file", async () => {
    deleteAnswer = { status: 200, body: { removed: true } };
    const view = await openAndRemoveSecond();
    expect(view.container.querySelectorAll("[data-intake-part-filename]")).toHaveLength(1);
    expect(view.container.querySelector("[data-intake-remove-unavailable]")).toBeNull();
    expect(view.container.querySelectorAll("[data-intake-part-remove]")).toHaveLength(1);
  });

  it("a business refusal keeps Remove and shows the mapped line", async () => {
    deleteAnswer = { status: 409, body: { error: { code: "SESSION_TERMINAL", message: "sealed" } } };
    const view = await openAndRemoveSecond();
    expect(view.container.querySelectorAll("[data-intake-part-filename]")).toHaveLength(2);
    expect(view.container.querySelectorAll("[data-intake-part-remove]")).toHaveLength(2);
    expect(view.container.textContent).toContain("This submission has already been completed");
  });
});
