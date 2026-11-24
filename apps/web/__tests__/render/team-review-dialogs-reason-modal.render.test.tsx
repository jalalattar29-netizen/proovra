/**
 * Team review dialogs — ReviewerReasonModal and ReviewerShortcutsHelp on the
 * canonical dialog (.app-dialog: portal, focus trap, focus restore, Escape).
 *
 * TEAM-UI-SPEC §2 — Reject and Request information are no longer dialogs (a
 * verdict is entered only in the inspector's decision panel); the reason
 * dialog serves Pause, Record response and the escalation actions. Fields are
 * `app-input`, a refusal is an `app-field-error` inside the dialog.
 */
import React, { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import {
  ReviewerReasonModal,
  type ReviewerReasonKind,
} from "../../app/(app)/reviewer-ops/components/ReviewerReasonModal";
import { ReviewerShortcutsHelp } from "../../app/(app)/reviewer-ops/components/ReviewerShortcutsHelp";

afterEach(() => {
  cleanup();
});

function Host({
  kind = "PAUSE",
  onSubmit,
  error,
}: {
  kind?: ReviewerReasonKind;
  onSubmit: (reason: string) => Promise<void> | void;
  error?: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      <ReviewerReasonModal kind={open ? kind : null} open={open} onCancel={() => setOpen(false)} onSubmit={onSubmit} error={error} />
    </>
  );
}

async function openDialog() {
  const opener = screen.getByRole("button", { name: "Open dialog" });
  opener.focus();
  fireEvent.click(opener);
  const dialog = await screen.findByRole("dialog");
  return { opener, dialog };
}

describe("ReviewerReasonModal", () => {
  it("is a labelled light modal dialog rendered in a portal", async () => {
    const { container } = render(<Host onSubmit={() => {}} />);
    const { dialog } = await openDialog();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.classList.contains("app-dialog")).toBe(true);
    expect(container.contains(dialog)).toBe(false);
    const labelledBy = dialog.getAttribute("aria-labelledby")!;
    expect(document.getElementById(labelledBy)?.textContent).toBe("Pause this review");
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    // The textarea has a real label, the canonical input class and a counter.
    const field = within(dialog).getByLabelText("Pause reason");
    expect(field.tagName).toBe("TEXTAREA");
    expect(field.classList.contains("app-input")).toBe(true);
    expect(within(dialog).getByText("0/400 characters")).toBeTruthy();
    // No dark inline theme.
    expect(dialog.getAttribute("style") ?? "").not.toMatch(/rgba\(20,\s*30,\s*34/);
  });

  it("moves focus in, and returns it to the opener on Escape", async () => {
    render(<Host onSubmit={() => {}} />);
    const { opener, dialog } = await openDialog();
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByLabelText("Pause reason")));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("closes from the close button", async () => {
    render(<Host onSubmit={() => {}} />);
    const { dialog } = await openDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps submit disabled until a reason is typed; Pause confirms with the primary and Cancel is secondary", async () => {
    const onSubmit = vi.fn();
    render(<Host onSubmit={onSubmit} />);
    const { dialog } = await openDialog();
    const submit = within(dialog).getByRole("button", { name: "Pause review" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.className).toBe("app-primary-action");
    expect(within(dialog).getByRole("button", { name: "Cancel" }).className).toBe("app-secondary-action");
    fireEvent.change(within(dialog).getByLabelText("Pause reason"), { target: { value: "   " } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Pause reason"), { target: { value: "Integrity failed" } });
    expect(submit.disabled).toBe(false);
    expect(within(dialog).getByText("16/400 characters")).toBeTruthy();
    fireEvent.click(submit);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Integrity failed"));
  });

  it("refuses a reason over the limit with a validation message", async () => {
    render(<Host kind="PAUSE" onSubmit={() => {}} />);
    const { dialog } = await openDialog();
    fireEvent.change(within(dialog).getByLabelText("Pause reason"), { target: { value: "x".repeat(450) } });
    const submit = within(dialog).getByRole("button", { name: "Pause review" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(within(dialog).getByText("401/400 characters")).toBeTruthy();
  });

  it("shows a loading state while submitting and the host's refusal inside the dialog", async () => {
    let release: () => void = () => {};
    const pending = new Promise<void>((r) => {
      release = r;
    });
    function Refusing() {
      const [error, setError] = useState<string | null>(null);
      return (
        <Host
          kind="PAUSE"
          error={error}
          onSubmit={async () => {
            await pending;
            setError("Only the assigned reviewer can record this decision.");
          }}
        />
      );
    }
    render(<Refusing />);
    const { dialog } = await openDialog();
    fireEvent.change(within(dialog).getByLabelText("Pause reason"), { target: { value: "Need the log" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Pause review" }));
    const busy = await within(dialog).findByRole("button", { name: /Submitting/ });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    // Escape does nothing while in flight.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeTruthy();
    await act(async () => {
      release();
      await pending;
    });
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe("Only the assigned reviewer can record this decision.");
    expect(alert.classList.contains("app-field-error")).toBe(true);
    expect(dialog.contains(alert)).toBe(true);
    expect((within(dialog).getByLabelText("Pause reason") as HTMLTextAreaElement).value).toBe("Need the log");
  });

  it("suppressing an escalation (irreversible) confirms with app-danger-action", async () => {
    render(<Host kind="ESCALATION_SUPPRESS" onSubmit={() => {}} />);
    const { dialog } = await openDialog();
    expect(within(dialog).getByRole("button", { name: "Suppress" }).className).toBe("app-danger-action");
  });

  it("keeps the escalation kinds working (uuid validation)", async () => {
    const onSubmit = vi.fn();
    render(<Host kind="ESCALATION_REASSIGN" onSubmit={onSubmit} />);
    const { dialog } = await openDialog();
    fireEvent.change(within(dialog).getByLabelText("New assignee user id"), { target: { value: "not-a-uuid" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reassign" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Enter a valid user id.");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("ReviewerShortcutsHelp", () => {
  it("lists the inspector keys on the canonical dialog, without Cmd+K, and restores focus", async () => {
    function HelpHost() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open help
          </button>
          <ReviewerShortcutsHelp open={open} onClose={() => setOpen(false)} variant="inspector" />
        </>
      );
    }
    render(<HelpHost />);
    const opener = screen.getByRole("button", { name: "Open help" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(dialog.classList.contains("app-dialog")).toBe(true);
    // TEAM-UI-SPEC §2 — M goes to the decision panel; there is no approve key.
    expect(dialog.textContent).toContain("Go to the decision panel with Request information selected");
    expect(within(dialog).queryByText("C", { selector: "kbd" })).toBeNull();
    expect(dialog.textContent).not.toMatch(/Approve/);
    expect(dialog.textContent).not.toMatch(/Cmd|Ctrl\s*\+\s*K|⌘/);
    expect(dialog.textContent).not.toContain("Escalate");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("lists the console keys by default", async () => {
    render(<ReviewerShortcutsHelp open onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    for (const k of ["J / K", "Enter", "A", "/"]) {
      expect(within(dialog).getByText(k, { selector: "kbd" })).toBeTruthy();
    }
    // ARCH-18 — the console handles no E (escalate) or M (request info) key,
    // so the help does not list them.
    for (const k of ["E", "M"]) {
      expect(within(dialog).queryByText(k, { selector: "kbd" })).toBeNull();
    }
  });
});
