// Database acquisition: bootOps() -> bootIntegrationHarness() (the ONE canonical helper).
/**
 * OPS-006 — the worker's scheduled HTTP sweeps authenticate with the header
 * the API verifies. Drives the REAL worker sweep functions over HTTP against
 * the real API listening on a loopback port.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INTEGRATION_CRON_HEADER } from "@proovra/shared";

import { bootOps, type Ctx } from "./operations-truth-fixtures.js";

const SECRET = "ops-truth-local-cron-secret-0123456789";

describe("OPS-006 cron header contract (live API over loopback HTTP)", () => {
  let c: Ctx;
  let base: string;
  const saved: Record<string, string | undefined> = {};
  beforeAll(async () => {
    c = await bootOps();
    for (const k of ["INTEGRATION_CRON_SECRET", "INTERNAL_API_BASE_URL"]) saved[k] = process.env[k];
    process.env.INTEGRATION_CRON_SECRET = SECRET;
    const address = await c.h.app.listen({ host: "127.0.0.1", port: 0 });
    base = address.replace("localhost", "127.0.0.1");
    process.env.INTERNAL_API_BASE_URL = base;
  }, 900_000);
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await c?.h.cleanup();
  });

  it("the real worker sweeps succeed against the real routes", async () => {
    const { runOrgInviteDeliverySweep } = await import("../../worker/src/org-invite-delivery.worker.js");
    const { runAutomationDispatchSweepTick } = await import("../../worker/src/automation-dispatch.js");
    const invite = await runOrgInviteDeliverySweep({ trigger: "test" } as never);
    const automation = await runAutomationDispatchSweepTick({} as never);
    expect(invite.ok, JSON.stringify(invite)).toBe(true);
    expect(automation.ok, JSON.stringify(automation)).toBe(true);
    expect(JSON.stringify([invite, automation])).not.toContain(SECRET);
  });

  it("missing, wrong and legacy-named headers are refused; the canonical one is accepted", async () => {
    for (const path of ["/v1/org-invite-deliveries/process", "/v1/automation/runs/process"]) {
      const post = (headers: Record<string, string>) =>
        fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
      expect((await post({})).status).toBe(401);
      expect((await post({ [INTEGRATION_CRON_HEADER]: `${SECRET}-wrong` })).status).toBe(401);
      expect((await post({ "x-cron-secret": SECRET })).status).toBe(401);
      const ok = await post({ [INTEGRATION_CRON_HEADER]: SECRET });
      expect(ok.status).toBe(200);
      expect(await ok.text()).not.toContain(SECRET);
    }
  });
});
