/**
 * PRO-R3-04 — the PDF redaction editor shows the page it is redacting.
 *
 * At the base the frame was always blank ("the page is not shown here").
 *
 *   - the editor asks GET /v1/redaction/projects/:id/preview/pages/:n, shows
 *     "Preparing preview…" while the answer is PENDING, asks again with a
 *     growing pause, and draws the page image under the regions when READY;
 *   - the frame takes the page's proportions, and a region drawn over the
 *     image is still sent as a share of the page;
 *   - this page's saved rectangles are drawn back over it;
 *   - an API that predates the route (404), a page with no preview, and a
 *     render that never arrives all keep the plain frame and its copy;
 *   - without a project id nothing is asked.
 *
 * Driven with the REAL apiFetch over a stubbed fetch.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import {
  PDF_PREVIEW_POLL_BUDGET_MS,
  PDF_PREVIEW_SETTLE_MS,
  PdfRedactionViewer,
} from "../../components/redaction/PdfRedactionViewer";

type Reply = { status: number; body: unknown };
let handler: (method: string, path: string, body: unknown) => Reply;
const calls: Array<{ method: string; path: string; body: unknown }> = [];

beforeEach(() => {
  calls.length = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, "");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, path, body });
      const out = handler(method, path, body);
      return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const previewPath = (page: number) => `/v1/redaction/projects/p1/preview/pages/${page}`;
const previewAsks = (page = 0) => calls.filter((c) => c.method === "GET" && c.path === previewPath(page));
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const frame = () => document.querySelector("[data-redaction-pdf-canvas]") as HTMLElement;
const image = () => document.querySelector<HTMLImageElement>("[data-redaction-pdf-page-image]");
const READY: Reply = {
  status: 200,
  body: { state: "READY", url: "https://files.test/redactions/t/previews/p1/page-0-abc.png?sig=1", width: 1190, height: 1684, expiresAtUtc: "2026-11-19T12:05:00.000Z" },
};
const PENDING: Reply = { status: 200, body: { state: "PENDING" } };
/** What a Fastify API without the route answers. */
const OLD_API_404: Reply = { status: 404, body: { message: "Route GET:/v1/redaction/projects/p1/preview/pages/0 not found", error: "Not Found", statusCode: 404 } };

function mount(props: Partial<React.ComponentProps<typeof PdfRedactionViewer>> = {}) {
  render(<PdfRedactionViewer evidenceId="e1" projectId="p1" versionId="v1" versionLocked={false} onChanged={() => {}} {...props} />);
}

