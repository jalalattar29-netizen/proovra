/**
 * ET-SEC-24 — capture drafts are expired by ONE reaper.
 *
 * Two reapers expired the same drafts: the worker's capture-reaper (on by
 * default) and an in-process API sweep (CAPTURE_DRAFT_SWEEP_INPROCESS, or the
 * sweep-capture-drafts CLI). The API sweep flipped rows with one updateMany
 * and then wrote an EXPIRED event for every row it had SELECTED — including
 * rows the worker had already expired between its select and its update — so
 * running both produced two events for one row. The API sweep is retired; the
 * worker reaper is the one authority.
 *
 * The safety contract the retired suite held for the API sweep now holds for
 * the canonical reaper.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_SRC = resolve(__dirname, "..", "src");
const REAPER_SRC = readFileSync(resolve(__dirname, "..", "..", "worker", "src", "capture-reaper.ts"), "utf8");
const SERVER_SRC = readFileSync(resolve(API_SRC, "server.ts"), "utf8");

describe("capture drafts have one reaper (ET-SEC-24)", () => {
  it("the in-process API sweep and its CLI are gone", () => {
    expect(existsSync(resolve(API_SRC, "jobs", "capture-draft-expiry.job.ts"))).toBe(false);
    expect(existsSync(resolve(__dirname, "..", "scripts", "sweep-capture-drafts.ts"))).toBe(false);
    expect(SERVER_SRC).not.toMatch(/CAPTURE_DRAFT_SWEEP_INPROCESS/);
    expect(SERVER_SRC).not.toMatch(/runCaptureDraftExpirySweepSafe/);
  });

  it("the worker reaper expires DRAFT rows past their expiry only", () => {
    expect(REAPER_SRC).toMatch(/status: prismaPkg\.CaptureSessionStatus\.DRAFT,\s*expiresAtUtc: \{ not: null, lt: now \}/);
    expect(REAPER_SRC).not.toMatch(/CaptureSessionStatus\.(FINALIZED|DISCARDED),\s*expiresAtUtc/);
  });

  it("each row is claimed conditionally and gets its EXPIRED event only when this run transitioned it", () => {
    const claim = REAPER_SRC.indexOf("const claimed = await tx.captureSession.updateMany(");
    const guard = REAPER_SRC.indexOf("if (claimed.count !== 1) {", claim);
    const event = REAPER_SRC.indexOf("await tx.captureSessionEvent.create(", guard);
    expect(claim).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(claim);
    expect(event).toBeGreaterThan(guard);
    expect(REAPER_SRC.slice(event, event + 400)).toMatch(/CaptureSessionEventType\.EXPIRED/);
  });
});
