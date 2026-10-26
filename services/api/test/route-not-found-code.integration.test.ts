/**
 * THIRD RE-AUDIT N-7 — an unknown ROUTE answers 404 `ROUTE_NOT_FOUND`; a
 * missing or concealed RECORD keeps the business `NOT_FOUND`.
 *
 * The clients report `ROUTE_NOT_FOUND` to Sentry (a removed or mistyped route
 * is a contract fault) and treat `NOT_FOUND` as an expected answer
 * (anti-enumeration concealment included), so the two must never share a
 * code. Driven through the REAL server (`buildServer` via the integration
 * harness) with `app.inject`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("N-7 — the canonical not-found handler answers ROUTE_NOT_FOUND (live server)", () => {
  let h: IntegrationHarness;
  const A = () => h.fixtures.teamA;
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  it("an unregistered path answers 404 { error: { code: ROUTE_NOT_FOUND, message, requestId } }", async () => {
    for (const [method, url] of [
      ["GET", `/v1/n7-no-such-route-${randomUUID()}`],
      ["POST", "/v1/teamz"],
    ] as const) {
      const res = await h.app.inject({ method, url, headers: bearer(A().ownerToken) });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      const body = res.json() as { error: { code: string; message: string; requestId: string } };
      expect(body).toEqual({
        error: { code: "ROUTE_NOT_FOUND", message: "Resource not found.", requestId: expect.any(String) },
      });
      // The path is not echoed back.
      expect(res.body).not.toContain(url);
    }
  });

  it("control: a route-level missing / concealed record keeps the business NOT_FOUND", async () => {
    const missingMember = await h.app.inject({
      method: "PATCH",
      url: `/v1/teams/${A().teamId}/members/${randomUUID()}`,
      headers: bearer(A().ownerToken),
      payload: { role: "VIEWER" },
    });
    expect(missingMember.statusCode).toBe(404);
    expect(missingMember.json()).toMatchObject({ code: "NOT_FOUND" });
    expect(missingMember.body).not.toContain("ROUTE_NOT_FOUND");
  });
});
