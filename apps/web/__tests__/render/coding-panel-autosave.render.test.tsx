/**
 * Review remediation §6 (2026-11-27) — CodingPanel autosave behaviour
 * (F-13 clear, F-14 confidence not set, F-15 read-only, F-16 unsaved guard,
 * F-17 save status + live region, F-24 tri-state boolean, F-25 debounced
 * slider, out-of-order protection, retry keeps the reviewer's entry).
 */
import React from "react";
import { chooseListbox } from "./_listbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import {
  CodingPanel,
  hasUnsavedCoding,
  type CodingWriteOutcome,
} from "../../components/reviewer-workspace/CodingPanel";
import type { CodingFieldRow, CodingValueRow } from "../../lib/reviewer-workspace/reviewer-api";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function field(id: string, fieldType: CodingFieldRow["fieldType"], label: string, extra: Partial<CodingFieldRow> = {}): CodingFieldRow {
  return { id, slug: id, label, fieldType, required: false, orderIndex: 0, helpText: null, options: null, ...extra };
}
function value(fieldId: string, v: Record<string, unknown>): CodingValueRow {
  return { id: `v-${fieldId}`, fieldId, value: v, rationale: null, authorUserId: "u1", updatedAt: "2026-11-27T00:00:00Z" };
}

type Deferred = { resolve: (o: CodingWriteOutcome) => void; reject: (e: unknown) => void };
function deferredWrites() {
  const pending: Deferred[] = [];
  const fn = vi.fn(
    () =>
      new Promise<CodingWriteOutcome>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
  return { fn, pending };
}

const NOTES = field("f-notes", "TEXT", "Notes");
const textarea = () => screen.getByLabelText("Notes") as HTMLTextAreaElement;
const live = () => document.querySelector("[data-coding-live]") as HTMLElement;
const statusOf = (fieldId: string) =>
  document.querySelector(`[data-coding-field-id="${fieldId}"] [data-coding-field-status]`) as HTMLElement | null;

describe("CodingPanel — confidence (F-14, F-25)", () => {
  const CONF = field("f-conf", "CONFIDENCE_SCORE", "Confidence");

  it("shows Not set until chosen and writes nothing on render", () => {
    const onWrite = vi.fn();
    render(<CodingPanel fields={[CONF]} values={[]} unfulfilledFieldIds={new Set()} onWrite={onWrite} onClear={vi.fn()} />);
    expect(document.querySelector("[data-coding-confidence-display]")!.textContent).toBe("Not set");
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("Not set");
    expect((screen.getByLabelText("Confidence (0–100)") as HTMLInputElement).value).toBe("");
    expect(onWrite).not.toHaveBeenCalled();
  });

  it("debounces ten keyboard steps into one write of the final value; never disabled while pending", async () => {
    vi.useFakeTimers();
    const onWrite = vi.fn(async () => ({ ok: true }) as CodingWriteOutcome);
    render(<CodingPanel fields={[CONF]} values={[]} unfulfilledFieldIds={new Set()} onWrite={onWrite} onClear={vi.fn()} />);
    const slider = screen.getByRole("slider") as HTMLInputElement;
    for (let n = 51; n <= 60; n++) fireEvent.change(slider, { target: { value: String(n) } });
    expect(onWrite).not.toHaveBeenCalled();
    expect(statusOf("f-conf")!.textContent).toBe("Saving…");
    expect(slider.disabled).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(onWrite).toHaveBeenCalledTimes(1);
    expect(onWrite).toHaveBeenCalledWith({ fieldId: "f-conf", value: { confidence: 60 } });
  });

  it("Clear sends an explicit clear and returns to Not set", async () => {
    const onClear = vi.fn(async () => ({ ok: true }) as CodingWriteOutcome);
    render(
      <CodingPanel fields={[CONF]} values={[value("f-conf", { confidence: 70 })]} unfulfilledFieldIds={new Set()} onWrite={vi.fn()} onClear={onClear} />,
    );
    expect(document.querySelector("[data-coding-confidence-display]")!.textContent).toBe("70");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClear).toHaveBeenCalledWith({ fieldId: "f-conf" });
    expect(document.querySelector("[data-coding-confidence-display]")!.textContent).toBe("Not set");
  });
});

