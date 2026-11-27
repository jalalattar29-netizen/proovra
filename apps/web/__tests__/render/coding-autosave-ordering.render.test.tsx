/**
 * Review remediation A (2026-11-27) — coding autosave persists in the order
 * the reviewer acted, and a stale change is a visible conflict.
 *
 * Drives ReviewCodingSection → reviewer-api → the REAL apiFetch over a
 * stubbed `fetch`. The stub is a small in-memory server with the API's
 * revision semantics (every write and effective clear bumps the field
 * revision; a mismatched `expectedRevision` is a 409 CODING_VALUE_CONFLICT and
 * writes nothing). Each POST is HELD until the test releases it, so request
 * interleavings are chosen by the test, never by timing. Assertions read the
 * STORED value (the fake server's store) and the save state on screen.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { chooseListbox } from "./_listbox";

vi.mock("../../app/(app)/reviewer-ops/components/CodingSchemaBindingPanel", () => ({
  CodingSchemaBindingPanel: () => null,
}));

import { ReviewCodingSection } from "../../components/reviewer-experience/ReviewCodingSection";
import { CodingPanel, hasUnsavedCoding, type CodingWriteOutcome } from "../../components/reviewer-workspace/CodingPanel";
import type { CodingFieldRow } from "../../lib/reviewer-workspace/reviewer-api";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEAM_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WF = "22222222-2222-4222-8222-222222222222";
const WF_2 = "33333333-3333-4333-8333-333333333333";
const SCHEMA = "11111111-1111-4111-8111-111111111111";

const FIELDS: CodingFieldRow[] = [
  { id: "f-notes", slug: "notes", label: "Notes", fieldType: "TEXT", required: false, orderIndex: 0, helpText: null, options: null },
  { id: "f-risk", slug: "risk", label: "Risk level", fieldType: "RISK_LEVEL", required: false, orderIndex: 1, helpText: null, options: null },
  { id: "f-conf", slug: "conf", label: "Confidence", fieldType: "CONFIDENCE_SCORE", required: false, orderIndex: 2, helpText: null, options: null },
];

// ---------------------------------------------------------------------------
// The fake API: per (team, workflow) store with revisions; POSTs held.
// ---------------------------------------------------------------------------

type Store = { values: Map<string, Record<string, unknown>>; revisions: Map<string, number> };
type HeldWrite = {
  url: URL;
  body: { fieldId: string; value?: Record<string, unknown>; clear?: true; expectedRevision?: number };
  respond: () => void;
  fail: () => void;
};
type HeldRead = { release: () => void };

let stores: Map<string, Store>;
let writes: HeldWrite[];
let heldReads: HeldRead[];
let holdReads: boolean;

const storeKey = (team: string, wf: string) => `${team}:${wf}`;
function store(team = TEAM, wf = WF): Store {
  const k = storeKey(team, wf);
  let s = stores.get(k);
  if (!s) {
    s = { values: new Map(), revisions: new Map() };
    stores.set(k, s);
  }
  return s;
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function snapshot(s: Store) {
  return {
    schemaBinding: { id: SCHEMA, label: "General Evidence Review", version: 1, status: "PUBLISHED" },
    values: [...s.values.entries()].map(([fieldId, value]) => ({
      id: `v-${fieldId}`,
      fieldId,
      value,
      rationale: null,
      authorUserId: "u",
      updatedAt: "2026-11-27T00:00:00Z",
      revision: s.revisions.get(fieldId) ?? 0,
    })),
    revisions: Object.fromEntries(s.revisions),
    otherSchemaValues: [],
    coverage: { unfulfilledFieldIds: [] },
    writable: { allowed: true, reason: null },
  };
}

/** The server's answer to a held write, with the API's revision rule. */
function apply(w: HeldWrite): Response {
  const team = w.url.searchParams.get("teamId")!;
  const wf = w.url.pathname.split("/")[4]!;
  const s = store(team, wf);
  const { fieldId, expectedRevision } = w.body;
  const rev = s.revisions.get(fieldId) ?? 0;
  if (expectedRevision !== undefined && expectedRevision !== rev) {
    return json(409, {
      code: "CODING_VALUE_CONFLICT",
      denial: "CODING_VALUE_CONFLICT",
      message: "This field was changed in another tab or by another reviewer.",
      current: { revision: rev, value: s.values.get(fieldId) ?? null },
    });
  }
  if (w.body.clear) {
    if (!s.values.has(fieldId)) return json(200, { cleared: false, codingValueId: null, revision: rev });
    s.values.delete(fieldId);
    s.revisions.set(fieldId, rev + 1);
    return json(200, { cleared: true, codingValueId: `v-${fieldId}`, revision: rev + 1 });
  }
  s.values.set(fieldId, w.body.value!);
  s.revisions.set(fieldId, rev + 1);
  return json(200, { codingValueId: `v-${fieldId}`, revision: rev + 1 });
}

