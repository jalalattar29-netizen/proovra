/**
 * F-P1-07 — modal dialogs keep keyboard focus.
 *
 * Three dialogs said `aria-modal="true"` and let Tab walk out to the page
 * behind: the step-up confirmation (its header promised a trap; it had only an
 * Escape handler), the capture page's "Clear this evidence session?"
 * alertdialog (no focus move, no Escape) and the terms-acceptance step (no focus
 * move). They now use the trap ConfirmActionModal already had, lifted into
 * lib/ui/dialogFocus.ts.
 *
 * Each case drives the REAL component: focus is inside on open, Tab from the
 * last control wraps to the first, Shift+Tab from the first wraps to the last,
 * and (where the dialog closes) focus returns to the control that opened it.
 * API-driven dialogs use the real apiFetch over a stubbed fetch.
 */
import React, { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "../../lib/api";
import { StepUpModal, useStepUpAction } from "../../components/identity-security/StepUpModal";
import { LegalAcceptanceStep } from "../../components/legal/LegalAcceptanceStep";
import { CaptureClearConfirmDialog } from "../../app/(app)/capture/_lib/CaptureClearConfirmDialog";
import { dialogFocusables } from "../../lib/ui/dialogFocus";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** Tab / Shift+Tab at the two ends of `dialog` stays inside it. */
function expectTabContained(dialog: HTMLElement) {
  const items = dialogFocusables(dialog);
  expect(items.length).toBeGreaterThan(1);
  const first = items[0]!;
  const last = items[items.length - 1]!;
  last.focus();
  fireEvent.keyDown(last, { key: "Tab" });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);
}

describe("F-P1-07 — capture 'Clear this evidence session?'", () => {
  function Host() {
    const [open, setOpen] = useState(false);
    const [cleared, setCleared] = useState(false);
    return (
      <div>
        <button type="button" onClick={() => setOpen(true)}>
          Clear session…
        </button>
        <button type="button">Behind the dialog</button>
        {cleared ? <p>cleared</p> : null}
        <CaptureClearConfirmDialog
          open={open}
          onKeep={() => setOpen(false)}
          onClear={() => {
            setOpen(false);
            setCleared(true);
          }}
        />
      </div>
    );
  }

  it("moves focus to Keep Session, keeps Tab inside, Escape keeps the session and focus returns", async () => {
    render(<Host />);
    const opener = screen.getByRole("button", { name: "Clear session…" });
    opener.focus();
    fireEvent.click(opener);
    await flush();
    const dialog = screen.getByRole("alertdialog", { name: "Clear this evidence session?" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep Session" }));
    expectTabContained(dialog);

    // Focus that escaped (e.g. a click behind the backdrop) is pulled back by Tab.
    screen.getByRole("button", { name: "Behind the dialog" }).focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await flush();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByText("cleared")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("F-P1-07 — the terms-acceptance step", () => {
  const OWED = {
    ok: false,
    requiresReacceptance: true,
    missingPolicies: ["terms"],
    acceptedVersions: {},
    requiredVersions: { terms: "t2" },
  };

  it("focuses the agreement box, keeps Tab inside, and Escape is 'Not now'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, OWED)));
    render(<LegalAcceptanceStep active />);
    await waitFor(() => expect(document.querySelector("[data-legal-step]")).not.toBeNull());
    await flush();
    const dialog = screen.getByRole("dialog", { name: "Before you continue" });
    expect(document.activeElement).toBe(document.querySelector("[data-legal-step-agree]"));
    expectTabContained(dialog);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await flush();
    expect(document.querySelector("[data-legal-step]")).toBeNull();
  });
});

describe("F-P1-07 — the step-up confirmation", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
        if (path === "/v1/sensitive") {
          return json(401, {
            error: {
              code: "STEP_UP_REQUIRED",
              message: "Step-up verification required.",
              details: { purpose: "SESSION_SANITY_CHECK" },
            },
          });
        }
        if (path === "/v1/identity-security/step-up/start") {
          return json(200, { challenge: { id: "challenge-1" }, method: "TOTP" });
        }
        return json(404, { error: { code: "NOT_FOUND" } });
      }),
    );
  });

  function Host() {
    const control = useStepUpAction({ teamId: "22222222-2222-4222-8222-222222222222" });
    return (
      <div>
        <button
          type="button"
          onClick={() => {
            void control.runStepUpAction(() => apiFetch("/v1/sensitive", { method: "POST" })).catch(() => undefined);
          }}
        >
          Do the sensitive thing
        </button>
        <StepUpModal control={control} />
      </div>
    );
  }

  it("focus is inside on open and Tab wraps at both ends; cancelling returns focus", async () => {
    render(<Host />);
    const opener = screen.getByRole("button", { name: "Do the sensitive thing" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Step-up confirmation" });
    await waitFor(() => expect(dialog.getAttribute("data-step-up-state")).toBe("verifying"));
    await flush();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expectTabContained(dialog);

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await flush();
    expect(screen.queryByRole("dialog", { name: "Step-up confirmation" })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
