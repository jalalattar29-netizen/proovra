/**
 * PRO-R3-04 / PRO-R3-18 — the image redaction editor shows the record it is
 * redacting and has a keyboard / touch path.
 *
 *   - the record's image comes from the Evidence detail read (the canonical
 *     evidence authority), and is drawn under the regions;
 *   - when that read releases no image (refused, or no previewable image), the
 *     editor says so instead of an unexplained placeholder;
 *   - a click without a drag adds no region (it used to add a 0.5% one);
 *   - the coordinate form adds exactly the rectangle it describes, and refuses
 *     one that leaves the frame without sending anything.
 *
 * Driven with the REAL apiFetch over a stubbed fetch.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import { ImageRedactionViewer } from "../../components/redaction/ImageRedactionViewer";
import { isDeliberateDrag, percentRectToNormalized } from "../../components/redaction/region-authoring";

type Reply = { status: number; body: unknown };
let handler: (method: string, path: string, body: unknown) => Reply;
const calls: Array<{ method: string; path: string; body: unknown }> = [];

beforeEach(() => {
  calls.length = 0;
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
  vi.unstubAllGlobals();
});

const evidenceWithImage: Reply = {
  status: 200,
  body: {
    evidence: {
      id: "e1",
      contentItems: [
        { id: "p0", mimeType: "application/pdf", viewUrl: "https://files.test/doc.pdf", isPrimary: false },
        { id: "p1", mimeType: "image/png", viewUrl: "https://files.test/photo.png", isPrimary: true },
      ],
    },
  },
};

function mount() {
  render(<ImageRedactionViewer evidenceId="e1" versionId="v1" regions={[]} versionLocked={false} onChanged={() => {}} />);
  const canvas = document.querySelector("[data-redaction-image-canvas]") as HTMLElement;
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  return canvas;
}

const regionPosts = () => calls.filter((c) => c.method === "POST" && c.path === "/v1/redaction/versions/v1/regions");

describe("PRO-R3-04 — the editor shows the record", () => {
  it("draws the record's image, read through the evidence detail", async () => {
    handler = (method, path) => (method === "GET" && path === "/v1/evidence/e1" ? evidenceWithImage : { status: 201, body: { regionId: "r1" } });
    mount();
    const img = await waitFor(() => {
      const el = document.querySelector<HTMLImageElement>("[data-redaction-image-preview]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(img.getAttribute("src")).toBe("https://files.test/photo.png");
    expect(document.querySelector("[data-redaction-image-placeholder]")).toBeNull();
  });

  it("says so when no image is released to this viewer", async () => {
    handler = () => ({ status: 403, body: { error: { code: "FORBIDDEN" } } });
    mount();
    await screen.findByText(/could not be shown here/i);
    expect(document.querySelector("[data-redaction-image-preview]")).toBeNull();
  });
});

describe("PRO-R3-18 — authoring without a mouse drag", () => {
  it("a click without a drag adds no region", async () => {
    handler = (method, path) => (method === "GET" && path === "/v1/evidence/e1" ? evidenceWithImage : { status: 201, body: { regionId: "r1" } });
    const canvas = mount();
    await act(async () => {
      fireEvent.mouseDown(canvas, { clientX: 30, clientY: 30 });
    });
    await act(async () => {
      fireEvent.mouseUp(canvas, { clientX: 30, clientY: 30 });
    });
    expect(regionPosts()).toHaveLength(0);
  });

  it("the coordinate form adds the rectangle it describes", async () => {
    handler = (method, path) => (method === "GET" && path === "/v1/evidence/e1" ? evidenceWithImage : { status: 201, body: { regionId: "r1" } });
    mount();
    const set = (name: string, value: string) =>
      fireEvent.change(document.querySelector(`[data-redaction-region-coordinate="${name}"]`) as HTMLInputElement, { target: { value } });
    set("left", "25");
    set("top", "50");
    set("width", "30");
    set("height", "20");
    await act(async () => {
      screen.getByRole("button", { name: "Add region" }).click();
    });
    await waitFor(() => expect(regionPosts()).toHaveLength(1));
    expect(regionPosts()[0]!.body).toEqual({
      kind: "BBOX_NORMALIZED",
      method: "BLACKOUT",
      geometry: { x: 0.25, y: 0.5, width: 0.3, height: 0.2 },
    });
  });

  it("a rectangle that leaves the frame is refused before anything is sent", async () => {
    handler = (method, path) => (method === "GET" && path === "/v1/evidence/e1" ? evidenceWithImage : { status: 201, body: { regionId: "r1" } });
    mount();
    fireEvent.change(document.querySelector('[data-redaction-region-coordinate="left"]') as HTMLInputElement, { target: { value: "90" } });
    fireEvent.change(document.querySelector('[data-redaction-region-coordinate="width"]') as HTMLInputElement, { target: { value: "30" } });
    await act(async () => {
      screen.getByRole("button", { name: "Add region" }).click();
    });
    await screen.findByText(/must lie inside the frame/i);
    expect(regionPosts()).toHaveLength(0);
  });

  it("the rectangle rules", () => {
    expect(isDeliberateDrag(0, 0)).toBe(false);
    expect(isDeliberateDrag(0.2, 0.004)).toBe(false);
    expect(isDeliberateDrag(0.2, 0.1)).toBe(true);
    expect(percentRectToNormalized({ left: 0, top: 0, width: 100, height: 100 })).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(percentRectToNormalized({ left: -1, top: 0, width: 10, height: 10 })).toBeNull();
    expect(percentRectToNormalized({ left: 0, top: 0, width: 0, height: 10 })).toBeNull();
    expect(percentRectToNormalized({ left: Number.NaN, top: 0, width: 10, height: 10 })).toBeNull();
  });
});