beforeEach(() => {
  stores = new Map();
  writes = [];
  heldReads = [];
  holdReads = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.pathname.endsWith("/coding")) {
        const wf = url.pathname.split("/")[4]!;
        // The snapshot is taken when the server handles the read.
        const body = snapshot(store(url.searchParams.get("teamId")!, wf));
        if (!holdReads) return json(200, body);
        return new Promise<Response>((resolve) => heldReads.push({ release: () => resolve(json(200, body)) }));
      }
      if (method === "GET" && url.pathname.startsWith("/v1/coding/schemas/")) {
        return json(200, { schema: { id: SCHEMA, fields: FIELDS } });
      }
      if (method === "POST" && url.pathname.endsWith("/code")) {
        return new Promise<Response>((resolve, reject) => {
          const w: HeldWrite = {
            url,
            body: JSON.parse(String(init?.body)),
            respond: () => resolve(apply(w)),
            fail: () => reject(new TypeError("Failed to fetch")),
          };
          writes.push(w);
        });
      }
      return json(200, {});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const notes = () => screen.getByLabelText("Notes") as HTMLTextAreaElement;
const statusOf = (fieldId: string) =>
  document.querySelector(`[data-coding-field-id="${fieldId}"] [data-coding-field-status]`)?.textContent ?? null;
const riskTrigger = () =>
  document.querySelector('[data-coding-field-id="f-risk"] [aria-labelledby="coding-field-label-f-risk"]');

async function mount(props: { teamId?: string; workflowId?: string; refreshKey?: number } = {}) {
  const view = render(<ReviewCodingSection teamId={props.teamId ?? TEAM} workflowId={props.workflowId ?? WF} refreshKey={props.refreshKey} />);
  await screen.findByLabelText("Notes");
  return view;
}
function type(text: string) {
  fireEvent.change(notes(), { target: { value: text } });
  fireEvent.blur(notes());
}
async function release(i: number) {
  await act(async () => {
    writes[i]!.respond();
  });
}

// ---------------------------------------------------------------------------

describe("CodingPanel autosave — persisted order (review remediation A)", () => {
  it("A then B with A's response delayed: one request in flight; B is sent after A and is what is stored", async () => {
    await mount();
    type("A");
    type("B");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body).toEqual({ fieldId: "f-notes", value: { text: "A" }, expectedRevision: 0 });
    expect(statusOf("f-notes")).toBe("Saving…");
    await release(0);
    // A is stored, but B is still to go: not "Saved".
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(statusOf("f-notes")).toBe("Saving…");
    expect(writes[1]!.body).toEqual({ fieldId: "f-notes", value: { text: "B" }, expectedRevision: 1 });
    await release(1);
    await waitFor(() => expect(statusOf("f-notes")).toBe("Saved"));
    expect(store().values.get("f-notes")).toEqual({ text: "B" });
    expect(store().revisions.get("f-notes")).toBe(2);
    expect(notes().value).toBe("B");
    expect(writes).toHaveLength(2);
  });

  it("several rapid choice changes: at most 2 requests, the stored value is the last choice", async () => {
    await mount();
    for (const v of ["LOW", "MEDIUM", "HIGH", "CRITICAL"]) chooseListbox(riskTrigger(), v);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body.value).toEqual({ risk: "LOW" });
    await release(0);
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]!.body.value).toEqual({ risk: "CRITICAL" });
    await release(1);
    await waitFor(() => expect(statusOf("f-risk")).toBe("Saved"));
    expect(writes).toHaveLength(2);
    expect(store().values.get("f-risk")).toEqual({ risk: "CRITICAL" });
  });

  it("write then clear: the clear is sent after the write, on its revision; nothing is stored", async () => {
    await mount();
    type("temporary");
    type("");
    expect(writes).toHaveLength(1);
    await release(0);
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]!.body).toEqual({ fieldId: "f-notes", clear: true, expectedRevision: 1 });
    await release(1);
    await waitFor(() => expect(statusOf("f-notes")).toBe("Saved"));
    expect(store().values.has("f-notes")).toBe(false);
    expect(store().revisions.get("f-notes")).toBe(2);
  });

  it("clear then write: the write is sent after the clear; the written value is stored", async () => {
    store().values.set("f-notes", { text: "old" });
    store().revisions.set("f-notes", 1);
    await mount();
    expect(notes().value).toBe("old");
    type("");
    type("fresh");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body).toEqual({ fieldId: "f-notes", clear: true, expectedRevision: 1 });
    await release(0);
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]!.body).toEqual({ fieldId: "f-notes", value: { text: "fresh" }, expectedRevision: 2 });
    await release(1);
    await waitFor(() => expect(statusOf("f-notes")).toBe("Saved"));
    expect(store().values.get("f-notes")).toEqual({ text: "fresh" });
  });

  it("an edit back to the value in flight cancels the pending one (only what is needed is sent)", async () => {
    await mount();
    type("same");
    type("other");
    type("same");
    await release(0);
    await waitFor(() => expect(statusOf("f-notes")).toBe("Saved"));
    expect(writes).toHaveLength(1);
    expect(store().values.get("f-notes")).toEqual({ text: "same" });
  });

  it("failed save, newer edit, Retry: Retry sends the NEWEST value", async () => {
    await mount();
    type("first");
    await act(async () => writes[0]!.fail());
    await waitFor(() => expect(statusOf("f-notes")).toContain("Not saved — no connection."));
    expect(notes().value).toBe("first");
    // A newer edit, not yet committed, then Retry.
    fireEvent.change(notes(), { target: { value: "newest" } });
    fireEvent.click(screen.getByRole("button", { name: "Retry saving Notes" }));
    expect(writes).toHaveLength(2);
    expect(writes[1]!.body).toEqual({ fieldId: "f-notes", value: { text: "newest" }, expectedRevision: 0 });
    await release(1);
    await waitFor(() => expect(statusOf("f-notes")).toBe("Saved"));
    expect(store().values.get("f-notes")).toEqual({ text: "newest" });
  });

  it("a lost answer that did commit: Retry's conflict naming the same value reads as saved", async () => {
    await mount();
    type("committed");
    // The server stores it, but the answer is lost.
    await act(async () => {
      apply(writes[0]!);
      writes[0]!.fail();
    });
    await waitFor(() => expect(statusOf("f-notes")).toContain("no connection"));
    fireEvent.click(screen.getByRole("button", { name: "Retry saving Notes" }));
    await release(1);
    await waitFor(() => expect(statusOf("f-notes")).toBe("Saved"));
    expect(store().values.get("f-notes")).toEqual({ text: "committed" });
    expect(store().revisions.get("f-notes")).toBe(1);
  });

  it("a server refresh carrying an OLDER value while a newer local edit is pending keeps the local value", async () => {
    store().values.set("f-notes", { text: "server" });
    store().revisions.set("f-notes", 1);
    const view = await mount({ refreshKey: 0 });
    type("mine 1");
    type("mine 2");
    // A refresh handled by the server BEFORE any of the writes committed.
    holdReads = true;
    view.rerender(<ReviewCodingSection teamId={TEAM} workflowId={WF} refreshKey={1} />);
    await waitFor(() => expect(heldReads).toHaveLength(1));
    await act(async () => heldReads[0]!.release());
    expect(notes().value).toBe("mine 2");
    holdReads = false;
    await release(0);
    await waitFor(() => expect(writes).toHaveLength(2));
    await release(1);
    await waitFor(() => expect(statusOf("f-notes")).toBe("Saved"));
    expect(notes().value).toBe("mine 2");
    expect(store().values.get("f-notes")).toEqual({ text: "mine 2" });
  });

  it("a conflict (changed in another tab) keeps the draft, says so, stores nothing; Reload shows the stored value", async () => {
    store().values.set("f-notes", { text: "start" });
    store().revisions.set("f-notes", 1);
    await mount();
    // Another tab writes after this one read.
    store().values.set("f-notes", { text: "other tab" });
    store().revisions.set("f-notes", 2);
    type("mine");
    expect(writes[0]!.body.expectedRevision).toBe(1);
    await release(0);
    await waitFor(() =>
      expect(statusOf("f-notes")).toContain(
        "Changed in another tab or by another reviewer — reload to see the current value.",
      ),
    );
    expect(notes().value).toBe("mine");
    expect(store().values.get("f-notes")).toEqual({ text: "other tab" });
    expect(document.querySelector("[data-coding-live]")!.textContent).toContain("Changed in another tab");
    expect(hasUnsavedCoding()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reload Notes" }));
    await waitFor(() => expect(notes().value).toBe("other tab"));
    expect(statusOf("f-notes")).toBeNull();
    expect(writes).toHaveLength(1);
  });

  it("after a conflict, Keep mine re-sends the reviewer's value based on the stored revision", async () => {
    store().values.set("f-notes", { text: "start" });
    store().revisions.set("f-notes", 1);
    await mount();
    store().values.set("f-notes", { text: "other tab" });
    store().revisions.set("f-notes", 2);
    type("mine");
    await release(0);
    await waitFor(() => expect(statusOf("f-notes")).toContain("Changed in another tab"));
    fireEvent.click(screen.getByRole("button", { name: "Save my value for Notes anyway" }));
    expect(writes[1]!.body).toEqual({ fieldId: "f-notes", value: { text: "mine" }, expectedRevision: 2 });
    await release(1);
    await waitFor(() => expect(statusOf("f-notes")).toBe("Saved"));
    expect(store().values.get("f-notes")).toEqual({ text: "mine" });
  });

  it("switching review: a pending edit of the previous review is never sent to the new one", async () => {
    store(TEAM, WF_2).values.set("f-notes", { text: "second review" });
    const view = await mount();
    type("for review 1");
    type("also for review 1");
    expect(writes).toHaveLength(1);
    view.rerender(<ReviewCodingSection teamId={TEAM} workflowId={WF_2} />);
    await waitFor(() => expect(notes().value).toBe("second review"));
    await release(0);
    // The previous review's pending intent went (if at all) to the previous review.
    await waitFor(() => expect(writes).toHaveLength(2));
    await release(1);
    for (const w of writes) expect(w.url.pathname).toBe(`/v1/reviewer/work/${WF}/code`);
    expect(store(TEAM, WF_2).values.get("f-notes")).toEqual({ text: "second review" });
    expect(store(TEAM, WF).values.get("f-notes")).toEqual({ text: "also for review 1" });
    // The new review's field shows its own value and no save state of the old one.
    expect(notes().value).toBe("second review");
    expect(statusOf("f-notes")).toBeNull();
  });

  it("switching workspace: an edit made in one workspace never goes out under the other", async () => {
    const view = await mount();
    type("team 1");
    type("team 1 again");
    view.rerender(<ReviewCodingSection teamId={TEAM_2} workflowId={WF} />);
    await screen.findByLabelText("Notes");
    await release(0);
    await waitFor(() => expect(writes).toHaveLength(2));
    await release(1);
    for (const w of writes) expect(w.url.searchParams.get("teamId")).toBe(TEAM);
    expect(store(TEAM_2, WF).values.size).toBe(0);
  });
});

