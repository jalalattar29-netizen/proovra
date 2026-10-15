/**
 * AUD-019 — the reviewer console states the local OCR engine as the WORKER
 * reported it (live PostgreSQL 16).
 *
 * The route used to answer a constant — Tesseract `not_enabled`, "Local OCR
 * … is not enabled" — while the worker image ships and runs Tesseract for
 * derived screen review. It now reads the newest worker heartbeat carrying a
 * `localOcr` probe report: AVAILABLE with the languages that actually run,
 * ENGINE_UNAVAILABLE / LANGUAGE_UNAVAILABLE as reported, and with no fresh
 * report "not reported" — never a guess in either direction.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const WORKER_PREFIX = "aud019-ocr-";

describe("AUD-019 reviewer console — local OCR is the worker's reported probe (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 180_000);
  afterAll(async () => {
    await prisma?.workerTelemetrySnapshot.deleteMany({ where: { workerId: { startsWith: WORKER_PREFIX } } });
    await h?.cleanup();
  });
  beforeEach(async () => {
    // Only reports this file writes; a real worker heartbeat never runs here.
    await prisma.workerTelemetrySnapshot.deleteMany({ where: { workerId: { startsWith: WORKER_PREFIX } } });
  });

  async function heartbeat(localOcr: Record<string, unknown> | null, at = new Date()) {
    await prisma.workerTelemetrySnapshot.create({
      data: {
        workerId: `${WORKER_PREFIX}${Math.random().toString(36).slice(2, 10)}`,
        workerKind: "WORKER",
        status: "HEALTHY",
        heartbeatAtUtc: at,
        metadataJson: { buildRevision: "test", ...(localOcr ? { localOcr } : {}) } as never,
      },
    });
  }

  async function capability() {
    const A = h.fixtures.teamA;
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/investigation/reviewers?teamId=${A.teamId}`,
      headers: { authorization: `Bearer ${A.ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { localExtractorCapability: { tesseract: unknown; whisper: unknown; summary: string } }).localExtractorCapability;
  }

  const report = (over: Record<string, unknown> = {}) => ({
    engine: "tesseract",
    available: true,
    version: "5.5.1",
    installedLanguages: ["ara", "deu", "eng"],
    requested: "deu+eng+ara",
    effective: "deu+eng+ara",
    missing: [],
    observedAtUtc: new Date().toISOString(),
    ...over,
  });

  it("with no worker report the engine is 'not reported' — not the old 'not enabled' constant", async () => {
    await heartbeat(null);
    const cap = await capability();
    expect(cap.tesseract).toEqual({ ok: false, reason: "not_reported" });
    expect(cap.summary).toMatch(/unknown — no worker has reported it/);
    expect(cap.summary).not.toMatch(/not enabled/);
    expect(cap.whisper).toEqual({ ok: false, reason: "not_enabled" });
  });

  it("a fresh report of the engine with eng/ara/deu is shown as available with the languages that run", async () => {
    await heartbeat(report());
    const cap = await capability();
    expect(cap.tesseract).toMatchObject({
      ok: true,
      source: "worker_heartbeat",
      version: "5.5.1",
      languages: "deu+eng+ara",
      missingLanguages: [],
    });
    expect(cap.summary).toMatch(/reported available by the worker with languages deu\+eng\+ara/);
  });

  it("an engine reported without any requested model, and an engine reported missing, are each stated", async () => {
    await heartbeat(report({ installedLanguages: [], effective: null, missing: ["deu", "eng", "ara"] }));
    expect((await capability()).tesseract).toEqual({ ok: false, reason: "language_unavailable" });
    await prisma.workerTelemetrySnapshot.deleteMany({ where: { workerId: { startsWith: WORKER_PREFIX } } });
    await heartbeat(report({ available: false, version: null, installedLanguages: [], effective: null }));
    const cap = await capability();
    expect(cap.tesseract).toEqual({ ok: false, reason: "engine_unavailable" });
    expect(cap.summary).toMatch(/not installed/);
  });

  it("a stale report is not current truth", async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await heartbeat(report({ observedAtUtc: old.toISOString() }), old);
    expect((await capability()).tesseract).toEqual({ ok: false, reason: "not_reported" });
  });
});