describe("PRO-R3-04 — the PDF editor shows the page", () => {
  it("pending, then ready: says it is preparing, asks again, then draws the page under the regions", async () => {
    let asks = 0;
    handler = (method, path) => {
      if (method === "GET" && path === previewPath(0)) return ++asks < 3 ? PENDING : READY;
      return { status: 201, body: { regionId: "r1" } };
    };
    mount();
    // Nothing is asked until the page number has settled.
    expect(previewAsks()).toHaveLength(0);
    await advance(PDF_PREVIEW_SETTLE_MS);
    expect(previewAsks()).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe("Preparing preview…");
    expect(image()).toBeNull();
    expect(frame().style.aspectRatio).toBe("1 / 1.4142");

    await advance(1000);
    expect(previewAsks()).toHaveLength(2);
    expect(screen.getByRole("status").textContent).toBe("Preparing preview…");

    await advance(2000);
    expect(previewAsks()).toHaveLength(3);
    expect(image()?.getAttribute("src")).toBe((READY.body as { url: string }).url);
    expect(image()?.getAttribute("alt")).toBe("Page 1 of the record");
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.querySelector("[data-redaction-pdf-no-preview]")).toBeNull();
    // The frame takes the page's own proportions.
    expect(frame().style.aspectRatio).toBe("1190 / 1684");
    // READY ends the asking.
    await advance(60_000);
    expect(previewAsks()).toHaveLength(3);

    // A region drawn over the image is still a share of the page.
    frame().getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 100, height: 200, right: 100, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    await act(async () => {
      fireEvent.mouseDown(frame(), { clientX: 10, clientY: 20 });
    });
    await act(async () => {
      fireEvent.mouseMove(frame(), { clientX: 60, clientY: 120 });
    });
    await act(async () => {
      fireEvent.mouseUp(frame(), { clientX: 60, clientY: 120 });
    });
    const posts = calls.filter((c) => c.method === "POST" && c.path === "/v1/redaction/versions/v1/regions");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({
      kind: "PDF_PAGE_RECT",
      method: "BLACKOUT",
      geometry: { pageIndex: 0, rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } },
    });
  });

  it("an API without the route (404) keeps the plain frame and asks once", async () => {
    handler = () => OLD_API_404;
    mount();
    await advance(PDF_PREVIEW_SETTLE_MS);
    expect(previewAsks()).toHaveLength(1);
    expect(document.querySelector("[data-redaction-pdf-no-preview]")?.textContent).toMatch(/Page 1 — the page is not shown here/);
    expect(image()).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(frame().style.aspectRatio).toBe("1 / 1.4142");
    await advance(60_000);
    expect(previewAsks()).toHaveLength(1);
    // The link to the record and the coordinate form are still there.
    expect(document.querySelector("[data-redaction-pdf-open-record]")).not.toBeNull();
  });

  it("a page with no preview, a refusal and a lost answer keep the plain frame", async () => {
    for (const reply of [
      { status: 200, body: { state: "UNAVAILABLE", reason: "page_out_of_range" } },
      { status: 403, body: { denial: "NOT_PERMITTED" } },
      { status: 404, body: { denial: "PROJECT_NOT_FOUND" } },
      { status: 200, body: { state: "READY" } },
    ] satisfies Reply[]) {
      calls.length = 0;
      handler = () => reply;
      mount();
      await advance(PDF_PREVIEW_SETTLE_MS);
      expect(previewAsks(), JSON.stringify(reply)).toHaveLength(1);
      expect(document.querySelector("[data-redaction-pdf-no-preview]"), JSON.stringify(reply)).not.toBeNull();
      expect(image()).toBeNull();
      await advance(30_000);
      expect(previewAsks()).toHaveLength(1);
      cleanup();
    }
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    mount();
    await advance(PDF_PREVIEW_SETTLE_MS + 5_000);
    expect(document.querySelector("[data-redaction-pdf-no-preview]")).not.toBeNull();
  });

  it("a render that never arrives stops being asked for after the budget", async () => {
    handler = () => PENDING;
    mount();
    await advance(PDF_PREVIEW_SETTLE_MS + PDF_PREVIEW_POLL_BUDGET_MS);
    // 1 s, 2 s, 4 s, 8 s, then every 10 s inside 120 s: 15 asks in all.
    expect(previewAsks()).toHaveLength(15);
    expect(document.querySelector("[data-redaction-pdf-no-preview]")).not.toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    await advance(120_000);
    expect(previewAsks()).toHaveLength(15);
  });

  it("changing the page asks for that page, and each page shows its own saved rectangles", async () => {
    handler = (method, path) => (method === "GET" && path === previewPath(1) ? { ...READY, body: { ...(READY.body as object), url: "https://files.test/page-1.png" } } : PENDING);
    mount({
      regions: [
        { id: "r-page0", kind: "PDF_PAGE_RECT", geometry: { pageIndex: 0, rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } } },
        { id: "r-page1", kind: "PDF_PAGE_RECT", geometry: { pageIndex: 1, rect: { x: 0.5, y: 0.5, width: 0.25, height: 0.25 } } },
        { id: "r-text", kind: "PDF_TEXT_RANGE", geometry: { pageIndex: 0 } },
      ],
    });
    await advance(PDF_PREVIEW_SETTLE_MS);
    expect(previewAsks(0)).toHaveLength(1);
    const drawn = () => [...document.querySelectorAll("[data-redaction-pdf-region]")].map((n) => n.getAttribute("data-redaction-pdf-region"));
    expect(drawn()).toEqual(["r-page0"]);
    const first = document.querySelector<HTMLElement>('[data-redaction-pdf-region="r-page0"]')!;
    expect([first.style.left, first.style.top, first.style.width, first.style.height]).toEqual(["10%", "20%", "30%", "40%"]);

    await act(async () => {
      fireEvent.change(document.querySelector("[data-redaction-pdf-page]") as HTMLInputElement, { target: { value: "1" } });
    });
    // The old page's pending answer is not carried over.
    expect(screen.queryByRole("status")).toBeNull();
    await advance(PDF_PREVIEW_SETTLE_MS);
    expect(previewAsks(1)).toHaveLength(1);
    expect(image()?.getAttribute("src")).toBe("https://files.test/page-1.png");
    expect(drawn()).toEqual(["r-page1"]);
    // The poll of the page that was left has stopped.
    const before = previewAsks(0).length;
    await advance(30_000);
    expect(previewAsks(0)).toHaveLength(before);
  });

  it("an image that fails to load is asked for once more, then the plain frame", async () => {
    handler = () => READY;
    mount();
    await advance(PDF_PREVIEW_SETTLE_MS);
    expect(previewAsks()).toHaveLength(1);
    await act(async () => {
      fireEvent.error(image()!);
    });
    await advance(PDF_PREVIEW_SETTLE_MS);
    expect(previewAsks()).toHaveLength(2);
    await act(async () => {
      fireEvent.error(image()!);
    });
    expect(image()).toBeNull();
    expect(document.querySelector("[data-redaction-pdf-no-preview]")).not.toBeNull();
    await advance(30_000);
    expect(previewAsks()).toHaveLength(2);
  });

  it("without a project id, or for a page past the cap, nothing is asked", async () => {
    handler = () => READY;
    mount({ projectId: undefined });
    await advance(5_000);
    expect(calls).toHaveLength(0);
    expect(document.querySelector("[data-redaction-pdf-no-preview]")).not.toBeNull();
    cleanup();
    mount();
    await act(async () => {
      fireEvent.change(document.querySelector("[data-redaction-pdf-page]") as HTMLInputElement, { target: { value: "200" } });
    });
    await advance(5_000);
    expect(previewAsks(200)).toHaveLength(0);
  });
});