describe("CodingPanel autosave — direct (review remediation A)", () => {
  const CONF = FIELDS[2]!;
  const NOTES = FIELDS[0]!;

  it("confidence change then immediate navigation: guarded while pending, and the final value is still sent", async () => {
    vi.useFakeTimers();
    const sent: Array<{ fieldId: string; value: Record<string, unknown> }> = [];
    const onWrite = vi.fn(async (input: { fieldId: string; value: Record<string, unknown> }) => {
      sent.push(input);
      return { ok: true } as CodingWriteOutcome;
    });
    const view = render(<CodingPanel fields={[CONF]} values={[]} unfulfilledFieldIds={new Set()} onWrite={onWrite} onClear={vi.fn()} revisions={{}} />);
    fireEvent.change(screen.getByRole("slider"), { target: { value: "73" } });
    expect(hasUnsavedCoding()).toBe(true);
    const evt = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    // Navigate away before the debounce fires.
    view.unmount();
    expect(sent).toEqual([{ fieldId: "f-conf", value: { confidence: 73 }, expectedRevision: 0 }]);
    expect(hasUnsavedCoding()).toBe(false);
  });

  it("navigation while an earlier confidence save is in flight: the pending final value is sent after it", async () => {
    vi.useFakeTimers();
    const pending: Array<(o: CodingWriteOutcome) => void> = [];
    const onWrite = vi.fn(
      (input: { fieldId: string; value: Record<string, unknown> }) =>
        new Promise<CodingWriteOutcome>((resolve) => {
          void input;
          pending.push(resolve);
        }),
    );
    const view = render(<CodingPanel fields={[CONF]} values={[]} unfulfilledFieldIds={new Set()} onWrite={onWrite} onClear={vi.fn()} revisions={{}} />);
    const slider = screen.getByRole("slider");
    fireEvent.change(slider, { target: { value: "40" } });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(onWrite).toHaveBeenCalledTimes(1);
    fireEvent.change(slider, { target: { value: "90" } });
    view.unmount();
    expect(onWrite).toHaveBeenCalledTimes(1);
    await act(async () => pending[0]!({ ok: true, revision: 1 }));
    expect(onWrite).toHaveBeenCalledTimes(2);
    expect(onWrite).toHaveBeenLastCalledWith({ fieldId: "f-conf", value: { confidence: 90 }, expectedRevision: 1 });
  });

  it("a refresh with an OLDER revision never replaces what this session saved", async () => {
    const onWrite = vi.fn(async () => ({ ok: true, revision: 2 }) as CodingWriteOutcome);
    const old = { id: "v", fieldId: "f-notes", value: { text: "old" }, rationale: null, authorUserId: "u", updatedAt: "x", revision: 1 };
    const view = render(
      <CodingPanel fields={[NOTES]} values={[old]} unfulfilledFieldIds={new Set()} onWrite={onWrite} onClear={vi.fn()} revisions={{ "f-notes": 1 }} />,
    );
    fireEvent.change(notes(), { target: { value: "new" } });
    fireEvent.blur(notes());
    await waitFor(() => expect(statusOf("f-notes")).toBe("Saved"));
    expect(onWrite).toHaveBeenCalledWith({ fieldId: "f-notes", value: { text: "new" }, expectedRevision: 1 });
    // A read that started before the save lands now (revision 1, "old").
    view.rerender(
      <CodingPanel
        fields={[NOTES]}
        values={[{ ...old, value: { text: "older read" } }]}
        unfulfilledFieldIds={new Set()}
        onWrite={onWrite}
        onClear={vi.fn()}
        revisions={{ "f-notes": 1 }}
      />,
    );
    expect(notes().value).toBe("new");
    // The read that follows the save (revision 2) is shown.
    view.rerender(
      <CodingPanel
        fields={[NOTES]}
        values={[{ ...old, value: { text: "new" }, revision: 2 }]}
        unfulfilledFieldIds={new Set()}
        onWrite={onWrite}
        onClear={vi.fn()}
        revisions={{ "f-notes": 2 }}
      />,
    );
    expect(notes().value).toBe("new");
  });

  it("a schema switch (contextKey) drops nothing into the new schema: the old field's pending edit keeps its own callback", async () => {
    const pending: Array<(o: CodingWriteOutcome) => void> = [];
    const oldWrite = vi.fn(() => new Promise<CodingWriteOutcome>((r) => pending.push(r)));
    const newWrite = vi.fn(async () => ({ ok: true }) as CodingWriteOutcome);
    const view = render(
      <CodingPanel contextKey="s1" fields={[NOTES]} values={[]} unfulfilledFieldIds={new Set()} onWrite={oldWrite} onClear={vi.fn()} />,
    );
    fireEvent.change(notes(), { target: { value: "one" } });
    fireEvent.blur(notes());
    fireEvent.change(notes(), { target: { value: "two" } });
    fireEvent.blur(notes());
    view.rerender(
      <CodingPanel contextKey="s2" fields={[NOTES]} values={[]} unfulfilledFieldIds={new Set()} onWrite={newWrite} onClear={vi.fn()} />,
    );
    await act(async () => pending[0]!({ ok: true }));
    expect(newWrite).not.toHaveBeenCalled();
    expect(oldWrite).toHaveBeenCalledTimes(2);
    expect(oldWrite).toHaveBeenLastCalledWith({ fieldId: "f-notes", value: { text: "two" } });
    // The new context shows no save state of the old one.
    expect(statusOf("f-notes")).toBeNull();
  });
});