describe("CodingPanel — explicit clear (F-13)", () => {
  it("an emptied text field sends a clear, not nothing", async () => {
    const onWrite = vi.fn();
    const onClear = vi.fn(async () => ({ ok: true }) as CodingWriteOutcome);
    render(
      <CodingPanel fields={[NOTES]} values={[value("f-notes", { text: "Dent" })]} unfulfilledFieldIds={new Set()} onWrite={onWrite} onClear={onClear} />,
    );
    expect(textarea().value).toBe("Dent");
    fireEvent.change(textarea(), { target: { value: "" } });
    fireEvent.blur(textarea());
    expect(onClear).toHaveBeenCalledWith({ fieldId: "f-notes" });
    expect(onWrite).not.toHaveBeenCalled();
    await waitFor(() => expect(statusOf("f-notes")!.textContent).toBe("Saved"));
    expect(live().textContent).toBe("Notes: cleared.");
  });

  it("tabbing through an empty field writes nothing", () => {
    const onWrite = vi.fn();
    const onClear = vi.fn();
    render(<CodingPanel fields={[NOTES]} values={[]} unfulfilledFieldIds={new Set()} onWrite={onWrite} onClear={onClear} />);
    fireEvent.focus(textarea());
    fireEvent.blur(textarea());
    expect(onWrite).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
  });

  it("a select offers Not set, which clears", async () => {
    const RISK = field("f-risk", "RISK_LEVEL", "Risk level");
    const onClear = vi.fn(async () => ({ ok: true }) as CodingWriteOutcome);
    render(<CodingPanel fields={[RISK]} values={[value("f-risk", { risk: "HIGH" })]} unfulfilledFieldIds={new Set()} onWrite={vi.fn()} onClear={onClear} />);
    const trigger = document.querySelector('[data-coding-field-id="f-risk"] [aria-labelledby="coding-field-label-f-risk"]');
    chooseListbox(trigger, "");
    expect(onClear).toHaveBeenCalledWith({ fieldId: "f-risk" });
  });
});

describe("CodingPanel — boolean is Not set / Yes / No (F-24)", () => {
  const SIU = field("f-siu", "BOOLEAN", "Refer to SIU?");

  it("starts Not set; an explicit No is stored as {boolean:false}; Not set clears", async () => {
    const onWrite = vi.fn(async () => ({ ok: true }) as CodingWriteOutcome);
    const onClear = vi.fn(async () => ({ ok: true }) as CodingWriteOutcome);
    render(<CodingPanel fields={[SIU]} values={[]} unfulfilledFieldIds={new Set()} onWrite={onWrite} onClear={onClear} />);
    const group = screen.getByRole("radiogroup", { name: "Refer to SIU?" });
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(["unset", "yes", "no"]);
    expect(within(group).getByLabelText("Not set")).toHaveProperty("checked", true);
    fireEvent.click(within(group).getByLabelText("No"));
    expect(onWrite).toHaveBeenCalledWith({ fieldId: "f-siu", value: { boolean: false } });
    expect(within(group).getByLabelText("No")).toHaveProperty("checked", true);
    fireEvent.click(within(group).getByLabelText("Not set"));
    expect(onClear).toHaveBeenCalledWith({ fieldId: "f-siu" });
  });

  it("shows a stored No as No (not as unchecked)", () => {
    render(
      <CodingPanel fields={[SIU]} values={[value("f-siu", { boolean: false })]} unfulfilledFieldIds={new Set()} onWrite={vi.fn()} onClear={vi.fn()} />,
    );
    expect(screen.getByLabelText("No")).toHaveProperty("checked", true);
  });
});

