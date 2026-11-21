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
import { VideoRedactionViewer } from "../../components/redaction/VideoRedactionViewer";
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

/** WEB-OLD-API-COMPAT — authoring opens only once the record image has loaded. */
async function imageShown() {
  const img = await waitFor(() => {
    const el = document.querySelector<HTMLImageElement>("[data-redaction-image-preview]");
    expect(el).not.toBeNull();
    return el!;
  });
  await act(async () => {
    fireEvent.load(img);
  });
  return img;
}

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
    await imageShown();
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
    await imageShown();
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
    await imageShown();
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

/**
 * WEB-OLD-API-COMPAT — the image editor never places a region over an image
 * the operator cannot see: while the image is loading, when the evidence read
 * releases none, or when the image fails, drawing and the coordinate form are
 * DISABLED with a notice. The video panel offers no drawing at all (video
 * regions are not a supported capability).
 */
async function tryBlindImageAuthoring(canvas: HTMLElement) {
  await act(async () => {
    fireEvent.mouseDown(canvas, { clientX: 10, clientY: 10 });
  });
  await act(async () => {
    fireEvent.mouseMove(canvas, { clientX: 60, clientY: 60 });
  });
  await act(async () => {
    fireEvent.mouseUp(canvas, { clientX: 60, clientY: 60 });
  });
  await act(async () => {
    fireEvent.submit(document.querySelector("[data-redaction-region-coordinate-form]") as HTMLFormElement);
  });
}
const addRegionButton = () => screen.getByRole("button", { name: "Add region" }) as HTMLButtonElement;
const blocked = () => document.querySelector<HTMLElement>("[data-redaction-authoring-blocked]");

describe("WEB-OLD-API-COMPAT — no image region without the image in view", () => {
  it("loading: disabled with a waiting notice, nothing sent", async () => {
    let release: (r: Reply) => void = () => {};
    const pending = new Promise<Reply>((r) => (release = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input).replace(/^https?:\/\/[^/]+/, "");
        calls.push({ method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(String(init.body)) : null });
        const out = path === "/v1/evidence/e1" ? await pending : { status: 201, body: {} };
        return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
      }),
    );
    const canvas = mount();
    expect(addRegionButton().disabled).toBe(true);
    expect(blocked()?.getAttribute("data-redaction-authoring-blocked")).toBe("waiting");
    await tryBlindImageAuthoring(canvas);
    expect(regionPosts()).toHaveLength(0);
    // The image URL arrives but has not loaded yet: still waiting.
    await act(async () => {
      release(evidenceWithImage);
    });
    await waitFor(() => expect(document.querySelector("[data-redaction-image-preview]")).not.toBeNull());
    expect(addRegionButton().disabled).toBe(true);
    expect(blocked()?.getAttribute("data-redaction-authoring-blocked")).toBe("waiting");
  });

  it("no image released (refusal / no image part): disabled as unavailable, nothing sent", async () => {
    for (const reply of [
      { status: 403, body: { error: { code: "FORBIDDEN", message: "no" } } },
      { status: 200, body: { evidence: { id: "e1", contentItems: [{ id: "p0", mimeType: "image/png" }] } } },
    ] satisfies Reply[]) {
      calls.length = 0;
      handler = (method, path) => (method === "GET" && path === "/v1/evidence/e1" ? reply : { status: 201, body: { regionId: "r1" } });
      const canvas = mount();
      await screen.findByText(/could not be shown here/i);
      expect(addRegionButton().disabled).toBe(true);
      expect(canvas.getAttribute("data-redaction-authoring")).toBe("disabled");
      expect(blocked()?.getAttribute("data-redaction-authoring-blocked")).toBe("unavailable");
      await tryBlindImageAuthoring(canvas);
      expect(regionPosts(), JSON.stringify(reply)).toHaveLength(0);
      cleanup();
    }
  });

  it("an image that fails to load: disabled as unavailable, nothing sent", async () => {
    handler = (method, path) => (method === "GET" && path === "/v1/evidence/e1" ? evidenceWithImage : { status: 201, body: { regionId: "r1" } });
    const canvas = mount();
    const img = await imageShown();
    expect(addRegionButton().disabled).toBe(false);
    expect(blocked()).toBeNull();
    await act(async () => {
      fireEvent.error(img);
    });
    expect(addRegionButton().disabled).toBe(true);
    expect(blocked()?.getAttribute("data-redaction-authoring-blocked")).toBe("unavailable");
    await tryBlindImageAuthoring(canvas);
    expect(regionPosts()).toHaveLength(0);
  });

  it("image loaded: a drag adds the region", async () => {
    handler = (method, path) => (method === "GET" && path === "/v1/evidence/e1" ? evidenceWithImage : { status: 201, body: { regionId: "r1" } });
    const canvas = mount();
    await imageShown();
    expect(canvas.getAttribute("data-redaction-authoring")).toBe("enabled");
    await act(async () => {
      fireEvent.mouseDown(canvas, { clientX: 10, clientY: 10 });
    });
    await act(async () => {
      fireEvent.mouseMove(canvas, { clientX: 60, clientY: 60 });
    });
    await act(async () => {
      fireEvent.mouseUp(canvas, { clientX: 60, clientY: 60 });
    });
    expect(regionPosts()).toHaveLength(1);
    expect(regionPosts()[0]!.body).toEqual({
      kind: "BBOX_NORMALIZED",
      method: "BLACKOUT",
      geometry: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
    });
  });

  /**
   * Closure 2026-11-21 — video-region authoring is not a product capability
   * (FUTURE_NOT_SHIPPING: no frame preview, no renderer, video copy refused).
   * The panel offers no drawing surface and no frame-range / method / tracking
   * controls, says what is supported, and sends nothing whatever is clicked.
   */
  it("video: no drawing surface or region controls; the notice states the image/PDF-only contract; nothing is sent", async () => {
    handler = () => ({ status: 201, body: { regionId: "r1" } });
    render(<VideoRedactionViewer />);
    const panel = document.querySelector("[data-redaction-video-viewer]") as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.getAttribute("data-redaction-authoring")).toBe("disabled");
    expect(document.querySelector("[data-redaction-video-canvas]")).toBeNull();
    expect(panel.querySelectorAll("input, select, textarea, button, [role=listbox], [role=combobox]")).toHaveLength(0);
    expect(blocked()?.getAttribute("data-redaction-authoring-blocked")).toBe("unsupported");
    expect(blocked()?.textContent).toMatch(/image and PDF records only/);
    expect(blocked()?.textContent).toMatch(/no redacted video copy is produced/);
    expect(panel.textContent).not.toMatch(/drag to draw|frame-by-frame|Blur|Pixelate/i);
    await act(async () => {
      fireEvent.mouseDown(panel, { clientX: 10, clientY: 10 });
    });
    await act(async () => {
      fireEvent.mouseMove(panel, { clientX: 60, clientY: 60 });
    });
    await act(async () => {
      fireEvent.mouseUp(panel, { clientX: 60, clientY: 60 });
    });
    expect(regionPosts()).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});
