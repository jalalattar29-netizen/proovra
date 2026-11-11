/**
 * AUD-0013 — the operational seeding surface is mounted only where the seed
 * itself may run. On production OPERATIONAL_SEEDING_ENABLED alone mounted the
 * routes (GET /v1/ops/seed/reviewer-ops answered 401, not 404) although every
 * write there was refused SEEDING_PROD_GUARDED without
 * OPERATIONAL_SEEDING_ALLOW_PRODUCTION.
 */
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { seedingRefusal } from "../src/services/ops/operational-seed.service.js";

const SERVER = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

describe("AUD-0013 — seeding mount follows the seed's own production rule", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("the server mounts the seed routes only when seedingRefusal() is null", () => {
    const at = SERVER.indexOf("await app.register(opsSeedRoutes);");
    expect(at).toBeGreaterThan(0);
    const guard = SERVER.slice(Math.max(0, at - 200), at);
    expect(guard).toMatch(/if \(process\.env\.OPERATIONAL_SEEDING_ENABLED === "true"\) \{\s*if \(seedingRefusal\(\) === null\) \{\s*$/);
    expect(SERVER.match(/app\.register\(opsSeedRoutes\)/g)).toHaveLength(1);
  });

  it("production with ENABLED alone: refused (not mounted)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPERATIONAL_SEEDING_ENABLED", "true");
    vi.stubEnv("OPERATIONAL_SEEDING_ALLOW_PRODUCTION", "");
    expect(seedingRefusal()).toBe("SEEDING_PROD_GUARDED");
  });

  it("production with the explicit opt-in: allowed", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPERATIONAL_SEEDING_ENABLED", "true");
    vi.stubEnv("OPERATIONAL_SEEDING_ALLOW_PRODUCTION", "true");
    expect(seedingRefusal()).toBeNull();
  });

  it("not enabled: refused anywhere; enabled outside production: allowed", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("OPERATIONAL_SEEDING_ENABLED", "false");
    expect(seedingRefusal()).toBe("SEEDING_DISABLED");
    vi.stubEnv("OPERATIONAL_SEEDING_ENABLED", "true");
    expect(seedingRefusal()).toBeNull();
  });
});
