/**
 * THE ONE MAP POLICY (2026-10-18).
 *
 *   - server (report worker, PDF, package): every public provider refused;
 *   - interactive map, approved PRIVATE endpoint: loads automatically;
 *   - interactive map, otherwise: the public OpenStreetMap tiles the map used
 *     until ebea6a075 — but only after explicit consent, with the notice.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  PUBLIC_INTERACTIVE_TILE_TEMPLATE,
  PUBLIC_MAP_CONSENT_NOTICE,
  resolveApprovedTileTemplate,
  resolveInteractiveMapTileSource,
} from "../dist/index.js";

const OSM = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const PRIVATE = "https://tiles.internal.example/{z}/{x}/{y}.png";

test("server side: a public provider is refused, always (AUD-025, unchanged)", () => {
  assert.deepEqual(resolveApprovedTileTemplate(OSM), { template: null, refused: "PUBLIC_PROVIDER" });
  assert.deepEqual(resolveApprovedTileTemplate(undefined), { template: null, refused: "NOT_CONFIGURED" });
  assert.equal(resolveApprovedTileTemplate(PRIVATE).template, PRIVATE);
});

test("interactive map: nothing configured → public OpenStreetMap, consent required", () => {
  assert.equal(PUBLIC_INTERACTIVE_TILE_TEMPLATE, OSM);
  assert.deepEqual(resolveInteractiveMapTileSource(undefined), { mode: "consent", template: OSM, provider: "OpenStreetMap" });
  assert.deepEqual(resolveInteractiveMapTileSource("not a template"), { mode: "consent", template: OSM, provider: "OpenStreetMap" });
  // A public provider configured as the "private" endpoint is still consent-gated.
  assert.equal(resolveInteractiveMapTileSource("https://a.tile.openstreetmap.org/{z}/{x}/{y}.png").mode, "consent");
  assert.match(PUBLIC_MAP_CONSENT_NOTICE, /approximate viewed location and your IP address to OpenStreetMap/);
});

test("interactive map: an approved PRIVATE endpoint loads automatically", () => {
  assert.deepEqual(resolveInteractiveMapTileSource(PRIVATE), { mode: "automatic", template: PRIVATE });
});
