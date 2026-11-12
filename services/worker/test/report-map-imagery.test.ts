/**
 * THE PDF REPORT'S STREET MAP (2026-11-12) — owner decision revising AUD-025 /
 * AUD-19 for this feature only.
 *
 * A newly generated report whose record holds a saved, AUTHORIZED location
 * fetches XYZ tiles from the ONE configured map source and embeds the
 * composed PNG. Proven here, with every request recorded by a stub tile
 * server:
 *   - no configuration → no request (the default stays local-only);
 *   - requests go only to the configured host, carry only {z}/{x}/{y} and a
 *     fixed User-Agent — no record id, email, cookie, Referer or coordinate;
 *   - a no-location or withheld-location report makes no request;
 *   - a failing, erroring or hanging source leaves the cards and the honest
 *     "Map preview unavailable" note, and the report still builds;
 *   - tiles are cached in-process (a second report asks nothing);
 *   - logs carry no coordinate and no tile URL;
 *   - the image is centred on the recorded position with a geographic
 *     accuracy circle (the viewport math is proven in packages/shared).
 */
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  REPORT_MAP_HEIGHT_PX,
  REPORT_MAP_USER_AGENT,
  REPORT_MAP_WIDTH_PX,
  renderCaptureLocationReportMap,
  resetReportMapTileCacheForTest,
} from "../src/report-map-imagery.js";
import { buildReportViewModel } from "../src/report-v2/build-view-model.js";
import { renderReportHtml } from "../src/report-v2/render-html.js";
import { regressionRecordInput } from "./fixtures/report-layout-variants.js";

const CONFIGURED = {
  CAPTURE_LOCATION_MAP_MODE: "static",
  CAPTURE_LOCATION_TILE_URL: "https://tiles.example-provider.test/osm/{z}/{x}/{y}.png",
  CAPTURE_LOCATION_TILE_SOURCE: "external",
  CAPTURE_LOCATION_TILE_ATTRIBUTION: "© Example Tiles · © OpenStreetMap contributors",
};
const MAP_KEYS = [...Object.keys(CONFIGURED)];

type Seen = { url: string; headers: Record<string, string>; redirect: unknown };
const seen: Seen[] = [];
const logged: string[] = [];
let tilePng: Buffer;
let mode: "ok" | "http500" | "reject" | "hang" | "html" = "ok";
const savedEnv = { ...process.env };

beforeAll(async () => {
  // A plain 256-px tile (#e8e4dc) standing in for the provider's imagery.
  tilePng = await sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 232, g: 228, b: 220 } } })
    .png()
    .toBuffer();
});

beforeEach(() => {
  seen.length = 0;
  logged.length = 0;
  mode = "ok";
  resetReportMapTileCacheForTest();
  for (const k of MAP_KEYS) delete process.env[k];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      seen.push({ url: String(url), headers, redirect: init?.redirect });
      if (mode === "reject") throw new TypeError("fetch failed");
      if (mode === "hang") {
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      if (mode === "http500") return new Response("down", { status: 500 });
      if (mode === "html") return new Response("<html>login</html>".repeat(10), { status: 200, headers: { "content-type": "text/html" } });
      return new Response(new Uint8Array(tilePng), { status: 200, headers: { "content-type": "image/png", "cache-control": "max-age=604800" } });
    }),
  );
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

const leaks = (line: string) => /52\.52|13\.40|example-provider|\/\d+\/\d+\/\d+\.png/.test(line);

