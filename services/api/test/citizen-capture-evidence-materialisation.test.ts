/**
 * Citizen capture → Evidence materialisation contract (UC-0 retirement).
 *
 * This file used to lock a repair inside `acceptCitizenCapture`: the citizen
 * PWA posted base64 bytes in a JSON body, and the service created an Evidence
 * row and labelled it "Class B". UC-0 retired that path instead of keeping it:
 * the bytes travelled outside the canonical upload/part pipeline, and the
 * "Class B" label was a provenance claim the server could not support. The
 * service was deleted; the canonical `/intake/{token}` flow replaces it.
 *
 * The property this file now EXECUTES is what the retired path does: it
 * materialises NOTHING. Both routes answer 410 with a bounded pointer to the
 * replacement, still behind the public-write rate limiter, and never reach
 * evidence creation, completion or storage.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enforceRateLimitMock = vi.fn(async () => ({ allowed: true }));
vi.mock("../src/services/rate-limit.js", () => ({
  enforceRateLimit: enforceRateLimitMock,
}));

const createEvidenceMock = vi.fn();
const completeEvidenceMock = vi.fn();
const putObjectMock = vi.fn();
vi.mock("../src/services/evidence.service.js", () => ({
  createEvidence: createEvidenceMock,
}));
vi.mock("../src/services/evidence-complete.service.js", () => ({
  completeEvidence: completeEvidenceMock,
}));
vi.mock("../src/storage.js", () => ({
  putObjectBuffer: putObjectMock,
}));

const { citizenCaptureRoutes } = await import("../src/routes/citizen-capture.routes.js");

async function buildApp() {
  const app = Fastify();
  await app.register(citizenCaptureRoutes);
  await app.ready();
  return app;
}

const RETIRED = {
  denial: "CITIZEN_CAPTURE_RETIRED",
  replacement: "/intake/{token}",
};

describe("citizen capture — retired, materialises nothing", () => {
  beforeEach(() => {
    enforceRateLimitMock.mockReset();
    enforceRateLimitMock.mockResolvedValue({ allowed: true });
    createEvidenceMock.mockReset();
    completeEvidenceMock.mockReset();
    putObjectMock.mockReset();
  });

  it("opening a session answers 410 with the replacement and creates no record", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/intake/citizen/sessions",
      payload: { intakeTokenId: "tok_123", deviceId: "d", publicKeyHex: "00" },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toEqual(RETIRED);
    expect(createEvidenceMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("posting base64 bytes answers 410 and never stores or seals them", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/intake/citizen/sessions/sess_1/capture",
      payload: { assetBase64: Buffer.from("bytes").toString("base64") },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toEqual(RETIRED);
    expect(createEvidenceMock).not.toHaveBeenCalled();
    expect(completeEvidenceMock).not.toHaveBeenCalled();
    expect(putObjectMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("the retired routes stay rate limited — a limited caller gets 429, not 410", async () => {
    enforceRateLimitMock.mockResolvedValueOnce({ allowed: false });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/intake/citizen/sessions",
      payload: { intakeTokenId: "tok_123" },
    });
    expect(res.statusCode).toBe(429);
    expect(enforceRateLimitMock).toHaveBeenCalledTimes(1);
    const firstCall = enforceRateLimitMock.mock.calls[0] as unknown as [{ key: string }];
    expect(firstCall[0].key.startsWith("citizen-intake:ip:")).toBe(true);
    await app.close();
  });

  it("the response never echoes submitted content", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/intake/citizen/sessions/sess_1/capture",
      payload: { assetBase64: "c2VjcmV0LWJ5dGVz", note: "secret-bytes" },
    });
    expect(res.body).not.toContain("c2VjcmV0LWJ5dGVz");
    expect(res.body).not.toContain("secret-bytes");
    await app.close();
  });
});
