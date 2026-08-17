/**
 * PHASE 13 §1 (NEW-022) — the proxy-trust POLICY authority, unit-level.
 *
 * The runtime suite (phase13-public-write-bounds.integration.test.ts) proves
 * the end-to-end behaviour through real processes. This file pins the policy
 * layer directly: parsing, the legacy adapter's fail-closed semantics, semantic
 * validation, and the Fastify value mapping — the parts a runtime test cannot
 * exercise cheaply (e.g. "production refuses legacy true").
 */

import { describe, expect, it } from "vitest";

import {
  MAX_TRUSTED_PROXY_HOPS,
  fastifyTrustProxyValue,
  isValidCidr,
  normalizeIp,
  parseProxyTrustPolicy,
  validateProxyTrustPolicy,
} from "@proovra/shared-runtime/technical-metadata";

const parse = (env: Record<string, string | undefined>, isProduction: boolean) =>
  parseProxyTrustPolicy(env, { isProduction });

describe("proxy-trust policy parsing", () => {
  it("unset → off", () => {
    const { policy, errors } = parse({}, false);
    expect(policy.mode).toBe("off");
    expect(errors).toEqual([]);
  });

  it("explicit off → off", () => {
    expect(parse({ API_TRUST_PROXY_MODE: "off" }, true).policy.mode).toBe("off");
  });

  it("hop mode carries the hop count", () => {
    const { policy } = parse(
      { API_TRUST_PROXY_MODE: "hop", API_TRUSTED_PROXY_HOPS: "1" },
      true,
    );
    expect(policy).toMatchObject({ mode: "hop", hops: 1 });
  });

  it("cidr mode carries the parsed CIDR list", () => {
    const { policy } = parse(
      {
        API_TRUST_PROXY_MODE: "cidr",
        API_TRUSTED_PROXY_CIDRS: "10.0.0.0/8, 172.18.0.0/16",
      },
      true,
    );
    expect(policy).toMatchObject({ mode: "cidr", cidrs: ["10.0.0.0/8", "172.18.0.0/16"] });
  });

  it("an unknown mode fails closed to off WITH an error", () => {
    const { policy, errors } = parse({ API_TRUST_PROXY_MODE: "everything" }, true);
    expect(policy.mode).toBe("off");
    expect(errors.join(" ")).toMatch(/invalid/i);
  });

  describe("legacy API_TRUST_PROXY adapter", () => {
    it("legacy false/unset → off", () => {
      expect(parse({ API_TRUST_PROXY: "false" }, true).policy.mode).toBe("off");
    });

    it("legacy true in PRODUCTION is refused (fails closed) with a migration error", () => {
      const { policy, errors } = parse({ API_TRUST_PROXY: "true" }, true);
      expect(policy.mode).toBe("off");
      expect(errors.join(" ")).toMatch(/no longer accepted in production/i);
    });

    it("legacy true OUTSIDE production adapts to hop=1, never trust-everything", () => {
      const { policy } = parse({ API_TRUST_PROXY: "true" }, false);
      expect(policy).toMatchObject({ mode: "hop", hops: 1 });
    });

    it("the explicit mode always wins over the legacy variable", () => {
      const { policy } = parse(
        { API_TRUST_PROXY: "true", API_TRUST_PROXY_MODE: "off" },
        true,
      );
      expect(policy.mode).toBe("off");
    });
  });
});

describe("proxy-trust policy validation", () => {
  it("hop=1 is valid", () => {
    expect(validateProxyTrustPolicy({ mode: "hop", hops: 1, source: "t" })).toEqual([]);
  });

  it("hop=0 / non-integer is rejected", () => {
    expect(validateProxyTrustPolicy({ mode: "hop", hops: 0, source: "t" }).length).toBeGreaterThan(0);
    expect(
      validateProxyTrustPolicy({ mode: "hop", hops: Number.NaN, source: "t" }).length,
    ).toBeGreaterThan(0);
  });

  it("hop above the safe maximum is rejected", () => {
    expect(
      validateProxyTrustPolicy({
        mode: "hop",
        hops: MAX_TRUSTED_PROXY_HOPS + 1,
        source: "t",
      }).length,
    ).toBeGreaterThan(0);
  });

  it("cidr with no networks is rejected", () => {
    expect(
      validateProxyTrustPolicy({ mode: "cidr", cidrs: [], source: "t" }).length,
    ).toBeGreaterThan(0);
  });

  it("cidr with an invalid network is rejected", () => {
    expect(
      validateProxyTrustPolicy({ mode: "cidr", cidrs: ["10.0.0.0/8", "nonsense"], source: "t" })
        .length,
    ).toBeGreaterThan(0);
  });

  it("a valid CIDR set passes", () => {
    expect(
      validateProxyTrustPolicy({
        mode: "cidr",
        cidrs: ["10.0.0.0/8", "::1/128", "fd00::/8"],
        source: "t",
      }),
    ).toEqual([]);
  });
});

describe("fastify trustProxy value mapping", () => {
  it("off → false (headers ignored)", () => {
    expect(fastifyTrustProxyValue({ mode: "off", source: "t" })).toBe(false);
  });
  it("hop → the number", () => {
    expect(fastifyTrustProxyValue({ mode: "hop", hops: 1, source: "t" })).toBe(1);
  });
  it("cidr → the array", () => {
    expect(
      fastifyTrustProxyValue({ mode: "cidr", cidrs: ["10.0.0.0/8"], source: "t" }),
    ).toEqual(["10.0.0.0/8"]);
  });
  it("NEVER returns boolean true for any policy", () => {
    for (const p of [
      { mode: "off" as const, source: "t" },
      { mode: "hop" as const, hops: 3, source: "t" },
      { mode: "cidr" as const, cidrs: ["10.0.0.0/8"], source: "t" },
    ]) {
      expect(fastifyTrustProxyValue(p)).not.toBe(true);
    }
  });
});

describe("normalizeIp", () => {
  it("strips an IPv4-mapped IPv6 prefix", () => {
    expect(normalizeIp("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });
  it("strips brackets and a port from IPv6", () => {
    expect(normalizeIp("[2001:db8::1]:443")).toBe("2001:db8::1");
  });
  it("strips a port from IPv4", () => {
    expect(normalizeIp("203.0.113.9:5678")).toBe("203.0.113.9");
  });
  it("lowercases IPv6", () => {
    expect(normalizeIp("2001:DB8::AB")).toBe("2001:db8::ab");
  });
  it("rejects a value containing control characters", () => {
    expect(normalizeIp("203.0.113.9\r\nSet-Cookie: x")).toBeNull();
  });
  it("rejects nonsense", () => {
    expect(normalizeIp("not-an-ip")).toBeNull();
    expect(normalizeIp("")).toBeNull();
    expect(normalizeIp(null)).toBeNull();
  });
});

describe("isValidCidr", () => {
  it("accepts v4 and v6 CIDRs", () => {
    expect(isValidCidr("10.0.0.0/8")).toBe(true);
    expect(isValidCidr("172.18.0.0/16")).toBe(true);
    expect(isValidCidr("::1/128")).toBe(true);
    expect(isValidCidr("fd00::/8")).toBe(true);
  });
  it("rejects malformed or out-of-range CIDRs", () => {
    expect(isValidCidr("10.0.0.0")).toBe(false);
    expect(isValidCidr("10.0.0.0/33")).toBe(false);
    expect(isValidCidr("::1/129")).toBe(false);
    expect(isValidCidr("999.0.0.0/8")).toBe(false);
  });
});
