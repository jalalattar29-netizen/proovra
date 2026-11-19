/**
 * PRO-I1-02 — a contributor who staged files, left them for more than the
 * 24 h reservation window and then pressed Submit.
 *
 * The server no longer holds those files (the reservation expired; completion
 * refuses it and the sweep releases it). Before, that reached the page as
 * INTAKE_NOT_ACCEPTING_EVIDENCE — "Nothing is wrong with your file — please
 * contact the sender" — which is untrue (the link works) and not recoverable.
 * The API now answers 409 SUBMISSION_EXPIRED and frees the session; the page
 * says what happened, clears the stale list and keeps the upload form so the
 * files can be added again on the same link.
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

let submitAnswer: { status: number; body: unknown };
let submits = 0;

beforeEach(() => {
  submits = 0;
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
            ],
          },
        };
      } else if (method === "POST" && path.endsWith("/submit")) {
        submits += 1;
        out = submitAnswer;
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

async function openAndSubmit() {
  const view = render(<ExternalIntakePage params={resolvedParams({ token: "pwi_v1_stale" })} />);
  await flush();
  expect(view.container.querySelector("[data-intake-phase]")?.getAttribute("data-intake-phase")).toBe("upload");
  expect(view.container.querySelectorAll("[data-intake-part-filename]")).toHaveLength(1);
  const submit = view.container.querySelector("button.ipk-submit") as HTMLButtonElement;
  expect(submit.disabled).toBe(false);
  await act(async () => {
    submit.click();
  });
  await flush();
  return view;
}

describe("PRO-I1-02 — submit after the staged files' reservation expired", () => {
  it("says the files timed out, clears the stale list and keeps the upload form (recoverable, not a fault)", async () => {
    submitAnswer = {
      status: 409,
      body: { error: { code: "SUBMISSION_EXPIRED", message: "server sentence" } },
    };
    const view = await openAndSubmit();
    expect(submits).toBe(1);
    const notice = view.container.querySelector("[data-intake-error-kind]") as HTMLElement;
    expect(notice).not.toBeNull();
    // A refusal the platform meant, not "Something went wrong"; no support id.
    expect(notice.getAttribute("data-intake-error-kind")).toBe("denial");
    expect(view.container.querySelector("[data-intake-support-id]")).toBeNull();
    expect(notice.textContent).toContain("added more than 24 hours ago");
    expect(notice.textContent).toContain("add your files again");
    expect(notice.textContent).toContain("nothing was submitted");
    // Never the capacity sentence, and never "your uploads are still here".
    expect(notice.textContent).not.toContain("contact the sender");
    expect(notice.textContent).not.toContain("still here");
    // The page shows what the server holds now: nothing staged; the form stays.
    expect(view.container.querySelector("[data-intake-phase]")?.getAttribute("data-intake-phase")).toBe("upload");
    expect(view.container.querySelectorAll("[data-intake-part-filename]")).toHaveLength(0);
    expect(view.container.querySelector("[data-intake-add-files-btn]")).not.toBeNull();
  });

  it("a genuine submit fault still keeps the staged files and the retry line", async () => {
    submitAnswer = {
      status: 500,
      body: { error: { code: "SUBMIT_FAILED", message: "server sentence", requestId: "req-123" } },
    };
    const view = await openAndSubmit();
    expect(view.container.querySelectorAll("[data-intake-part-filename]")).toHaveLength(1);
    expect(view.container.textContent).toContain("Your uploads are still here");
  });
});
