/**
 * Review remediation IR-01 / IR-02 (2026-11-28) — independent-review findings.
 *
 * IR-01: after this session saved A, a NEWER stored value B (another tab or
 * reviewer) read IN PAGE — the same mounted panel, never a remount — makes
 * the old "saved A" obsolete. Editing back to A must be sent on the newer
 * revision and stored; "Saved" must never stand for A while B is stored.
 *
 * IR-02: flushPendingCoding() — what the review page awaits before it sends
 * a verdict / adjudication — commits edited fields, sends debounced ones at
 * once, waits until every save settled and names the fields NOT stored.
 *
 * Same fake API as coding-autosave-ordering: real ReviewCodingSection →
 * reviewer-api → apiFetch over a stubbed fetch with the API revision rule;
 * every POST is held until the test releases it.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { chooseListbox } from "./_listbox";

vi.mock("../../app/(app)/reviewer-ops/components/CodingSchemaBindingPanel", () => ({
  CodingSchemaBindingPanel: () => null,
}));

import { ReviewCodingSection } from "../../components/reviewer-experience/ReviewCodingSection";
import { codingHoldMessage, flushPendingCoding } from "../../components/reviewer-workspace/CodingPanel";
import type { CodingFieldRow } from "../../lib/reviewer-workspace/reviewer-api";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WF = "22222222-2222-4222-8222-222222222222";
const SCHEMA = "11111111-1111-4111-8111-111111111111";

const FIELDS: CodingFieldRow[] = [
  { id: "f-notes", slug: "notes", label: "Notes", fieldType: "TEXT", required: false, orderIndex: 0, helpText: null, options: null },
  { id: "f-risk", slug: "risk", label: "Risk level", fieldType: "RISK_LEVEL", required: false, orderIndex: 1, helpText: null, options: null },
  { id: "f-conf", slug: "conf", label: "Confidence", fieldType: "CONFIDENCE_SCORE", required: false, orderIndex: 2, helpText: null, options: null },
  { id: "f-count", slug: "count", label: "Count", fieldType: "NUMERIC", required: false, orderIndex: 3, helpText: null, options: null },
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

let stores: Map<string, Store>;
let writes: HeldWrite[];
type HeldRead = { release: () => void };
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
const count = () => screen.getByLabelText("Count") as HTMLInputElement;
const statusOf = (fieldId: string) =>
  document.querySelector(`[data-coding-field-id="${fieldId}"] [data-coding-field-status]`)?.textContent ?? null;
const riskTrigger = () =>
  document.querySelector('[data-coding-field-id="f-risk"] [aria-labelledby="coding-field-label-f-risk"]');

function Harness({ refreshKey }: { refreshKey: number }) {
  return <ReviewCodingSection teamId={TEAM} workflowId={WF} refreshKey={refreshKey} />;
}
async function mount() {
  const view = render(<Harness refreshKey={0} />);
  await screen.findByLabelText("Notes");
  let key = 0;
  /** An in-page coding reread (the SAME mounted panel, never a remount). */
  const reread = async () => {
    key += 1;
    view.rerender(<Harness refreshKey={key} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  };
  return { view, reread };
}
function typeInto(el: HTMLElement, text: string) {
  fireEvent.change(el, { target: { value: text } });
  fireEvent.blur(el);
}
async function release(i: number) {
  await act(async () => {
    writes[i]!.respond();
  });
}
/** Another tab / reviewer writes the field directly in the store. */
function otherTabWrites(fieldId: string, value: Record<string, unknown> | null) {
  const s = store();
  const rev = s.revisions.get(fieldId) ?? 0;
  if (value === null) s.values.delete(fieldId);
  else s.values.set(fieldId, value);
  s.revisions.set(fieldId, rev + 1);
}

// ---------------------------------------------------------------------------
// IR-01 — a newer server value adopted in-page makes this session's old
// "saved" operation obsolete: editing back to it is sent, on the new base.
// ---------------------------------------------------------------------------