describe("report map: configuration decides whether any request is made", () => {
  it("unconfigured (the default): no request, and the report states the outage note beside the cards", async () => {
    const vm = await buildReportViewModel(regressionRecordInput("recorded"));
    const html = renderReportHtml(vm);
    expect(seen).toEqual([]);
    expect(vm.meta.captureContext?.map).toBeNull();
    expect(html).toContain('data-capture-map="unavailable"');
    expect(html).toMatch(/data-capture-field="Latitude">52\.521</);
  });

  it("a public provider not declared external, plain http, or an external source without attribution is refused — no request", async () => {
    const cases: Array<Record<string, string>> = [
      { ...CONFIGURED, CAPTURE_LOCATION_TILE_URL: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", CAPTURE_LOCATION_TILE_SOURCE: "proovra" },
      { ...CONFIGURED, CAPTURE_LOCATION_TILE_URL: "http://tiles.example-provider.test/{z}/{x}/{y}.png" },
      { ...CONFIGURED, CAPTURE_LOCATION_TILE_ATTRIBUTION: "" },
      { ...CONFIGURED, CAPTURE_LOCATION_TILE_SOURCE: "" },
      { ...CONFIGURED, CAPTURE_LOCATION_MAP_MODE: "off" },
    ];
    for (const env of cases) {
      const r = await renderCaptureLocationReportMap({ lat: "52.521", lng: "13.405", accuracyMeters: "118" }, env);
      expect(r.status).toBe("unavailable");
    }
    expect(seen).toEqual([]);
  });
});

describe("report map: what a request sends", () => {
  it("only the configured host, only z/x/y in the path, a fixed User-Agent — nothing about the record", async () => {
    Object.assign(process.env, CONFIGURED);
    const input = regressionRecordInput("recorded");
    const vm = await buildReportViewModel(input);
    expect(vm.meta.captureContext?.map?.attribution).toBe(CONFIGURED.CAPTURE_LOCATION_TILE_ATTRIBUTION);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThanOrEqual(24);
    const forbidden = [input.evidence.id, "submitter@example.test", "user-1", "52.521", "13.405"].filter(Boolean) as string[];
    for (const req of seen) {
      const url = new URL(req.url);
      expect(url.protocol).toBe("https:");
      expect(url.host).toBe("tiles.example-provider.test");
      expect(url.pathname).toMatch(/^\/osm\/\d{1,2}\/\d+\/\d+\.png$/);
      expect(url.search).toBe("");
      expect(Object.keys(req.headers).sort()).toEqual(["accept", "user-agent"]);
      expect(req.headers["user-agent"]).toBe(REPORT_MAP_USER_AGENT);
      expect(req.redirect).toBe("error");
      for (const f of forbidden) expect(JSON.stringify(req)).not.toContain(f);
    }
    expect(logged.filter(leaks)).toEqual([]);
  });

  it("a commercial source (Geoapify-shaped): its API key goes to it in the query only, and never into a log", async () => {
    const KEY = "geo-secret-key-7f3a";
    const GEOAPIFY = {
      CAPTURE_LOCATION_MAP_MODE: "static",
      CAPTURE_LOCATION_TILE_URL: `https://maps.geoapify.com/v1/tile/osm-bright/{z}/{x}/{y}.png?apiKey=${KEY}`,
      CAPTURE_LOCATION_TILE_SOURCE: "external",
      CAPTURE_LOCATION_TILE_ATTRIBUTION: "Powered by Geoapify · © OpenMapTiles · © OpenStreetMap contributors",
    };
    const r = await renderCaptureLocationReportMap({ lat: "52.521", lng: "13.405", accuracyMeters: "118" }, GEOAPIFY);
    expect(r.status).toBe("rendered");
    if (r.status === "rendered") expect(r.attribution).toBe(GEOAPIFY.CAPTURE_LOCATION_TILE_ATTRIBUTION);
    expect(seen.length).toBeGreaterThan(0);
    for (const req of seen) {
      const url = new URL(req.url);
      expect(url.host).toBe("maps.geoapify.com");
      expect(url.pathname).toMatch(/^\/v1\/tile\/osm-bright\/\d{1,2}\/\d+\/\d+\.png$/);
      expect([...url.searchParams.keys()]).toEqual(["apiKey"]);
      expect(url.searchParams.get("apiKey")).toBe(KEY);
      expect(Object.keys(req.headers).sort()).toEqual(["accept", "user-agent"]);
    }
    // A runtime error that quotes the request URL is logged as a bare code.
    resetReportMapTileCacheForTest();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        throw new TypeError(`fetch failed for ${String(url)}`);
      }),
    );
    const failed = await renderCaptureLocationReportMap({ lat: "52.521", lng: "13.405", accuracyMeters: "118" }, GEOAPIFY);
    expect(failed).toEqual({ status: "unavailable", reason: "FETCH_FAILED" });
    expect(logged.some((l) => l.includes("TypeError"))).toBe(true);
    expect(logged.filter((l) => l.includes(KEY) || l.includes("geoapify") || leaks(l))).toEqual([]);
  });

  it("a report with no location, or a withheld one, makes no request", async () => {
    Object.assign(process.env, CONFIGURED);
    await buildReportViewModel(regressionRecordInput("absent"));
    await buildReportViewModel({ ...regressionRecordInput("recorded"), recordedLocationDisclosed: false });
    await buildReportViewModel(regressionRecordInput("incomplete"));
    expect(seen).toEqual([]);
  });

  it("tiles are cached: a second report for the same place asks nothing", async () => {
    Object.assign(process.env, CONFIGURED);
    await buildReportViewModel(regressionRecordInput("recorded"));
    const first = seen.length;
    expect(first).toBeGreaterThan(0);
    await buildReportViewModel(regressionRecordInput("recorded"));
    expect(seen.length).toBe(first);
  });
});

