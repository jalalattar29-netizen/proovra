/**
 * GUARD — durable capture-session store (Master Program §11, M5). The pure policy
 * (serialize / staleness / resumability / pendingItems / validatePersisted) is
 * unit-tested so resume never re-uploads a sealed item, an expired session is
 * refused, and malformed persisted state fails safe. Transpile-and-import the TS
 * (strip the AsyncStorage import + its IO wrappers — pure functions only).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/capture/capture-session-store.ts"), "utf8")
  .replace(/^import AsyncStorage.*$/m, "")
  // Drop the three IO wrappers that reference AsyncStorage.
  .replace(/export async function saveCaptureSession[\s\S]*$/m, "");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const NOW = Date.parse("2026-09-19T12:00:00Z");
const future = new Date(NOW + 60 * 60 * 1000).toISOString();
const past = new Date(NOW - 60 * 1000).toISOString();

function baseInput(overrides = {}) {
  return {
    captureSessionId: "cs_1",
    expiresAtUtc: future,
    evidenceId: "ev_1",
    type: "PHOTO",
    now: NOW,
    items: [
      { id: "a", uri: "file:///a.jpg", mimeType: "image/jpeg", partIndex: 0, source: "CAMERA", uploaded: true },
      { id: "b", uri: "file:///b.jpg", mimeType: "image/jpeg", partIndex: 1, source: "CAMERA", uploaded: false },
    ],
    ...overrides,
  };
}

test("serialize preserves per-item upload state and stamps updatedAt", () => {
  const s = mod.serializeSession(baseInput());
  assert.equal(s.items.length, 2);
  assert.equal(s.items[0].uploaded, true);
  assert.equal(s.items[1].uploaded, false);
  assert.equal(s.updatedAtIso, new Date(NOW).toISOString());
});

test("pendingItems returns only not-yet-uploaded items (resume never re-uploads)", () => {
  const s = mod.serializeSession(baseInput());
  const pending = mod.pendingItems(s.items);
  assert.deepEqual(pending.map((i) => i.id), ["b"]);
});

test("a session with an expired server session is stale (cannot complete)", () => {
  const s = mod.serializeSession(baseInput({ expiresAtUtc: past }));
  assert.equal(mod.isSessionStale(s, NOW), true);
  assert.equal(mod.isSessionResumable(s, NOW), false);
});

test("a session untouched past the max age is stale", () => {
  const s = mod.serializeSession(baseInput({ now: NOW - (mod.CAPTURE_SESSION_MAX_AGE_MS + 1000) }));
  assert.equal(mod.isSessionStale(s, NOW), true);
});

test("a fresh non-empty session is resumable; an empty one is not", () => {
  assert.equal(mod.isSessionResumable(mod.serializeSession(baseInput()), NOW), true);
  assert.equal(mod.isSessionResumable(mod.serializeSession(baseInput({ items: [] })), NOW), false);
  assert.equal(mod.isSessionResumable(null, NOW), false);
});

test("validatePersisted accepts a good blob and rejects malformed ones", () => {
  const good = mod.serializeSession(baseInput());
  assert.deepEqual(mod.validatePersisted(good).evidenceId, "ev_1");
  assert.equal(mod.validatePersisted(null), null);
  assert.equal(mod.validatePersisted({ captureSessionId: "x" }), null); // no evidenceId
  assert.equal(mod.validatePersisted({ captureSessionId: "x", evidenceId: "y", type: "BAD", items: [] }), null);
  assert.equal(
    mod.validatePersisted({ captureSessionId: "x", evidenceId: "y", type: "PHOTO", items: [{ id: 1 }] }),
    null,
  ); // item id not a string
});

test("AUDIO session persists canonical audio metadata and remains resumable", () => {
  const audio = mod.serializeSession(
    baseInput({
      type: "AUDIO",
      items: [
        {
          id: "audio-1",
          uri: "file:///recording.m4a",
          mimeType: "audio/mp4",
          durationMs: 12_345,
          sizeBytes: 456_789,
          originalFilename: "recording.m4a",
          partIndex: 0,
          source: "UNKNOWN",
          uploaded: false,
        },
      ],
    }),
  );

  const persisted = mod.validatePersisted(audio);

  assert.notEqual(persisted, null);
  assert.equal(persisted.type, "AUDIO");
  assert.equal(persisted.items.length, 1);
  assert.equal(persisted.items[0].mimeType, "audio/mp4");
  assert.equal(persisted.items[0].durationMs, 12_345);
  assert.equal(persisted.items[0].sizeBytes, 456_789);
  assert.equal(persisted.items[0].originalFilename, "recording.m4a");
  assert.equal(persisted.items[0].source, "UNKNOWN");
  assert.equal(persisted.items[0].uploaded, false);
  assert.equal(mod.isSessionResumable(persisted, NOW), true);
  assert.deepEqual(mod.pendingItems(persisted.items).map((item) => item.id), ["audio-1"]);
});
