/**
 * RGA-03 (validated reason field in the Confirm modal) and RGA-02 (offer
 * revalidation INSIDE the Confirm path) — proven by rendering the real
 * components under jsdom.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, fireEvent, waitFor } from "@testing-library/react";

import {
  ConfirmActionProvider,
  useConfirmAction,
} from "../../components/ui/ConfirmActionModal";
import { NewVersionMenu } from "../../components/evidence-outputs/NewVersionMenu";
import {
  NEW_VERSION_ACTION,
  NEW_VERSION_REASON_MAX,
  normalizeNewVersionReason,
  validateNewVersionReason,
  newVersionReasonError,
} from "@proovra/shared";

beforeEach(() => cleanup());
afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// RGA-03 — the validated reason field gates Confirm.
// ---------------------------------------------------------------------------

function ReasonHarness({ onConfirmed }: { onConfirmed: (v: string) => void }) {
  const { confirm } = useConfirmAction();
  return (
    <button
      type="button"
      data-testid="open"
      onClick={() =>
        void confirm({
          title: "Generate report v2",
          reasonField: {
            label: "Reason",
            max: NEW_VERSION_REASON_MAX,
            countOf: (raw) => normalizeNewVersionReason(raw).length,
            validate: (raw) => {
              const v = validateNewVersionReason(raw);
              return v.ok
                ? { ok: true, value: v.value }
                : { ok: false, value: v.value, message: newVersionReasonError(v.reason) };
            },
            onConfirmed,
          },
          testId: "rf",
        })
      }
    >
      open
    </button>
  );
}

describe("RGA-03 reason field (jsdom)", () => {
  it("disables Confirm until valid, shows a live counter and an accessible error", async () => {
    const onConfirmed = vi.fn();
    render(
      <ConfirmActionProvider>
        <ReasonHarness onConfirmed={onConfirmed} />
      </ConfirmActionProvider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("open"));
    });
    const submit = document.querySelector('[data-confirm-action-submit="true"]') as HTMLButtonElement;
    const input = document.querySelector("[data-new-version-reason]") as HTMLTextAreaElement;
    const counter = document.querySelector("[data-confirm-action-reason-count]") as HTMLElement;
    expect(submit).toBeTruthy();
    expect(submit.disabled).toBe(true); // nothing typed
    expect(counter.textContent).toBe(`0/${NEW_VERSION_REASON_MAX}`);

    // Too short → still disabled, error shown + aria wired.
    await act(async () => fireEvent.change(input, { target: { value: "ab" } }));
    expect(submit.disabled).toBe(true);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const errId = input.getAttribute("aria-describedby")!;
    const err = document.getElementById(errId)!;
    expect(err.textContent && err.textContent.trim().length).toBeGreaterThan(0);
    expect(counter.textContent).toBe(`2/${NEW_VERSION_REASON_MAX}`);

    // Valid → enabled; confirm hands back the normalized value.
    await act(async () => fireEvent.change(input, { target: { value: "  TSA validated after v1  " } }));
    expect(submit.disabled).toBe(false);
    await act(async () => fireEvent.click(submit));
    expect(onConfirmed).toHaveBeenCalledWith("TSA validated after v1");
  });

  it("control-character-only reason stays invalid (Confirm disabled)", async () => {
    render(
      <ConfirmActionProvider>
        <ReasonHarness onConfirmed={() => {}} />
      </ConfirmActionProvider>,
    );
    await act(async () => fireEvent.click(screen.getByTestId("open")));
    const submit = document.querySelector('[data-confirm-action-submit="true"]') as HTMLButtonElement;
    const input = document.querySelector("[data-new-version-reason]") as HTMLTextAreaElement;
    await act(async () => fireEvent.change(input, { target: { value: "\u0000​\u0000" } }));
    expect(submit.disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RGA-02 — revalidation inside the Confirm path.
// ---------------------------------------------------------------------------

const OFFER = {
  action: NEW_VERSION_ACTION,
  reason: null,
  currentVersion: 1,
  nextVersion: 2,
  estimate: null,
} as const;

async function openModal() {
  await act(async () => fireEvent.click(screen.getByTestId("evidence-new-version")));
  // Click the single "Issue updated report…" menu item.
  const item = await screen.findByText(/issue updated report/i);
  await act(async () => fireEvent.click(item));
}

async function enterReasonAndConfirm() {
  const input = (await waitFor(() =>
    document.querySelector("[data-new-version-reason]"),
  )) as HTMLTextAreaElement;
  await act(async () => fireEvent.change(input, { target: { value: "document the anchor confirmed after v1" } }));
  const submit = document.querySelector('[data-confirm-action-submit="true"]') as HTMLButtonElement;
  await act(async () => fireEvent.click(submit));
}

describe("RGA-02 confirm-time revalidation (jsdom)", () => {
  it("does NOT submit when the offer advanced between open and Confirm", async () => {
    const request = vi.fn(async (_key: string, _reason: string) => "answered" as const);
    // The offer is unchanged when the modal OPENS, then advances (latest moved to
    // v2, so next is v3) by the time the user presses Confirm — the exact race.
    let call = 0;
    const loadOffer = vi.fn(async () => {
      call += 1;
      return call === 1 ? { ...OFFER } : { ...OFFER, currentVersion: 2, nextVersion: 3 };
    });
    render(
      <ConfirmActionProvider>
        <NewVersionMenu
          offer={OFFER}
          busy={false}
          request={request}
          loadOffer={loadOffer}
          testId="evidence-new-version"
          dataPrefix="evidence-output"
          menuLabel="More"
        />
      </ConfirmActionProvider>,
    );
    await openModal();
    await enterReasonAndConfirm();
    // Revalidation ran and blocked the stale submit.
    await waitFor(() => expect(loadOffer).toHaveBeenCalled());
    expect(request).not.toHaveBeenCalled();
    // The typed "confirm the updated truth" notice is shown.
    await waitFor(() =>
      expect(screen.getByText(/this record changed/i)).toBeTruthy(),
    );
  });

  it("submits exactly once when the offer is unchanged at Confirm", async () => {
    const request = vi.fn(async (_key: string, _reason: string) => "answered" as const);
    const loadOffer = vi.fn(async () => ({ ...OFFER })); // unchanged
    render(
      <ConfirmActionProvider>
        <NewVersionMenu
          offer={OFFER}
          busy={false}
          request={request}
          loadOffer={loadOffer}
          testId="evidence-new-version"
          dataPrefix="evidence-output"
          menuLabel="More"
        />
      </ConfirmActionProvider>,
    );
    await openModal();
    await enterReasonAndConfirm();
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]![1]).toBe("document the anchor confirmed after v1");
  });
});
