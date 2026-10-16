import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCaptureLocationDisplayModel,
  buildCaptureLocationExternalMapUrl,
  buildCaptureLocationGeoUri,
  buildCaptureLocationStaticMapFallbackSvg,
  formatCaptureLocationAccuracy,
  formatCaptureLocationCoordinate,
  hasCaptureLocationMetadata,
} from "../dist/index.js";

test("formats coordinates with restrained precision", () => {
  assert.equal(formatCaptureLocationCoordinate(52.5200084), "52.520008");
  assert.equal(formatCaptureLocationCoordinate("13.404954"), "13.404954");
  assert.equal(formatCaptureLocationCoordinate(null), "Not recorded");
});

test("formats accuracy cleanly", () => {
  assert.equal(formatCaptureLocationAccuracy(18.2), "± 18 meters");
  assert.equal(formatCaptureLocationAccuracy(4.4), "± 4.4 meters");
  assert.equal(formatCaptureLocationAccuracy(null), "Not recorded");
});

test("detects capture-location presence only when both coordinates exist", () => {
  assert.equal(hasCaptureLocationMetadata({ lat: 1, lng: 2 }), true);
  assert.equal(hasCaptureLocationMetadata({ lat: 1, lng: null }), false);
  assert.equal(hasCaptureLocationMetadata(null), false);
});

test("builds geo and external map links", () => {
  const geoUri = buildCaptureLocationGeoUri({
    lat: 52.52,
    lng: 13.405,
    accuracyMeters: 18,
  });
  const externalUrl = buildCaptureLocationExternalMapUrl({
    lat: 52.52,
    lng: 13.405,
  });

  assert.equal(
    geoUri,
    "geo:52.52,13.405;u=18"
  );
  assert.ok(externalUrl?.startsWith("https://www.openstreetmap.org/"));
  assert.ok(externalUrl?.includes("#map="));
});

test("builds a display model with tiles, marker, and actions", () => {
  const model = buildCaptureLocationDisplayModel({
    lat: 52.52,
    lng: 13.405,
    accuracyMeters: 18,
    width: 1200,
    height: 720,
  });

  assert.ok(model);
  assert.equal(model?.statusLabel, "Location recorded");
  assert.equal(model?.sourceLabel, "Browser/device-reported geolocation");
  assert.equal(model?.tiles.length, 9);
  assert.ok((model?.markerX ?? 0) > 0);
  assert.ok((model?.markerY ?? 0) > 0);
  assert.ok((model?.accuracyRadiusPx ?? 0) > 0);
});

test("fallback svg generation is deterministic and non-empty", () => {
  const svg = buildCaptureLocationStaticMapFallbackSvg({
    lat: 52.52,
    lng: 13.405,
    accuracyMeters: 18,
    width: 1200,
    height: 720,
  });

  assert.ok(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(svg.includes("CAPTURE CONTEXT"));
  assert.ok(svg.includes("PROOVRA"));
});

test("invalid or absent location does not build a display model", () => {
  assert.equal(
    buildCaptureLocationDisplayModel({
      lat: null,
      lng: 13.405,
    }),
    null
  );
});

test("AUD-025: no default tile server — tiles carry no URL and the label says the map is local", () => {
  const model = buildCaptureLocationDisplayModel({ lat: 52.52, lng: 13.405, accuracyMeters: 18 });
  assert.ok(model);
  assert.equal(model.tileTemplate, null);
  assert.ok(model.tiles.every((t) => t.url === null));
  assert.ok(!JSON.stringify(model).includes("tile.openstreetmap"));
  assert.equal(model.attributionLabel, "Map imagery unavailable · rendered locally from recorded coordinates");
  const svg = buildCaptureLocationStaticMapFallbackSvg({ lat: 52.52, lng: 13.405, accuracyMeters: 18 });
  assert.ok(!/(?:href|src)=["']https?:/.test(svg) && !svg.includes("openstreetmap"));
  // A configured endpoint is used, and only then.
  const configured = buildCaptureLocationDisplayModel({ lat: 52.52, lng: 13.405, tileTemplate: "https://tiles.internal.example/{z}/{x}/{y}.png" });
  assert.ok(configured.tiles.some((t) => t.url?.startsWith("https://tiles.internal.example/")));
});
