/**
 * AUD-0025 (a) / AUD-0060 — focus into the compact "Queue selection" sheet,
 * and the page-header action row that must wrap at 375px.
 *
 * The Evidence Library renders its compact Inspector as `<Modal open>` the
 * moment a row title (an aria-pressed toggle) is activated, so the canonical
 * dialog MOUNTS already open. Its portal target is only known after mount, and
 * the initial focus used to be scheduled before the dialog existed: focus
 * stayed on the row title behind an `aria-modal` sheet.
 *
 * jsdom has no layout, so the wrap half asserts the style that bounds the row,
 * not a measured rectangle.
 */
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QueueSelectionPreview } from "../../app/(app)/evidence/components/QueueSelectionPreview";
import { PageHeader } from "../../components/ui/PageShell";

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

const noop = () => undefined;

function LibraryHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-pressed={open}
        data-evidence-row-title="ev-1"
        onClick={() => setOpen(true)}
      >
        Record one
      </button>
      {open ? (
        <QueueSelectionPreview
          presentation="hosted"
          item={null}
          detail={null}
          loading={false}
          error={null}
          caseName={null}
          onClose={() => setOpen(false)}
          onOpenRecord={noop}
          onDownloadReport={noop}
          onDownloadVerificationPackage={noop}
          onManageVerificationLinks={noop}
        />
      ) : null}
    </>
  );
}

const trigger = () => screen.getByRole("button", { name: "Record one" });
const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]');

describe("Queue selection sheet focus (AUD-0025)", () => {
  it("Enter on the row title moves focus INTO the sheet; Escape returns it to the row title", async () => {
    const user = userEvent.setup();
    render(<LibraryHarness />);
    trigger().focus();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(sheet()).not.toBeNull());
    expect(sheet()!.getAttribute("aria-modal")).toBe("true");
    await waitFor(() => expect(sheet()!.contains(document.activeElement)).toBe(true));

    await user.keyboard("{Escape}");
    await waitFor(() => expect(sheet()).toBeNull());
    expect(document.activeElement).toBe(trigger());
  });

  it("the sheet's own close control returns focus to the row title", async () => {
    render(<LibraryHarness />);
    trigger().focus();
    fireEvent.click(trigger());
    await waitFor(() => expect(sheet()?.contains(document.activeElement)).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(sheet()).toBeNull());
    expect(document.activeElement).toBe(trigger());
  });

  it("focuses the sheet even when the deferred focus fires before the portal re-render", () => {
    // The browser race, made deterministic: a zero-delay timer scheduled
    // while the sheet mounts runs at once — i.e. BEFORE React commits the
    // portal. The old code focused from that timer against a null dialog ref.
    const realSetTimeout = globalThis.setTimeout;
    render(<LibraryHarness />);
    trigger().focus();
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: (...a: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      if (!ms && typeof fn === "function") {
        fn(...args);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(fn, ms, ...args);
    }) as unknown as typeof setTimeout);

    fireEvent.click(trigger());
    vi.restoreAllMocks();

    expect(sheet()).not.toBeNull();
    expect(sheet()!.contains(document.activeElement)).toBe(true);
  });
});

describe("PageHeader action row (AUD-0060)", () => {
  it("is capped at the header's width so its flex-wrap can engage at 375px", () => {
    render(
      <PageHeader
        title="Organization"
        secondaryActions={<a href="/admin/customers">Back to roster</a>}
        primaryAction={<button type="button">Suspend customer</button>}
      />,
    );
    const row = document.querySelector<HTMLElement>(".ui-page-header__actions");
    expect(row).not.toBeNull();
    expect(row!.style.flexWrap).toBe("wrap");
    expect(row!.style.maxWidth).toBe("100%");
    expect(row!.style.minWidth).toBe("0px");
  });
});
