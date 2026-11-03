/** The dialog that replaces `window.prompt`: a reason is required and cancel sends none. */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmActionProvider, useConfirmAction } from "../../components/ui/ConfirmActionModal";

function Harness({ onResult }: { onResult: (v: string | null) => void }) {
  const { askReason } = useConfirmAction();
  return (
    <button
      type="button"
      onClick={() =>
        void askReason({ title: "Release?", reasonLabel: "Why?", confirmLabel: "Release hold" }).then(onResult)
      }
    >
      open
    </button>
  );
}

const open = (onResult: (v: string | null) => void) => {
  render(<ConfirmActionProvider><Harness onResult={onResult} /></ConfirmActionProvider>);
  fireEvent.click(screen.getByText("open"));
};
const submit = () => document.querySelector("[data-confirm-action-submit]") as HTMLButtonElement;
const input = () => document.querySelector("[data-confirm-action-reason-input]") as HTMLTextAreaElement;

afterEach(cleanup);

describe("askReason", () => {
  it("keeps the action closed until a real reason is typed, then returns it trimmed", async () => {
    const onResult = vi.fn();
    open(onResult);
    expect(submit().disabled).toBe(true);
    fireEvent.change(input(), { target: { value: "   " } });
    expect(submit().disabled).toBe(true);
    fireEvent.change(input(), { target: { value: "  Claim settled " } });
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    await waitFor(() => expect(onResult).toHaveBeenCalledWith("Claim settled"));
  });

  it("returns null on cancel", async () => {
    const onResult = vi.fn();
    open(onResult);
    fireEvent.change(input(), { target: { value: "Typed, then changed my mind" } });
    fireEvent.click(document.querySelector("[data-confirm-action-cancel]") as HTMLButtonElement);
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(null));
  });
});