describe("CodingPanel — save status, ordering and retry (F-17)", () => {
  it("ignores a response older than the latest request for the field", async () => {
    const { fn, pending } = deferredWrites();
    render(<CodingPanel fields={[NOTES]} values={[]} unfulfilledFieldIds={new Set()} onWrite={fn} onClear={vi.fn()} />);
    fireEvent.change(textarea(), { target: { value: "first" } });
    fireEvent.blur(textarea());
    fireEvent.change(textarea(), { target: { value: "second" } });
    fireEvent.blur(textarea());
    expect(fn).toHaveBeenCalledTimes(2);
    expect(statusOf("f-notes")!.textContent).toBe("Saving…");
    expect(textarea().disabled).toBe(false);
    await act(async () => pending[1]!.resolve({ ok: true }));
    expect(statusOf("f-notes")!.textContent).toBe("Saved");
    // The OLDER request fails late: it must not overwrite the newer outcome.
    await act(async () => pending[0]!.resolve({ ok: false, kind: "refused", message: "Too late." }));
    expect(statusOf("f-notes")!.textContent).toBe("Saved");
    expect(live().textContent).toBe("Notes: saved.");
    expect(textarea().value).toBe("second");
  });

  it("a lost connection says so, keeps the reviewer's text, and Retry re-sends it", async () => {
    const { fn, pending } = deferredWrites();
    render(<CodingPanel fields={[NOTES]} values={[]} unfulfilledFieldIds={new Set()} onWrite={fn} onClear={vi.fn()} />);
    fireEvent.change(textarea(), { target: { value: "Scratch on door" } });
    fireEvent.blur(textarea());
    await act(async () => pending[0]!.reject(Object.assign(new Error("Network"), { code: "NETWORK_ERROR" })));
    expect(statusOf("f-notes")!.textContent).toContain("Not saved — no connection.");
    expect(live().textContent).toContain("Notes: not saved — no connection.");
    expect(textarea().value).toBe("Scratch on door");
    fireEvent.click(screen.getByRole("button", { name: "Retry saving Notes" }));
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith({ fieldId: "f-notes", value: { text: "Scratch on door" } });
    await act(async () => pending[1]!.resolve({ ok: true }));
    expect(statusOf("f-notes")!.textContent).toBe("Saved");
  });

  it("a refusal shows the server's message", async () => {
    const onWrite = vi.fn(async () => ({ ok: false, kind: "refused", message: "This review is closed." }) as CodingWriteOutcome);
    render(<CodingPanel fields={[NOTES]} values={[]} unfulfilledFieldIds={new Set()} onWrite={onWrite} onClear={vi.fn()} />);
    fireEvent.change(textarea(), { target: { value: "x" } });
    fireEvent.blur(textarea());
    await waitFor(() => expect(statusOf("f-notes")!.textContent).toContain("Not saved — This review is closed."));
    expect(live().textContent).toBe("Notes: not saved — This review is closed.");
  });

  it("there is exactly one polite live region", () => {
    render(<CodingPanel fields={[NOTES, field("f-n", "NUMERIC", "Estimate")]} values={[]} unfulfilledFieldIds={new Set()} onWrite={vi.fn()} />);
    const regions = screen.getAllByRole("status");
    expect(regions).toHaveLength(1);
    expect(regions[0]!.getAttribute("aria-live")).toBe("polite");
  });

  it("a numeric field saves on Enter and an emptied one clears", async () => {
    const EST = field("f-est", "NUMERIC", "Estimate");
    const onWrite = vi.fn(async () => ({ ok: true }) as CodingWriteOutcome);
    const onClear = vi.fn(async () => ({ ok: true }) as CodingWriteOutcome);
    render(<CodingPanel fields={[EST]} values={[value("f-est", { number: 5 })]} unfulfilledFieldIds={new Set()} onWrite={onWrite} onClear={onClear} />);
    const input = screen.getByLabelText("Estimate") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onWrite).toHaveBeenCalledWith({ fieldId: "f-est", value: { number: 12 } });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onClear).toHaveBeenCalledWith({ fieldId: "f-est" });
  });

  it("re-renders a new server value (controlled input)", () => {
    const { rerender } = render(
      <CodingPanel fields={[NOTES]} values={[value("f-notes", { text: "old" })]} unfulfilledFieldIds={new Set()} onWrite={vi.fn()} />,
    );
    expect(textarea().value).toBe("old");
    rerender(<CodingPanel fields={[NOTES]} values={[value("f-notes", { text: "new" })]} unfulfilledFieldIds={new Set()} onWrite={vi.fn()} />);
    expect(textarea().value).toBe("new");
  });
});

