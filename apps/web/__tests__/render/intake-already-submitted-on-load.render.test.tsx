/**
 * Final Free acceptance pass (2026-11-18), evidence journey J7 / F5.
 *
 * Reopening a submitted ONE_TIME intake link must land on the read-only
 * "Already submitted" page. The API now answers 410 LINK_ALREADY_SUBMITTED on
 * load (F5), and the load catch sets `already_submitted` — but the page's
 * error branch (`phase === "error" || !link || !session`) was tested first, and
 * on a fresh load there is no link or session, so a real browser saw the
 * generic "This link cannot be opened." instead.
 *
 * Uses the REAL apiFetch over a stubbed fetch, so the error shape is what the
 * page actually receives.
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

let answer: { status: number; body: unknown };

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } }),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function open(token: string) {
  const view = render(<ExternalIntakePage params={resolvedParams({ token })} />);
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  return view;
}

describe("public intake page on load", () => {
  it("a submitted one-time link opens on the read-only Already submitted page", async () => {
    answer = {
      status: 410,
      body: { error: { code: "LINK_ALREADY_SUBMITTED", message: "This upload link has already been used." } },
    };
    const view = await open("pwi_v1_submitted");
    const main = view.container.querySelector("[data-intake-phase]");
    expect(main?.getAttribute("data-intake-phase")).toBe("already_submitted");
    expect(view.getByText("Already submitted")).toBeTruthy();
  });

  it("a revoked or expired link still shows the unavailable page", async () => {
    answer = {
      status: 410,
      body: { error: { code: "LINK_NO_LONGER_AVAILABLE", message: "This upload link is no longer available. It may have expired or been revoked." } },
    };
    const view = await open("pwi_v1_revoked");
    const main = view.container.querySelector("[data-intake-phase]");
    expect(main?.getAttribute("data-intake-phase")).toBe("link_unavailable");
    expect(main?.getAttribute("data-intake-error-class")).toBe("expired-or-revoked");
  });
});
