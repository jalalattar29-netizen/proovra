/**
 * PRO-PW-03 — the shared confirm dialog opens with focus on Cancel for a
 * destructive confirm. Enter on the focused Cancel must activate Cancel (the
 * dialog closes with "no"), never the destructive action; an auto-repeating
 * Enter (the key that opened the dialog, still held) confirms nothing; Enter
 * on the focused Confirm button confirms once.
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ConfirmActionProvider, useConfirmAction } from "../../components/ui/ConfirmActionModal";

afterEach(() => cleanup());

const results: boolean[] = [];

function Trigger() {
  const { confirm: confirmAction } = useConfirmAction();
  return (
    <button
      type="button"
      onClick={() => {
        void confirmAction({ title: "Delete it?", tone: "danger", confirmLabel: "Delete" }).then((ok) => {
          results.push(ok);
        });
      }}
    >
      open
    </button>
  );
}

async function openDialog() {
  results.length = 0;
  render(
    <ConfirmActionProvider>
      <Trigger />
    </ConfirmActionProvider>,
  );
  await act(async () => {
    fireEvent.click(screen.getByText("open"));
  });
  // The initial-focus timer (0 ms).
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
}

const cancelButton = () => document.querySelector('[data-confirm-action-cancel="true"]') as HTMLButtonElement;
const confirmButton = () => document.querySelector('[data-confirm-action-submit="true"]') as HTMLButtonElement;

describe("PRO-PW-03 — Enter follows the focused control", () => {
  it("opens with Cancel focused; Enter there does not confirm", async () => {
    await openDialog();
    expect(document.activeElement).toBe(cancelButton());
    await act(async () => {
      fireEvent.keyDown(cancelButton(), { key: "Enter" });
    });
    // The capture handler no longer swallows Enter into a confirm; the
    // browser's native activation of the focused Cancel is what remains.
    expect(results).not.toContain(true);
    await act(async () => {
      fireEvent.click(cancelButton());
    });
    expect(results).toEqual([false]);
  });

  it("a held (repeating) Enter confirms nothing", async () => {
    await openDialog();
    await act(async () => {
      confirmButton().focus();
      fireEvent.keyDown(confirmButton(), { key: "Enter", repeat: true });
    });
    expect(results).toEqual([]);
    expect(confirmButton()).not.toBeNull();
  });

  it("Enter on the focused Confirm button confirms once", async () => {
    await openDialog();
    await act(async () => {
      confirmButton().focus();
      fireEvent.keyDown(confirmButton(), { key: "Enter" });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(results).toEqual([true]);
  });
});
