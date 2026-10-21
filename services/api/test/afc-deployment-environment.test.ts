/**
 * Independent forward audit closure — F-08 / F-41: ONE deployment
 * classification, and the gates that read it fail closed.
 *
 * Expected values are written out, never derived through the resolver.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  deployedInfrastructureRequired,
  developmentSurfacesAllowed,
  resolveDeploymentEnvironment,
} from "@proovra/shared-runtime";

describe("F-41 — the deployment environment classification", () => {
  const cases: Array<[Record<string, string>, { kind: string | null; ambiguous: boolean }]> = [
    [{ NODE_ENV: "production" }, { kind: "production", ambiguous: false }],
    [{ NODE_ENV: "test" }, { kind: "test", ambiguous: false }],
    [{ NODE_ENV: "development" }, { kind: "development", ambiguous: false }],
    [{}, { kind: null, ambiguous: false }],
    [{ NODE_ENV: "staging" }, { kind: null, ambiguous: false }],
    [{ PROOVRA_ENV: "staging", NODE_ENV: "development" }, { kind: "staging", ambiguous: false }],
    [{ PROOVRA_ENV: "prod" }, { kind: "production", ambiguous: false }],
    [{ PROOVRA_ENV: "staging", APP_ENV: "production" }, { kind: null, ambiguous: true }],
    [{ PROOVRA_ENV: "development", NODE_ENV: "production" }, { kind: "development", ambiguous: true }],
    [{ DEPLOY_ENV: "qa-blue" }, { kind: null, ambiguous: true }],
  ];
  for (const [env, expected] of cases) {
    it(`${JSON.stringify(env)} → ${JSON.stringify(expected)}`, () => {
      const d = resolveDeploymentEnvironment(env);
      expect({ kind: d.kind, ambiguous: d.ambiguous }).toEqual(expected);
    });
  }

  it("development surfaces only for an unambiguous development / test classification", () => {
    expect(developmentSurfacesAllowed({ NODE_ENV: "development" })).toBe(true);
    expect(developmentSurfacesAllowed({ NODE_ENV: "test" })).toBe(true);
    expect(developmentSurfacesAllowed({})).toBe(false);
    expect(developmentSurfacesAllowed({ NODE_ENV: "staging" })).toBe(false);
    expect(developmentSurfacesAllowed({ PROOVRA_ENV: "staging", NODE_ENV: "development" })).toBe(false);
    expect(developmentSurfacesAllowed({ PROOVRA_ENV: "development", NODE_ENV: "production" })).toBe(false);
    expect(developmentSurfacesAllowed({ NODE_ENV: "production" })).toBe(false);
  });

  it("declared infrastructure for production, staging and anything ambiguous", () => {
    expect(deployedInfrastructureRequired({ NODE_ENV: "production" })).toBe(true);
    expect(deployedInfrastructureRequired({ PROOVRA_ENV: "staging", NODE_ENV: "development" })).toBe(true);
    expect(deployedInfrastructureRequired({ PROOVRA_ENV: "staging", APP_ENV: "production" })).toBe(true);
    expect(deployedInfrastructureRequired({ NODE_ENV: "test" })).toBe(false);
    expect(deployedInfrastructureRequired({})).toBe(false);
  });
});

describe("F-08 — the API refuses to start with an undeclared proxy topology when deployed", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ["NODE_ENV", "PROOVRA_ENV", "APP_ENV", "DEPLOY_ENV", "API_TRUST_PROXY_MODE", "API_TRUST_PROXY", "API_TRUSTED_PROXY_HOPS"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  async function boot(env: Record<string, string | undefined>) {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const { assertProxyTrustPolicyValidOrThrow } = await import("../src/middleware/client-ip.js");
    return () => assertProxyTrustPolicyValidOrThrow();
  }

  it("staging with a non-production NODE_ENV and no declaration does not start", async () => {
    const assert = await boot({ NODE_ENV: "development", PROOVRA_ENV: "staging", API_TRUST_PROXY_MODE: undefined, API_TRUST_PROXY: undefined });
    expect(assert).toThrow(/API_TRUST_PROXY_MODE is not declared/);
  });

  it("production with no declaration does not start", async () => {
    const assert = await boot({ NODE_ENV: "production", PROOVRA_ENV: undefined, API_TRUST_PROXY_MODE: undefined, API_TRUST_PROXY: undefined });
    expect(assert).toThrow(/API_TRUST_PROXY_MODE is not declared/);
  });

  it("production with a declared single reverse proxy starts", async () => {
    const assert = await boot({ NODE_ENV: "production", API_TRUST_PROXY_MODE: "hop", API_TRUSTED_PROXY_HOPS: "1" });
    expect(assert).not.toThrow();
  });
});