describe("IR-01 — returning to a previously saved value after a newer in-page reread is persisted", () => {
  it("text: save A, another tab stores B, reread shows B; editing back to A sends A on revision 2 and stores A", async () => {
    const { reread } = await mount();
    typeInto(notes(), "A");
    await release(0);
    await waitFor(() => expect(statusOf("f-notes")).toBe("Saved"));
    otherTabWrites("f-notes", { text: "B" });
    await reread();
    await waitFor(() => expect(notes().value).toBe("B"));
    // The old "Saved" (for A) no longer describes the field.
    expect(statusOf("f-notes")).toBeNull();
    typeInto(notes(), "A");
    expect(writes).toHaveLength(2);
    expect(writes[1]!.body).toEqual({ fieldId: "f-notes", value: { text: "A" }, expectedRevision: 2 });
    await release(1);
    await waitFor(() => expect(statusOf("f-notes")).toBe("Saved"));
    expect(store().values.get("f-notes")).toEqual({ text: "A" });
    expect(store().revisions.get("f-notes")).toBe(3);
  });

  it("number: save 7, another tab stores 9, reread shows 9; editing back to 7 sends 7 on revision 2", async () => {
    const { reread } = await mount();
    typeInto(count(), "7");
    await release(0);
    await waitFor(() => expect(statusOf("f-count")).toBe("Saved"));
    otherTabWrites("f-count", { number: 9 });
    await reread();
    await waitFor(() => expect(count().value).toBe("9"));
    typeInto(count(), "7");
    expect(writes[1]!.body).toEqual({ fieldId: "f-count", value: { number: 7 }, expectedRevision: 2 });
    await release(1);
    await waitFor(() => expect(statusOf("f-count")).toBe("Saved"));
    expect(store().values.get("f-count")).toEqual({ number: 7 });
  });

  it("clearing: save A, another tab stores B, reread; emptying the field sends a clear on revision 2", async () => {
    const { reread } = await mount();
    typeInto(notes(), "A");
    await release(0);
    otherTabWrites("f-notes", { text: "B" });
    await reread();
    await waitFor(() => expect(notes().value).toBe("B"));
    typeInto(notes(), "");
    expect(writes[1]!.body).toEqual({ fieldId: "f-notes", clear: true, expectedRevision: 2 });
    await release(1);
    await waitFor(() => expect(statusOf("f-notes")).toBe("Saved"));
    expect(store().values.has("f-notes")).toBe(false);
  });

  it("another tab CLEARED after this session saved A: typing A again is sent (not skipped as 'already A')", async () => {
    const { reread } = await mount();
    typeInto(notes(), "A");
    await release(0);
    otherTabWrites("f-notes", null);
    await reread();
    await waitFor(() => expect(notes().value).toBe(""));
    typeInto(notes(), "A");
    expect(writes[1]!.body).toEqual({ fieldId: "f-notes", value: { text: "A" }, expectedRevision: 2 });
    await release(1);
    await waitFor(() => expect(store().values.get("f-notes")).toEqual({ text: "A" }));
  });

  it("choice: save LOW, another tab stores HIGH, reread; choosing LOW again is sent and stored", async () => {
    const { reread } = await mount();
    chooseListbox(riskTrigger(), "LOW");
    await release(0);
    await waitFor(() => expect(statusOf("f-risk")).toBe("Saved"));
    otherTabWrites("f-risk", { risk: "HIGH" });
    await reread();
    await waitFor(() => expect(riskTrigger()?.textContent).toContain("HIGH"));
    chooseListbox(riskTrigger(), "LOW");
    expect(writes[1]!.body).toEqual({ fieldId: "f-risk", value: { risk: "LOW" }, expectedRevision: 2 });
    await release(1);
    await waitFor(() => expect(store().values.get("f-risk")).toEqual({ risk: "LOW" }));
  });

  it("a reread that arrives WHILE EDITING: editing back to A is sent and refused as a conflict, never shown as Saved", async () => {
    const { reread } = await mount();
    typeInto(notes(), "A");
    await release(0);
    await waitFor(() => expect(statusOf("f-notes")).toBe("Saved"));
    fireEvent.change(notes(), { target: { value: "A2" } }); // editing, not committed
    otherTabWrites("f-notes", { text: "B" });
    await reread();
    expect(notes().value).toBe("A2"); // the reviewer's typing is kept
    fireEvent.change(notes(), { target: { value: "A" } });
    fireEvent.blur(notes());
    expect(writes).toHaveLength(2);
    expect(writes[1]!.body).toEqual({ fieldId: "f-notes", value: { text: "A" }, expectedRevision: 1 });
    await release(1);
    await waitFor(() => expect(statusOf("f-notes")).toContain("Changed in another tab"));
    expect(notes().value).toBe("A");
    expect(store().values.get("f-notes")).toEqual({ text: "B" });
  });

  it("a reread that arrives WHILE SAVING: the save answers with a conflict, the draft stays, nothing reads Saved", async () => {
    const { reread } = await mount();
    typeInto(notes(), "A");
    otherTabWrites("f-notes", { text: "B" });
    await reread();
    expect(notes().value).toBe("A");
    await release(0);
    await waitFor(() => expect(statusOf("f-notes")).toContain("Changed in another tab"));
    expect(store().values.get("f-notes")).toEqual({ text: "B" });
    expect(notes().value).toBe("A");
  });

  it("this session's own save re-read (same revision) still skips an unchanged commit", async () => {
    const { reread } = await mount();
    typeInto(notes(), "A");
    await release(0);
    await reread();
    await waitFor(() => expect(notes().value).toBe("A"));
    fireEvent.focus(notes());
    fireEvent.blur(notes());
    expect(writes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// IR-02 — flushPendingCoding: what a decision waits for before it is sent.
// ---------------------------------------------------------------------------

describe("IR-02 — flushPendingCoding saves what is entered and reports what is not stored", () => {
  it("nothing touched: resolves ok at once and sends nothing (coding stays optional)", async () => {
    await mount();
    await expect(flushPendingCoding()).resolves.toEqual({ ok: true });
    expect(writes).toHaveLength(0);
  });

  it("an edited text field not yet committed (focus still in it) is committed and awaited", async () => {
    await mount();
    fireEvent.change(notes(), { target: { value: "typed, not blurred" } });
    let result: unknown = null;
    const p = flushPendingCoding().then((r) => (result = r));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(result).toBeNull();
    await release(0);
    await p;
    expect(result).toEqual({ ok: true });
    expect(store().values.get("f-notes")).toEqual({ text: "typed, not blurred" });
  });

  it("an in-flight save with a NEWER pending edit: waits for both; the newest value is stored", async () => {
    await mount();
    typeInto(notes(), "older");
    typeInto(notes(), "newest");
    let result: unknown = null;
    const p = flushPendingCoding().then((r) => (result = r));
    await release(0);
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(result).toBeNull();
    await release(1);
    await p;
    expect(result).toEqual({ ok: true });
    expect(store().values.get("f-notes")).toEqual({ text: "newest" });
  });

  it("a debounced confidence change is sent at once, not after the debounce", async () => {
    await mount();
    const slider = screen.getByLabelText("Confidence") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "80" } });
    expect(writes).toHaveLength(0);
    const p = flushPendingCoding();
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body.value).toEqual({ confidence: 80 });
    await release(0);
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("a network failure: not ok, names the field, keeps the draft and offers Retry", async () => {
    await mount();
    typeInto(notes(), "lost");
    const p = flushPendingCoding();
    await act(async () => writes[0]!.fail());
    await expect(p).resolves.toEqual({ ok: false, fields: ["Notes"] });
    expect(notes().value).toBe("lost");
    expect(screen.getByRole("button", { name: "Retry saving Notes" })).toBeTruthy();
    expect(codingHoldMessage(["Notes"])).toContain("Notes is not saved");
  });

  it("a conflict: not ok, the draft is kept and Reload / Keep mine are offered", async () => {
    await mount();
    otherTabWrites("f-notes", { text: "theirs" });
    typeInto(notes(), "mine");
    const p = flushPendingCoding();
    await release(0);
    await expect(p).resolves.toEqual({ ok: false, fields: ["Notes"] });
    expect(notes().value).toBe("mine");
    expect(screen.getByRole("button", { name: "Reload Notes" })).toBeTruthy();
  });

  it("an earlier failed field still holds the decision until it is retried successfully", async () => {
    await mount();
    typeInto(notes(), "x");
    await act(async () => writes[0]!.fail());
    await expect(flushPendingCoding()).resolves.toEqual({ ok: false, fields: ["Notes"] });
    fireEvent.click(screen.getByRole("button", { name: "Retry saving Notes" }));
    const p = flushPendingCoding();
    await release(1);
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("the hold message names several fields readably", () => {
    expect(codingHoldMessage(["Notes", "Risk level", "Count"])).toContain("your coding for Notes, Risk level and Count are not saved");
  });
});
