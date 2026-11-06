/**
 * IDENT-016 / OPS-011 — a configured geo provider with no client in this build
 * is reported as what it is: the null stub answers, the lookup and its cache
 * row name the stub, and no IP address leaves the process.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  geoProviderStatus,
  lookupCountryCode,
} from "../src/services/access-control/geo-intelligence.service.js";

function fakeClient() {
  const upserts: Array<Record<string, unknown>> = [];
  return {
    upserts,
    client: {
      geoIntelligenceLookup: {
        findUnique: async () => null,
        update: async () => ({}),
        upsert: async (a: { create: Record<string, unknown> }) => {
          upserts.push(a.create);
          return a.create;
        },
      },
    } as never,
  };
}

describe("geo provider honesty", () => {
  const original = process.env.GEO_PROVIDER;
  afterEach(() => {
    if (original === undefined) delete process.env.GEO_PROVIDER;
    else process.env.GEO_PROVIDER = original;
    vi.restoreAllMocks();
  });

  it("GEO_PROVIDER=maxmind is reported as unimplemented, and the stub is what answers", async () => {
    process.env.GEO_PROVIDER = "maxmind";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(geoProviderStatus()).toEqual({
      configured: "MAXMIND",
      effective: "OFFLINE_DB",
      configuredProviderImplemented: false,
      resolvesCountries: false,
    });
    const { client, upserts } = fakeClient();
    const result = await lookupCountryCode({ ip: "203.0.113.7" }, client);
    expect(result).toEqual({ countryCode: null, cached: false, provider: "OFFLINE_DB" });
    expect(upserts[0]?.provider).toBe("OFFLINE_DB");
    expect(JSON.stringify(upserts)).not.toContain("203.0.113.7");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/GEO_PROVIDER=MAXMIND has no client/);
  });

  it("the default provider is implemented and says so (control)", () => {
    delete process.env.GEO_PROVIDER;
    expect(geoProviderStatus()).toMatchObject({
      configured: "OFFLINE_DB",
      effective: "OFFLINE_DB",
      configuredProviderImplemented: true,
    });
  });
});
