/**
 * Free acceptance pass (2026-11-18), identity journey J6.
 *
 * FAIL-1 — an open Capture draft re-saved itself continuously while idle
 * (~700 PATCH /v1/capture/sessions/:id per 20 s with one staged file). The page
 * ran its autosave effect on every render because it depended on the whole
 * object the hook returns (a new literal each render); every save changed
 * `savingState`, which re-rendered, which queued the same payload again, and
 * the post-save `finally` flushed it at once, skipping the debounce.
 *
 * FAIL-2 — a member demoted to Viewer kept autosaving into endless 403s. A 403
 * is now terminal for the draft, as the 409 lock already was.
 *
 * The harness reproduces the page's exact dependency on the hook object, so the
 * hook itself must hold the line; the page fix is pinned separately.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import { useCaptureDraftPersistence } from "../../app/(app)/capture/_hooks/useCaptureDraftPersistence";
import type { SessionItem } from "../../app/(app)/capture/_lib/types";

const requests: Array<{ method: string; path: string }> = [];
let answer: (method: string, path: string) => { status: number; body: unknown } = () => ({ status: 200, body: {} });

beforeEach(() => {
  requests.length = 0;
  answer = (method) =>
    method === "POST" ? { status: 201, body: { session: { id: "draft-1" } } } : { status: 200, body: { session: { id: "draft-1" } } };
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = new URL(String(input), "http://x").pathname;
      const method = (init.method ?? "GET").toUpperCase();
      requests.push({ method, path });
      const a = answer(method, path);
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ITEMS: SessionItem[] = [
  {
    id: "1",
    file: new File(["x"], "a.pdf", { type: "application/pdf" }),
    previewUrl: null,
    mimeType: "application/pdf",
    relativePath: null,
    uploadProgress: 0,
    uploading: false,
    error: null,
    checklistStepId: null,
  } as SessionItem,
];

/** The page's autosave, with the page's (old) dependency on the hook object. */
function Harness({ onState }: { onState: (s: string) => void }) {
  const persistence = useCaptureDraftPersistence({ enabled: true });
  useEffect(() => {
    persistence.scheduleSave({ templateId: null, planMode: "FLEXIBLE", internalNotes: "", useLocation: false, items: ITEMS });
  }, [persistence]);
  onState(persistence.savingState);
  return null;
}

const saves = () => requests.filter((r) => r.path.startsWith("/v1/capture/sessions"));

/** Let time pass the way an open page does: renders flush between steps. */
async function idle(ms: number) {
  for (let t = 0; t < ms; t += 250) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
  }
}

describe("Capture draft autosave", () => {
  it("FAIL-1: an idle draft saves once, not continuously, even when its caller re-runs the effect every render", async () => {
    render(<Harness onState={() => {}} />);
    await idle(20_000);
    expect(saves().length).toBeLessThanOrEqual(1);
    expect(saves().map((r) => r.method)).toEqual(["POST"]);
  });

  it("FAIL-2: a 403 stops autosave for the draft (no retry storm) and says so", async () => {
    answer = () => ({ status: 403, body: { code: "NOT_PERMITTED", message: "Your role can view records but not add them." } });
    let last = "";
    render(<Harness onState={(s) => (last = s)} />);
    await idle(20_000);
    expect(saves().length).toBe(1);
    expect(last).toBe("forbidden");
  });

  it("the page autosave depends on the stable scheduleSave, never on the whole hook object", () => {
    const page = readFileSync(resolve(__dirname, "..", "..", "app", "(app)", "capture", "page.tsx"), "utf8");
    const m = page.match(/useEffect\(\(\) => \{\s*(\w+)\(\{\s*templateId: collectionPlanId[\s\S]*?\}\);\s*\},\s*\[([\s\S]*?)\]\);/);
    expect(m, "the autosave effect is found").toBeTruthy();
    const deps = m![2]!;
    expect(m![1]).toBe("scheduleDraftSave");
    expect(deps).not.toMatch(/\bdraftPersistence\b(?!\.)/);
    expect(deps).toMatch(/scheduleDraftSave/);
  });
});
