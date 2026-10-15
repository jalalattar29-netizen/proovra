/**
 * AUD-025 — the owner / verify capture-location map never asks a third-party
 * tile server for the evidence coordinates by default. With no configured
 * tile endpoint the panel draws the map locally (a data: URL built from the
 * recorded coordinates) and says so.
 */
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { CAPTURE_LOCATION_LOCAL_RENDER_LABEL } from "@proovra/shared";

import CaptureLocationMapPanel from "../../components/capture-location/CaptureLocationMapPanel";

describe("CaptureLocationMapPanel (default, no tile endpoint)", () => {
  it("requests no remote tile: every image is local, no openstreetmap URL in the output", () => {
    const { container } = render(<CaptureLocationMapPanel lat={51.5007292} lng={-0.1246254} accuracyMeters={12} />);
    const html = container.innerHTML;
    expect(html).not.toMatch(/tile\.openstreetmap/);
    const sources = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src") ?? "");
    expect(sources.length).toBeGreaterThan(0);
    for (const src of sources) expect(src.startsWith("data:")).toBe(true);
    expect(container.textContent).toContain(CAPTURE_LOCATION_LOCAL_RENDER_LABEL);
    // Coordinates and layout are preserved.
    expect(container.textContent).toContain("51.500729");
  });
});
