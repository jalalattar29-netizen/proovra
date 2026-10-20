/**
 * AUD-025 — EVIDENCE GPS IS NEVER SENT TO A MAP PROVIDER BY DEFAULT.
 *
 * The capture-location map used to default to "static" mode with
 * tile.openstreetmap.org as its template: every report and verification
 * package with GPS evidence fetched tiles whose x/y/z encode the evidence
 * location from a public third party, and logged the tile URLs.
 *
 * Here every outbound path a Node process has — global fetch, http(s).request
 * / get, and raw sockets — is trapped while a report view-model and the
 * package's capture-context PNG are rendered for a record with GPS. Zero
 * outbound requests are allowed, the map still renders (locally), its
 * coordinates still print, and nothing logged carries a coordinate or a tile
 * URL.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  renderCaptureLocationMapPreviewDataUrl,
  renderCaptureLocationMapPreviewPng,
  resolveApprovedTileTemplate,
  resolveCaptureLocationMapMode,
} from "../src/capture-location-map.js";
import { buildReportViewModel } from "../src/report-v2/build-view-model.js";
import { renderReportHtml } from "../src/report-v2/render-html.js";
import { regressionRecordInput } from "./fixtures/report-layout-variants.js";

const outbound: string[] = [];
const logged: string[] = [];
const savedEnv = { ...process.env };

function trap(name: string) {
  return (...args: unknown[]) => {
    outbound.push(`${name}:${String(args[0] && typeof args[0] === "object" ? JSON.stringify(args[0]).slice(0, 120) : args[0])}`);
    throw new Error(`outbound network refused in test (${name})`);
  };
}

beforeEach(() => {
  outbound.length = 0;
  logged.length = 0;
  delete process.env.CAPTURE_LOCATION_MAP_MODE;
  delete process.env.CAPTURE_LOCATION_TILE_URL;
  vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
    outbound.push(`fetch:${String(url)}`);
    throw new Error("outbound network refused in test (fetch)");
  }));
  vi.spyOn(http, "request").mockImplementation(trap("http.request") as never);
  vi.spyOn(http, "get").mockImplementation(trap("http.get") as never);
  vi.spyOn(https, "request").mockImplementation(trap("https.request") as never);
  vi.spyOn(https, "get").mockImplementation(trap("https.get") as never);
  vi.spyOn(net, "connect").mockImplementation(trap("net.connect") as never);
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(trap("socket.connect") as never);
  for (const level of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...savedEnv };
});

const GPS = { lat: 52.521, lng: 13.405, accuracyMeters: 18 };
const leaksLocation = (line: string) => /52\.52|13\.40|openstreetmap|\/\d+\/\d+\/\d+\.png/.test(line);

describe("capture-location map: no third-party request by default", () => {
  it("the package capture-context PNG renders locally with zero outbound requests", async () => {
    const png = await renderCaptureLocationMapPreviewPng({ ...GPS, width: 1200, height: 720 });
    expect(png).toBeInstanceOf(Buffer);
    expect(png!.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(outbound).toEqual([]);
    expect(logged.filter(leaksLocation)).toEqual([]);
  });

  it("the report view-model with GPS renders its map and coordinates with zero outbound requests", async () => {
    const vm = await buildReportViewModel(regressionRecordInput("recorded"));
    const html = renderReportHtml(vm);
    expect(vm.meta.captureLocationState).toBe("recorded");
    expect(html).toMatch(/data-capture-field="Latitude">52\.521</);
    expect(html).not.toContain("tile.openstreetmap");
    // The embedded map is a locally rendered image, not a remote reference.
    const dataUrl = await renderCaptureLocationMapPreviewDataUrl({ lat: "52.521", lng: "13.405", accuracyMeters: "102" });
    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(outbound).toEqual([]);
    expect(logged.filter(leaksLocation)).toEqual([]);
  });

  it("'static' without a configured endpoint, or pointed at a public provider, still renders locally", async () => {
    process.env.CAPTURE_LOCATION_MAP_MODE = "static";
    expect(resolveCaptureLocationMapMode()).toEqual({ mode: "fallback", tileTemplate: null });
    await renderCaptureLocationMapPreviewPng({ ...GPS });
    for (const url of [
      "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      "https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
      "https://api.mapbox.com/styles/v1/x/tiles/{z}/{x}/{y}",
      "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    ]) {
      process.env.CAPTURE_LOCATION_TILE_URL = url;
      expect(resolveApprovedTileTemplate(url).refused).toBe("PUBLIC_PROVIDER");
      expect(resolveCaptureLocationMapMode().mode).toBe("fallback");
      expect(await renderCaptureLocationMapPreviewPng({ ...GPS })).toBeInstanceOf(Buffer);
    }
    expect(outbound).toEqual([]);
    expect(logged.filter(leaksLocation)).toEqual([]);
  });

  it("AUD-19: even an explicitly configured internal endpoint is never asked — an issued artifact renders its map locally", async () => {
    // 2026-10-20: before, a configured endpoint WAS fetched at render time, so
    // an immutable report's map depended on a network answer and the evidence
    // location's tile coordinates left the worker.
    process.env.CAPTURE_LOCATION_MAP_MODE = "static";
    process.env.CAPTURE_LOCATION_TILE_URL = "https://tiles.internal.example/{z}/{x}/{y}.png";
    const png = await renderCaptureLocationMapPreviewPng({ ...GPS });
    expect(png).toBeInstanceOf(Buffer);
    expect(outbound).toEqual([]);
    expect(logged.filter(leaksLocation)).toEqual([]);
    expect(logged.some((l) => l.includes("tiles.internal.example"))).toBe(false);
    // "off" still omits the map.
    process.env.CAPTURE_LOCATION_MAP_MODE = "off";
    expect(await renderCaptureLocationMapPreviewPng({ ...GPS })).toBeNull();
  });
});
