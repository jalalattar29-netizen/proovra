/**
 * AUD-0063 — the fastify upgrade must not change who the API thinks the client is.
 *
 * Fastify 5.12 (the release with the advisory fixes) treats a NUMERIC
 * trustProxy as "trust nothing". The API's production policy is `hop` with one
 * Caddy hop; passed as a number, every request would resolve to the proxy's
 * address. fastifyTrustProxy() passes hop mode as a function with the same
 * hop-count meaning. Driven through a real Fastify instance.
 */
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { __resetProxyTrustPolicyForTests, fastifyTrustProxy } from "../src/middleware/client-ip.js";

async function resolvedIp(trustProxy: unknown, xff: string): Promise<string> {
  const app = Fastify({ trustProxy: trustProxy as never });
  app.get("/ip", async (req) => ({ ip: req.ip }));
  const res = await app.inject({ method: "GET", url: "/ip", headers: { "x-forwarded-for": xff }, remoteAddress: "127.0.0.1" });
  await app.close();
  return (res.json() as { ip: string }).ip;
}

describe("AUD-0063 — hop-mode client IP on the upgraded fastify", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetProxyTrustPolicyForTests();
  });

  it("hop=1 behind one proxy: the client is the rightmost forwarded address", async () => {
    vi.stubEnv("API_TRUST_PROXY_MODE", "hop");
    vi.stubEnv("API_TRUSTED_PROXY_HOPS", "1");
    __resetProxyTrustPolicyForTests();
    // A client-supplied left entry cannot choose the IP: only the hop Caddy appended counts.
    expect(await resolvedIp(fastifyTrustProxy(), "6.6.6.6, 203.0.113.9")).toBe("203.0.113.9");
  });

  it("hop=2: two trusted hops", async () => {
    vi.stubEnv("API_TRUST_PROXY_MODE", "hop");
    vi.stubEnv("API_TRUSTED_PROXY_HOPS", "2");
    __resetProxyTrustPolicyForTests();
    expect(await resolvedIp(fastifyTrustProxy(), "6.6.6.6, 203.0.113.9, 10.0.0.2")).toBe("203.0.113.9");
  });

  it("contrast: the raw number on this fastify resolves every request to the proxy", async () => {
    expect(await resolvedIp(1, "6.6.6.6, 203.0.113.9")).toBe("127.0.0.1");
  });

  it("off: the socket peer, headers ignored", async () => {
    vi.stubEnv("API_TRUST_PROXY_MODE", "off");
    __resetProxyTrustPolicyForTests();
    expect(await resolvedIp(fastifyTrustProxy(), "6.6.6.6")).toBe("127.0.0.1");
  });
});