describe("CodingPanel — read-only and naming (F-15, F-18)", () => {
  it("a closed review shows values read-only with the reason", () => {
    const onWrite = vi.fn();
    render(
      <CodingPanel
        fields={[NOTES, field("f-b", "BOOLEAN", "Redaction needed")]}
        values={[value("f-notes", { text: "Dent" }), value("f-b", { boolean: false })]}
        unfulfilledFieldIds={new Set()}
        onWrite={onWrite}
        writable={{ allowed: false, reason: "workflow_closed" }}
      />,
    );
    expect(screen.getByText("This review is closed. Coding is read-only.")).toBeTruthy();
    expect(document.querySelector("textarea")).toBeNull();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    const shown = Array.from(document.querySelectorAll("[data-coding-read-only-value]")).map((e) => e.textContent);
    expect(shown).toEqual(["Dent", "No"]);
  });

  it("no permission names that reason", () => {
    render(
      <CodingPanel fields={[NOTES]} values={[]} unfulfilledFieldIds={new Set()} onWrite={vi.fn()} writable={{ allowed: false, reason: "no_permission" }} />,
    );
    expect(screen.getByText(/Your role does not allow coding this review/)).toBeTruthy();
  });

  it("labels a REVIEWER_VERDICT field as an assessment, not the decision", () => {
    render(<CodingPanel fields={[field("f-v", "REVIEWER_VERDICT", "Verdict")]} values={[]} unfulfilledFieldIds={new Set()} onWrite={vi.fn()} />);
    expect(document.getElementById("coding-field-label-f-v")!.textContent).toBe(
      "Verdict — assessment (recommendation), not the decision",
    );
  });

  it("a missing required field is a warning about the assessment, not a decision gate", () => {
    render(
      <CodingPanel fields={[{ ...NOTES, required: true }]} values={[]} unfulfilledFieldIds={new Set(["f-notes"])} onWrite={vi.fn()} />,
    );
    expect(document.querySelector("[data-coding-required-warning]")!.textContent).toBe(
      "Required — the assessment is incomplete without it.",
    );
  });
});

describe("CodingPanel — leaving with unsaved coding (F-16)", () => {
  it("guards beforeunload and reports unsaved state while a save is pending", async () => {
    const { fn, pending } = deferredWrites();
    const onUnsavedChange = vi.fn();
    render(
      <CodingPanel fields={[NOTES]} values={[]} unfulfilledFieldIds={new Set()} onWrite={fn} onUnsavedChange={onUnsavedChange} />,
    );
    expect(hasUnsavedCoding()).toBe(false);
    fireEvent.change(textarea(), { target: { value: "pending text" } });
    fireEvent.blur(textarea());
    await waitFor(() => expect(onUnsavedChange).toHaveBeenLastCalledWith(true));
    expect(hasUnsavedCoding()).toBe(true);
    const evt = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    await act(async () => pending[0]!.resolve({ ok: true }));
    await waitFor(() => expect(onUnsavedChange).toHaveBeenLastCalledWith(false));
    expect(hasUnsavedCoding()).toBe(false);
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
});
