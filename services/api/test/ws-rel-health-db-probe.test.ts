/**
 * WS-REL / PRO-S1-09 — a flood of public GET /health does not cost one pooled
 * connection per call: one probe in flight, its answer reused briefly.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { __resetHealthDbProbeForTests, cachedHealthDbProbe, HEALTH_DB_PROBE_TTL_MS } from "../src/http/health-db-probe.js";

beforeEach(() => __resetHealthDbProbeForTests());

describe("PRO-S1-09 /health database probe", () => {
  it("1000 concurrent calls run one query and all report up", async () => {
    let queries = 0;
    const probe = async () => {
      queries += 1;
      await new Promise((r) => setTimeout(r, 5));
    };
    const results = await Promise.all(Array.from({ length: 1000 }, () => cachedHealthDbProbe(probe)));
    expect(queries).toBe(1);
    expect(results.every(Boolean)).toBe(true);
  });

  it("the answer expires: a later call probes again and reports a down database", async () => {
    let t = 1_000;
    const now = () => t;
    expect(await cachedHealthDbProbe(async () => undefined, now)).toBe(true);
    t += HEALTH_DB_PROBE_TTL_MS + 1;
    expect(
      await cachedHealthDbProbe(async () => {
        throw new Error("down");
      }, now),
    ).toBe(false);
  });
});