describe("report map: the composed image", () => {
  it("is the frame's exact size, with the marker at the centre and the accuracy circle drawn geographically", async () => {
    const r = await renderCaptureLocationReportMap({ lat: "52.521", lng: "13.405", accuracyMeters: "118" }, CONFIGURED);
    expect(r.status).toBe("rendered");
    if (r.status !== "rendered") return;
    const png = Buffer.from(r.dataUrl.split(",")[1]!, "base64");
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([REPORT_MAP_WIDTH_PX, REPORT_MAP_HEIGHT_PX]);
    const px = (x: number, y: number) => {
      const i = (Math.round(y) * info.width + Math.round(x)) * info.channels;
      return [data[i]!, data[i + 1]!, data[i + 2]!];
    };
    // The marker (#0f3e38) sits exactly at the centre.
    expect(px(info.width / 2, info.height / 2)).toEqual([15, 62, 56]);
    // z16 at 52.521°: 118 m ≈ 81 px. The circle's stroke is dark at that
    // radius; just inside it is the translucent fill, and well outside it is
    // the plain tile colour.
    const mpp = (Math.cos((52.521 * Math.PI) / 180) * 2 * Math.PI * 6_378_137) / (256 * 2 ** 16);
    const rPx = 118 / mpp;
    expect(r.zoom).toBe(16);
    const [sr, sg, sb] = px(info.width / 2 + rPx, info.height / 2);
    expect(sr + sg + sb).toBeLessThan(400);
    expect(px(info.width / 2 + rPx + 12, info.height / 2)).toEqual([232, 228, 220]);
  });
});

describe("report map: a failing source is an outage, never a failed report", () => {
  for (const m of ["reject", "http500", "html", "hang"] as const) {
    it(`${m}: the cards and the outage note remain, the report builds`, async () => {
      Object.assign(process.env, CONFIGURED);
      mode = m;
      const started = Date.now();
      const vm = await buildReportViewModel(regressionRecordInput("recorded"));
      expect(Date.now() - started).toBeLessThan(15_000);
      const html = renderReportHtml(vm);
      expect(vm.meta.captureContext?.map).toBeNull();
      expect(html).toContain('data-capture-map="unavailable"');
      expect(html).toContain("Map preview unavailable");
      expect(html).toMatch(/data-capture-field="Longitude">13\.405</);
      expect(logged.filter(leaks)).toEqual([]);
    }, 20_000);
  }
});
