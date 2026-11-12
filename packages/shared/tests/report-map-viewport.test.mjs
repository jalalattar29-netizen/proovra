/**
 * THE PDF REPORT'S MAP (2026-11-12): the source policy and the viewport math.
 *
 *   - resolveReportMapTileSource: nothing without explicit configuration; a
 *     public provider only when declared "external"; https only; an external
 *     source must name its attribution (OpenStreetMap's own host defaults to
 *     its credit). The web / native policies are untouched (see
 *     interactive-map-policy.test.mjs: the server-side approved-endpoint rule
 *     still refuses every public provider).
 *   - buildCaptureLocationReportViewport: the recorded position is the exact
 *     centre; the accuracy circle is geographic (accuracy ÷ metres-per-pixel,
 *     never clamped); the zoom keeps the full circle inside the frame with
 *     padding at every radius; the tiles cover the frame; the scale bar is
 *     true to scale and at most a quarter of the width.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCaptureLocationReportViewport,
  OPENSTREETMAP_TILE_ATTRIBUTION,
  resolveApprovedTileTemplate,
  resolveReportMapTileSource,
} from "../dist/index.js";

const OSM = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const OWN = "https://tiles.proovra.example/{z}/{x}/{y}.png";

test("report map source: off unless deliberately configured", () => {
  assert.equal(resolveReportMapTileSource({}).refused, "MAP_MODE_OFF");
  assert.equal(resolveReportMapTileSource({ CAPTURE_LOCATION_MAP_MODE: "static" }).refused, "NOT_CONFIGURED");
  assert.equal(
    resolveReportMapTileSource({ CAPTURE_LOCATION_MAP_MODE: "static", CAPTURE_LOCATION_TILE_URL: OWN }).refused,
    "SOURCE_KIND_MISSING",
  );
});

test("report map source: a public provider only when declared external, with its credit", () => {
  const base = { CAPTURE_LOCATION_MAP_MODE: "static", CAPTURE_LOCATION_TILE_URL: OSM };
  assert.equal(resolveReportMapTileSource({ ...base, CAPTURE_LOCATION_TILE_SOURCE: "proovra" }).refused, "PUBLIC_PROVIDER_NOT_DECLARED_EXTERNAL");
  const osm = resolveReportMapTileSource({ ...base, CAPTURE_LOCATION_TILE_SOURCE: "external" });
  assert.deepEqual(osm.source, { template: OSM, host: "tile.openstreetmap.org", kind: "external", attribution: OPENSTREETMAP_TILE_ATTRIBUTION });
  const other = { CAPTURE_LOCATION_MAP_MODE: "static", CAPTURE_LOCATION_TILE_URL: "https://tiles.stadiamaps.com/tiles/osm_bright/{z}/{x}/{y}.png", CAPTURE_LOCATION_TILE_SOURCE: "external" };
  assert.equal(resolveReportMapTileSource(other).refused, "ATTRIBUTION_MISSING");
  assert.equal(resolveReportMapTileSource({ ...other, CAPTURE_LOCATION_TILE_ATTRIBUTION: "© Stadia Maps © OpenMapTiles © OpenStreetMap" }).source?.kind, "external");
  // The production choice (2026-11-12): Geoapify raster tiles, its API key in the query.
  const GEO = "https://maps.geoapify.com/v1/tile/osm-bright/{z}/{x}/{y}.png?apiKey=k-123";
  const geo = { CAPTURE_LOCATION_MAP_MODE: "static", CAPTURE_LOCATION_TILE_URL: GEO };
  assert.equal(resolveReportMapTileSource({ ...geo, CAPTURE_LOCATION_TILE_SOURCE: "proovra" }).refused, "PUBLIC_PROVIDER_NOT_DECLARED_EXTERNAL");
  assert.equal(resolveReportMapTileSource({ ...geo, CAPTURE_LOCATION_TILE_SOURCE: "external" }).refused, "ATTRIBUTION_MISSING");
  assert.deepEqual(
    resolveReportMapTileSource({ ...geo, CAPTURE_LOCATION_TILE_SOURCE: "external", CAPTURE_LOCATION_TILE_ATTRIBUTION: "Powered by Geoapify · © OpenMapTiles · © OpenStreetMap contributors" }).source,
    { template: GEO, host: "maps.geoapify.com", kind: "external", attribution: "Powered by Geoapify · © OpenMapTiles · © OpenStreetMap contributors" },
  );
  // The web / native server-side rule is unchanged: public providers refused.
  assert.equal(resolveApprovedTileTemplate(OSM).refused, "PUBLIC_PROVIDER");
  assert.equal(resolveApprovedTileTemplate(GEO).refused, "PUBLIC_PROVIDER");
});

test("report map source: https only, no credentials in the URL, a real template", () => {
  const env = (url) => ({ CAPTURE_LOCATION_MAP_MODE: "static", CAPTURE_LOCATION_TILE_URL: url, CAPTURE_LOCATION_TILE_SOURCE: "proovra" });
  assert.equal(resolveReportMapTileSource(env("http://tiles.proovra.example/{z}/{x}/{y}.png")).refused, "INVALID_URL");
  assert.equal(resolveReportMapTileSource(env("https://u:p@tiles.proovra.example/{z}/{x}/{y}.png")).refused, "INVALID_URL");
  assert.equal(resolveReportMapTileSource(env("https://tiles.proovra.example/static.png")).refused, "INVALID_URL");
  assert.equal(resolveReportMapTileSource(env(OWN)).source?.kind, "proovra");
});

const mpp = (lat, z) => (Math.cos((lat * Math.PI) / 180) * 2 * Math.PI * 6_378_137) / (256 * 2 ** z);

test("viewport: centred on the recorded position; the circle is geographic and fully inside with padding", () => {
  for (const [lat, lng] of [[52.521, 13.405], [-33.8688, 151.2093], [0.5, -0.1], [64.1, -21.9]]) {
    for (const acc of [5, 30, 118, 400, 1_800, 25_000]) {
      const v = buildCaptureLocationReportViewport({ lat, lng, accuracyMeters: acc, width: 880, height: 332 });
      assert.ok(v);
      assert.equal(v.markerX, 440);
      assert.equal(v.markerY, 166);
      assert.ok(Math.abs(v.accuracyRadiusPx - acc / mpp(lat, v.zoom)) < 1e-9, "radius is accuracy ÷ m/px");
      // Full circle inside the frame with ≥ 16 % of the short side free above and below.
      assert.ok(v.accuracyRadiusPx <= 0.34 * 332 + 1e-9, `${acc} m fits at z${v.zoom}`);
      if (v.zoom < 18) assert.ok(acc / mpp(lat, v.zoom + 1) > 0.34 * 332, "the closest zoom that still fits");
      // The tiles cover the frame.
      const left = Math.min(...v.tiles.map((t) => t.left));
      const top = Math.min(...v.tiles.map((t) => t.top));
      const right = Math.max(...v.tiles.map((t) => t.left + 256));
      const bottom = Math.max(...v.tiles.map((t) => t.top + 256));
      assert.ok(left <= 0 && top <= 0 && right >= 880 && bottom >= 332);
      assert.ok(v.tiles.length <= 24);
      // The scale bar is true to scale and at most a quarter of the width.
      assert.ok(Math.abs(v.scaleBarPx - v.scaleBarMeters / v.metersPerPixel) < 1e-9);
      assert.ok(v.scaleBarPx <= 880 * 0.25 + 1e-9 && v.scaleBarPx >= 880 * 0.05);
    }
  }
});

test("viewport: ~100–130 m frames at street level; no accuracy → no circle; invalid → none", () => {
  assert.equal(buildCaptureLocationReportViewport({ lat: 51.471, lng: 6.942, accuracyMeters: 127, width: 880, height: 332 }).zoom, 16);
  const none = buildCaptureLocationReportViewport({ lat: 51.471, lng: 6.942, accuracyMeters: null, width: 880, height: 332 });
  assert.equal(none.accuracyRadiusPx, null);
  assert.equal(none.zoom, 16);
  assert.equal(buildCaptureLocationReportViewport({ lat: 91, lng: 0, width: 880, height: 332 }), null);
  assert.equal(buildCaptureLocationReportViewport({ lat: "x", lng: 0, width: 880, height: 332 }), null);
});

test("viewport: tile x wraps at the antimeridian", () => {
  const v = buildCaptureLocationReportViewport({ lat: 10, lng: 179.999, accuracyMeters: 100, width: 880, height: 332 });
  const n = 2 ** v.zoom;
  assert.ok(v.tiles.every((t) => t.x >= 0 && t.x < n));
  assert.ok(v.tiles.some((t) => t.x === 0) && v.tiles.some((t) => t.x === n - 1));
});
