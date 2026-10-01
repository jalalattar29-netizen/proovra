/**
 * UC-ARCH-004 — the API-key resumable-upload channel (/v1/integrations/api/
 * uploads/*) is RETIRED. Behavioural: the real route plugin is mounted on a
 * real Fastify instance and every one of its nine paths answers 410 with the
 * stable retirement code — never 404 (which is what every create returned
 * before, because the channel passed the API credential id as the record
 * OWNER), and never a session.
 *
 * Replaces the Phase 30.6 source-regex contract, which asserted the shape of
 * handlers that could not open a single session.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import {
  RETIRED_INTEGRATION_UPLOAD_ROUTES,
  integrationsUploadsRoutes,
} from "../src/routes/integrations-uploads.routes.js";

describe("UC-ARCH-004 — API-key upload routes are retired (410)", () => {
  it("all nine former routes answer 410 INTEGRATION_UPLOADS_RETIRED", async () => {
    const app = Fastify();
    await app.register(integrationsUploadsRoutes);
    await app.ready();
    expect(RETIRED_INTEGRATION_UPLOAD_ROUTES).toHaveLength(9);
    const sid = "00000000-0000-4000-8000-000000000001";
    for (const r of RETIRED_INTEGRATION_UPLOAD_ROUTES) {
      const url = r.url.replace(":sessionId", sid).replace(":partIndex", "0");
      const res = await app.inject({
        method: r.method,
        url,
        headers: { authorization: "Bearer pk_live_whatever", "content-type": "application/json" },
        ...(r.method === "POST" ? { payload: JSON.stringify({ evidenceId: sid, idempotencyKey: "k", expectedPartCount: 1 }) } : {}),
      });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(410);
      expect(res.json().error.code).toBe("INTEGRATION_UPLOADS_RETIRED");
      expect(res.body).not.toMatch(/session/i);
    }
    await app.close();
  });

  it("the retired plugin is still mounted, so callers learn the channel is gone (not a 404)", () => {
    const server = readFileSync(fileURLToPath(new URL("../src/server.ts", import.meta.url)), "utf8");
    expect(server).toMatch(/app\.register\(\s*integrationsUploadsRoutes\s*\)/);
  });
});
