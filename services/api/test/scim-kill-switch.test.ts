/**
 * IDENT-015 — SCIM_ENABLED=false stops the /v2/scim protocol surface, and the
 * switch is on when unset. Registered on a bare Fastify instance: the refusal
 * happens before any token lookup, so no database is reached.
 */
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { scimRoutes } from "../src/routes/scim.routes.js";

const saved = process.env.SCIM_ENABLED;
afterEach(() => {
  if (saved === undefined) delete process.env.SCIM_ENABLED;
  else process.env.SCIM_ENABLED = saved;
});

async function appWith(value: string | undefined) {
  if (value === undefined) delete process.env.SCIM_ENABLED;
  else process.env.SCIM_ENABLED = value;
  const app = Fastify();
  await app.register(scimRoutes);
  await app.ready();
  return app;
}

describe("SCIM_ENABLED", () => {
  it("false refuses every protocol request with a SCIM 503", async () => {
    const app = await appWith("false");
    try {
      for (const [method, url] of [
        ["GET", "/v2/scim/Users"],
        ["POST", "/v2/scim/Users"],
        ["DELETE", "/v2/scim/Users/00000000-0000-0000-0000-000000000000"],
        ["PATCH", "/v2/scim/Groups/00000000-0000-0000-0000-000000000000"],
      ] as const) {
        const res = await app.inject({ method, url, headers: { authorization: "Bearer scim_pat_x" } });
        expect(res.statusCode, `${method} ${url}`).toBe(503);
        expect(String(res.headers["content-type"])).toContain("application/scim+json");
        expect(res.body).toContain("scim_disabled");
      }
    } finally {
      await app.close();
    }
  });

  it("unset, the surface is live (a bad token is a 401, not a 503)", async () => {
    const app = await appWith(undefined);
    try {
      const res = await app.inject({ method: "GET", url: "/v2/scim/Users" });
      expect(res.statusCode).not.toBe(503);
    } finally {
      await app.close();
    }
  });
});
