/**
 * T-14 — EvidencePartMetadataTable (:140 Dimensions, :141 Duration, :142
 * Pages). The authenticated GET /v1/evidence/:id/technical-metadata carries
 * `technicalMetadata.perParts`; native showed only a record-level resolution.
 * Each file in the Files tab now carries its own part's metadata.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let routes = {};
const item = (id, index, label, mimeType, sha256) => ({ id, index, label, mimeType, kind: "FILE", sha256, downloadable: false, viewUrl: null });
const part = (partIndex, over) => ({ partIndex, filename: null, role: "Primary", mappingLabel: "", mediaKind: null, mimeType: null, sizeBytes: null, sha256: null, width: null, height: null, durationMs: null, codec: null, container: null, pageCount: null, metadataStatusLabel: "Analyzed", ...over });

before(async () => {
  M = await loadModule("app/(stack)/evidence/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  globalThis.__EXPO_PARAMS__ = { id: "ev-1" };
  routes = {
    ...authenticatedRoutes(),
    "/v1/evidence/ev-1/review-workspace": () => ({
      evidence: { contentItems: [item("p0", 0, "photo.jpg", "image/jpeg", "aa"), item("p1", 1, "clip.mp4", "video/mp4", "bb"), item("p2", 2, "brief.pdf", "application/pdf", "cc")] },
      relationships: { items: [] },
    }),
    "/v1/evidence/ev-1/technical-metadata": () => ({
      technicalMetadata: {
        media: { primaryMediaType: "Photo" },
        perParts: [
          part(0, { width: 4032, height: 3024 }),
          part(1, { durationMs: 65_000, codec: "h264", container: "mp4" }),
          // Matched by hash when the index is not the material's.
          part(9, { sha256: "cc", pageCount: 3 }),
        ],
      },
    }),
    "/v1/evidence/ev-1": () => ({ evidence: { id: "ev-1", status: "SIGNED", type: "PHOTO" } }),
  };
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const key = routes[path] ? path : Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    return new Response(JSON.stringify(key ? routes[key]() : {}), { status: key ? 200 : 500, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};

test("each file carries its own dimensions, duration, pages and codec", async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.press("Files");
  await settle();
  assert.ok(r.hasText("Dimensions 4032×3024 · Metadata Analyzed"), r.texts().join(" | "));
  assert.ok(r.hasText("Duration 1m 5s · Codec h264 · Container mp4 · Metadata Analyzed"));
  assert.ok(r.hasText("Pages 3 · Metadata Analyzed"));
});

test("a multi-part EXIF says it is representative; no per-part rows says so (FullExifAccordion :29, EvidencePartMetadataTable :40)", async () => {
  routes["/v1/evidence/ev-1/technical-metadata"] = () => ({
    technicalMetadata: { media: { primaryMediaType: "Photo" }, exif: { exifPresent: true, camera: "Pixel 8" }, perParts: [part(0, {}), part(1, {})] },
  });
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.press("Technical");
  await settle();
  assert.ok(r.texts().some((t) => t.startsWith("Representative EXIF is shown for the primary media item.")));
  assert.equal(r.byTestId("per-parts-empty").length, 0);
  r.unmount();
  routes["/v1/evidence/ev-1/technical-metadata"] = () => ({ technicalMetadata: { media: { primaryMediaType: "Photo" }, perParts: [] } });
  const r2 = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r2.press("Technical");
  await settle();
  assert.ok(r2.hasText("No per-part technical metadata is available for this record."));
});


test("each file's SHA-256 is copyable (EvidencePartMetadataTable.tsx:154)", async () => {
  globalThis.__CLIPBOARD__ = undefined;
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.press("Files");
  await settle();
  await r.press("Copy SHA-256 of brief.pdf");
  await settle();
  assert.equal(globalThis.__CLIPBOARD__, "cc");
});
