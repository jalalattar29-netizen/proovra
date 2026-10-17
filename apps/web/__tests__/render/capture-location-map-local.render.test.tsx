/**
 * THE RECORDED-LOCATION PANEL (2026-10-17) — one presentation for the owner
 * Evidence page and the full Public Verify page.
 *
 *   - AUD-025: no tile is ever requested unless the deployment configured an
 *     APPROVED endpoint (the shared policy refuses public providers);
 *   - with one, a REAL map: tiles at the recorded position, a marker, the
 *     RECORDED accuracy radius, zoom, attribution and an accessible label;
 *   - without one, or when tiles fail: a compact "Recorded location" card —
 *     never the old dark synthetic pseudo-map, never "blocked";
 *   - out-of-range coordinates fail closed: no map, no outbound link;
 *   - device-reported coordinates are never shown as verified.
 */
import React from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";

import CaptureLocationMapPanel from "../../components/capture-location/CaptureLocationMapPanel";

const APPROVED = "https://tiles.internal.example/{z}/{x}/{y}.png";
const LAT = 51.5007292;
const LNG = -0.1246254;

describe("CaptureLocationMapPanel — default (no approved tile endpoint)", () => {
  it("requests no tile and draws no pseudo-map: a compact Recorded location card with the facts and actions", () => {
    const { container } = render(<CaptureLocationMapPanel lat={LAT} lng={LNG} accuracyMeters={12} sourceLabel="Reported by the submitting browser" />);
    expect(container.querySelector("[data-capture-location-map]")?.getAttribute("data-capture-location-map")).toBe("fallback");
    // No image of any kind — the synthetic data: SVG map is gone.
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.innerHTML).not.toMatch(/tile\.openstreetmap|data:image\/svg/);
    expect(container.textContent).not.toMatch(/Map imagery unavailable|Blocked/i);
    expect(container.textContent).toContain("Recorded location");
    expect(container.textContent).toContain("Map preview unavailable");
    expect(container.querySelector("[data-capture-location-coordinates]")?.textContent).toContain("51.500729");
    expect(container.textContent).toContain("Accuracy");
    expect(container.querySelector("[data-capture-location-source-label]")?.textContent).toBe("Reported by the submitting browser");
    expect(container.querySelector("[data-map-action='copy-coordinates']")?.tagName).toBe("BUTTON");
    expect(container.querySelector("[data-map-action='open-in-map']")?.getAttribute("href")).toMatch(/^https:\/\/www\.openstreetmap\.org\//);
    // The evidence boundary, briefly.
    expect(container.querySelector("[data-capture-location-boundary]")?.textContent).toMatch(/does not independently prove where the subject matter was/);
  });

  it("a public tile provider is refused even when configured (AUD-025)", () => {
    const { container } = render(
      <CaptureLocationMapPanel lat={LAT} lng={LNG} accuracyMeters={12} tileTemplate="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />,
    );
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.querySelector("[data-capture-location-map]")?.getAttribute("data-capture-location-map")).toBe("fallback");
  });
});

describe("CaptureLocationMapPanel — with an approved tile endpoint", () => {
  it("renders a REAL map: tiles at the recorded position, a marker, the recorded accuracy radius, zoom and attribution", () => {
    const { container } = render(<CaptureLocationMapPanel lat={LAT} lng={LNG} accuracyMeters={25} tileTemplate={APPROVED} />);
    const map = container.querySelector("[data-capture-location-map-view]") as HTMLElement;
    expect(map).toBeTruthy();
    expect(map.getAttribute("role")).toBe("img");
    expect(map.getAttribute("aria-label")).toMatch(/^Map of the recorded location at 51\.500729/);
    const tiles = Array.from(container.querySelectorAll("img[data-map-tile]")) as HTMLImageElement[];
    expect(tiles.length).toBeGreaterThan(0);
    for (const t of tiles) expect(t.getAttribute("src")).toMatch(/^https:\/\/tiles\.internal\.example\/\d+\/\d+\/\d+\.png$/);
    expect(container.querySelector("[data-map-marker]")).toBeTruthy();
    expect(container.querySelector("[data-map-accuracy-radius]")?.getAttribute("data-map-accuracy-radius")).toBe("25");
    expect(container.querySelector("[data-map-attribution]")?.textContent).toMatch(/OpenStreetMap contributors/);
    // Zoom is interactive and re-requests tiles at the new level.
    const z = Number(map.getAttribute("data-map-zoom"));
    fireEvent.click(container.querySelector("[data-map-action='zoom-in']")!);
    expect(Number(container.querySelector("[data-capture-location-map-view]")!.getAttribute("data-map-zoom"))).toBe(z + 1);
    expect((container.querySelector("img[data-map-tile]") as HTMLImageElement).getAttribute("src")).toMatch(new RegExp(`/${z + 1}/`));
  });

  it("with no recorded accuracy: no radius is drawn, and it says accuracy was not recorded", () => {
    const { container } = render(<CaptureLocationMapPanel lat={LAT} lng={LNG} accuracyMeters={null} tileTemplate={APPROVED} />);
    expect(container.querySelector("[data-map-accuracy-radius]")).toBeNull();
    expect(container.textContent).toContain("Accuracy not recorded");
  });

  it("a failed tile switches to the Recorded location card — never a pseudo-map, never 'blocked'", () => {
    const { container } = render(<CaptureLocationMapPanel lat={LAT} lng={LNG} accuracyMeters={12} tileTemplate={APPROVED} />);
    fireEvent.error(container.querySelector("img[data-map-tile]")!);
    expect(container.querySelector("[data-capture-location-map]")?.getAttribute("data-capture-location-map")).toBe("fallback");
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.textContent).toContain("Map preview unavailable");
    expect(container.textContent).not.toMatch(/blocked/i);
    expect(container.querySelector("[data-map-action='open-in-map']")).toBeTruthy();
  });
});

describe("CaptureLocationMapPanel — facts it never invents", () => {
  it("out-of-range coordinates fail closed: no map, no outbound link", () => {
    const { container } = render(<CaptureLocationMapPanel lat={123} lng={400} accuracyMeters={5} tileTemplate={APPROVED} />);
    expect(container.querySelector("[data-capture-location-map]")?.getAttribute("data-capture-location-map")).toBe("invalid");
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });

  it("a source the record does not hold is stated as not recorded (never 'location not recorded'), and nothing reads as verified", () => {
    const { container } = render(<CaptureLocationMapPanel lat={LAT} lng={LNG} accuracyMeters={12} sourceLabel={null} />);
    expect(container.querySelector("[data-capture-location-source-label]")?.textContent).toBe("Location source not recorded");
    expect(container.textContent).not.toMatch(/Location not recorded/);
    expect(container.textContent).not.toMatch(/\bverified\b/i);
  });
});
