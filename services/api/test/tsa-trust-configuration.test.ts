/**
 * UC-TRUST-006 — the RFC 3161 trust configuration is guarded.
 *
 *   - PROOVRA_ENV=production (NODE_ENV not production) still refuses a test
 *     anchor and still requires an accepted-policy list;
 *   - a configured anchor pin refuses a bundle whose anchor is not pinned;
 *   - a token whose genTime could not be parsed is not validated "now";
 *   - credentials are optional (an unauthenticated authority stamps);
 *   - readiness names a missing anchor / policy list / pin in production.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEvidenceTimestamp } from "../src/services/timestamp.service.js";
import { tsaTrustConfigurationIssues, validateTsaToken } from "../src/services/timestamp/validate-tsa-token.js";
import { LOCAL_TSA_DEFAULT_POLICY, startLocalTsa, type LocalTsa } from "./support/local-tsa-authority.js";

const DIGEST = "6a".repeat(32);
const KEYS = [
  "TSA_ENABLED",
  "TSA_URL",
  "TSA_USERNAME",
  "TSA_PASSWORD",
  "TSA_PROVIDER",
  "TSA_TRUST_BUNDLE_PATH",
  "TSA_ACCEPTED_POLICY_OIDS",
  "TSA_TRUST_ANCHOR_SHA256",
  "NODE_ENV",
  "PROOVRA_ENV",
] as const;

describe("TSA trust configuration (UC-TRUST-006)", () => {
  let tsa: LocalTsa;
  const saved: Record<string, string | undefined> = {};
  beforeAll(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    tsa = await startLocalTsa();
  }, 60_000);
  afterAll(async () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await tsa?.dispose();
  });

  function configure(extra: Record<string, string | undefined> = {}) {
    for (const k of KEYS) delete process.env[k];
    process.env.TSA_ENABLED = "true";
    process.env.TSA_URL = tsa.url;
    process.env.TSA_PROVIDER = "LOCAL_TEST_TSA";
    process.env.TSA_TRUST_BUNDLE_PATH = tsa.trustBundlePath;
    process.env.NODE_ENV = "test";
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  it("credentials are optional: an unauthenticated authority stamps and validates", async () => {
    configure();
    const r = await createEvidenceTimestamp({ digestHex: DIGEST });
    expect(r?.status).toBe("STAMPED");
  }, 30_000);

  it("PROOVRA_ENV=production refuses the test anchor even when NODE_ENV is not production", async () => {
    configure({ PROOVRA_ENV: "production", TSA_ACCEPTED_POLICY_OIDS: LOCAL_TSA_DEFAULT_POLICY });
    const r = await createEvidenceTimestamp({ digestHex: DIGEST });
    expect(r?.status).toBe("FAILED");
    expect(r?.failureCode).toBe("tsa_trust_anchor_refused");
  }, 30_000);

  it("an anchor pin that does not match the bundle refuses it", async () => {
    configure({ TSA_TRUST_ANCHOR_SHA256: "00".repeat(32) });
    const r = await createEvidenceTimestamp({ digestHex: DIGEST });
    expect(r?.status).toBe("FAILED");
    expect(r?.failureCode).toBe("tsa_trust_anchor_refused");
  }, 30_000);

  it("a token with no parsed genTime is not validated at 'now'", async () => {
    configure();
    const r = await validateTsaToken({
      responseFile: "unused.tsr",
      workDir: ".",
      digestHex: DIGEST,
      genTimeUtc: null,
      policyOid: LOCAL_TSA_DEFAULT_POLICY,
    });
    expect(r).toMatchObject({ ok: false, code: "tsa_token_untrusted" });
  });

  it("readiness names what production is missing", async () => {
    configure({ PROOVRA_ENV: "production", TSA_TRUST_BUNDLE_PATH: undefined });
    const issues = await tsaTrustConfigurationIssues(process.env);
    expect(issues).toEqual(
      expect.arrayContaining([
        "tsa_trust_anchor_not_configured",
        "tsa_accepted_policy_oids_not_configured",
        "tsa_trust_anchor_sha256_not_configured",
      ]),
    );
    configure();
    expect(await tsaTrustConfigurationIssues(process.env)).toEqual([]);
  });
});
