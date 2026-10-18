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

describe("CaptureLocationMapPanel — default (public tiles, explicit consent)", () => {
  it("BEFORE consent: the Recorded location card and a Load interactive map control — no tile request, no pseudo-map", () => {
    const { container } = render(<CaptureLocationMapPanel lat={LAT} lng={LNG} accuracyMeters={12} sourceLabel="Reported by the submitting browser" />);
    expect(container.querySelector("[data-capture-location-map]")?.getAttribute("data-capture-location-map")).toBe("consent");
    // No image of any kind before the viewer chooses — no tile, no synthetic map.
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.innerHTML).not.toMatch(/tile\.openstreetmap|data:image\/svg/);
    expect(container.textContent).not.toMatch(/Map imagery unavailable|Map preview unavailable|Blocked/i);
    const load = container.querySelector("[data-map-action='load-interactive-map']") as HTMLButtonElement;
    expect(load.tagName).toBe("BUTTON");
    expect(load.textContent).toBe("Load interactive map");
    expect(container.querySelector(`#${load.getAttribute("aria-describedby")}`)?.textContent).toBe(
      "Loading the map sends the approximate viewed location and your IP address to OpenStreetMap.",
    );
    expect(container.textContent).toContain("Recorded location");
    expect(container.querySelector("[data-capture-location-coordinates]")?.textContent).toContain("51.500729");
    expect(container.textContent).toContain("Accuracy");
    expect(container.querySelector("[data-capture-location-source-label]")?.textContent).toBe("Reported by the submitting browser");
    expect(container.querySelector("[data-map-action='copy-coordinates']")?.tagName).toBe("BUTTON");
    expect(container.querySelector("[data-map-action='open-in-map']")?.getAttribute("href")).toMatch(/^https:\/\/www\.openstreetmap\.org\//);
    // The evidence boundary, briefly.
    expect(container.querySelector("[data-capture-location-boundary]")?.textContent).toMatch(/does not independently prove where the subject matter was/);
  });

  it("AFTER the explicit click: the real OpenStreetMap map — tiles at the recorded position, marker, accuracy radius, attribution", () => {
    const { container } = render(<CaptureLocationMapPanel lat={LAT} lng={LNG} accuracyMeters={25} />);
    expect(container.querySelectorAll("img")).toHaveLength(0);
    fireEvent.click(container.querySelector("[data-map-action='load-interactive-map']")!);
    expect(container.querySelector("[data-capture-location-map]")?.getAttribute("data-capture-location-map")).toBe("tiles");
    const tiles = Array.from(container.querySelectorAll("img[data-map-tile]")) as HTMLImageElement[];
    expect(tiles.length).toBeGreaterThan(0);
    for (const t of tiles) expect(t.getAttribute("src")).toMatch(/^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/);
    // The tile requests carry the site ORIGIN only (OpenStreetMap requires a
    // Referer) — never the page path, so no evidence id or token.
    for (const t of tiles) expect(t.getAttribute("referrerpolicy")).toBe("strict-origin");
    expect(container.querySelector("[data-map-marker]")).toBeTruthy();
    expect(container.querySelector("[data-map-accuracy-radius]")?.getAttribute("data-map-accuracy-radius")).toBe("25");
    expect(container.querySelector("[data-map-attribution]")?.textContent).toMatch(/OpenStreetMap contributors/);
  });

  it("consent is scoped to the view: a newly mounted panel asks again", () => {
    const first = render(<CaptureLocationMapPanel lat={LAT} lng={LNG} accuracyMeters={12} />);
    fireEvent.click(first.container.querySelector("[data-map-action='load-interactive-map']")!);
    expect(first.container.querySelectorAll("img[data-map-tile]").length).toBeGreaterThan(0);
    first.unmount();
    const second = render(<CaptureLocationMapPanel lat={LAT} lng={LNG} accuracyMeters={12} />);
    expect(second.container.querySelectorAll("img")).toHaveLength(0);
    expect(second.container.querySelector("[data-map-action='load-interactive-map']")).toBeTruthy();
  });

  it("a public provider passed explicitly is still consent-gated", () => {
    const { container } = render(
      <CaptureLocationMapPanel lat={LAT} lng={LNG} accuracyMeters={12} tileTemplate="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />,
    );
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.querySelector("[data-capture-location-map]")?.getAttribute("data-capture-location-map")).toBe("consent");
  });

  it("no imagery at all (null): the card says the map preview is unavailable, facts kept", () => {
    const { container } = render(<CaptureLocationMapPanel lat={LAT} lng={LNG} accuracyMeters={12} tileTemplate={null} />);
    expect(container.querySelector("[data-capture-location-map]")?.getAttribute("data-capture-location-map")).toBe("fallback");
    expect(container.textContent).toContain("Map preview unavailable");
    expect(container.querySelector("[data-capture-location-coordinates]")?.textContent).toContain("51.500729");
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
