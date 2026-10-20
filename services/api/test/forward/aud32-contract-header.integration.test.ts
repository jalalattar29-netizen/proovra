/**
 * AUD-32 (2026-10-20) — every API response states its presentation contract,
 * and a browser on an allowed origin may read it. Live API, real hooks.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PRESENTATION_CONTRACT_HEADER, PRESENTATION_CONTRACT_VERSION } from "@proovra/shared";

import type { IntegrationHarness } from "../integration-harness.js";

describe("AUD-32 presentation contract header (live API)", () => {
  let h: IntegrationHarness;
  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    h = await bootIntegrationHarness();
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  it("a success and an error both carry it", async () => {
    const ok = await h.app.inject({ method: "GET", url: "/healthz" });
    expect(ok.headers[PRESENTATION_CONTRACT_HEADER]).toBe(String(PRESENTATION_CONTRACT_VERSION));
    const missing = await h.app.inject({ method: "GET", url: "/v1/evidence/00000000-0000-0000-0000-000000000000", headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}` } });
    expect(missing.statusCode).toBeGreaterThanOrEqual(400);
    expect(missing.headers[PRESENTATION_CONTRACT_HEADER]).toBe(String(PRESENTATION_CONTRACT_VERSION));
  });

  it("is exposed to a browser on an allowed origin", async () => {
    const origin = (process.env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).find(Boolean) ?? "http://localhost:3000";
    const res = await h.app.inject({ method: "GET", url: "/healthz", headers: { origin } });
    const exposed = String(res.headers["access-control-expose-headers"] ?? "").toLowerCase();
    if (res.headers["access-control-allow-origin"]) expect(exposed).toContain(PRESENTATION_CONTRACT_HEADER);
    else expect.fail(`origin ${origin} is not allowed in this harness; expose-headers cannot be observed`);
  });
});
