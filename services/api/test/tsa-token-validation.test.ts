/**
 * ET-TSA-01 / ET-TSA-02 / ET-TSA-03 / ET-TSA-06 / ET-TSA-07 — a timestamp is
 * STAMPED only after its token is VALIDATED: CMS signature, certificate chain
 * to the configured trust anchor, signer validity at genTime, the
 * timeStamping EKU, imprint and nonce against the query we sent, and (when
 * configured) the accepted policy. Everything else is FAILED with a persisted,
 * distinguishable failure code.
 *
 * Driven against a locally minted authority (test/support/local-tsa-authority)
 * over loopback HTTP, through the production `createEvidenceTimestamp`.
 *
 * On a40ca76f the forged, expired-signer, wrong-nonce, corrupted and
 * granted-without-token replies were all persisted as STAMPED, and the
 * returned `messageImprint` was the digest we sent, never the token's.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createEvidenceTimestamp } from "../src/services/timestamp.service.js";
import { evaluateKeptTsaToken } from "../src/services/timestamp/kept-token-validation.js";
import {
  LOCAL_TSA_DEFAULT_POLICY,
  LOCAL_TSA_OTHER_POLICY,
  startLocalTsa,
  type LocalTsa,
} from "./support/local-tsa-authority.js";

const DIGEST = "5f".repeat(32);
const ENV_KEYS = [
  "TSA_ENABLED",
  "TSA_URL",
  "TSA_USERNAME",
  "TSA_PASSWORD",
  "TSA_PROVIDER",
  "TSA_TRUST_BUNDLE_PATH",
  "TSA_ACCEPTED_POLICY_OIDS",
  "NODE_ENV",
] as const;

describe("TSA token validation (locally minted authority, loopback HTTP)", () => {
  let tsa: LocalTsa;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    tsa = await startLocalTsa();
  }, 60_000);
  afterAll(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await tsa?.dispose();
  });

  function configure(extra: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}) {
    process.env.TSA_ENABLED = "true";
    process.env.TSA_URL = tsa.url;
    process.env.TSA_USERNAME = "local-user";
    process.env.TSA_PASSWORD = "local-secret-never-in-argv";
    process.env.TSA_PROVIDER = "LOCAL_TEST_TSA";
    process.env.TSA_TRUST_BUNDLE_PATH = tsa.trustBundlePath;
    delete process.env.TSA_ACCEPTED_POLICY_OIDS;
    process.env.NODE_ENV = "test";
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  afterEach(() => {
    tsa.mode = "trusted";
  });

  const stamp = async () => {
    const r = await createEvidenceTimestamp({ digestHex: DIGEST });
    expect(r).not.toBeNull();
    return r!;
  };

  it("a token from the trusted authority is STAMPED and VALIDATED, with the token's own imprint", async () => {
    configure();
    const r = await stamp();
    expect(r.status).toBe("STAMPED");
    expect(r.failureCode).toBeNull();
    expect(r.validatedAtUtc).toBeInstanceOf(Date);
    expect(r.signerCertSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.policyOid).toBe(LOCAL_TSA_DEFAULT_POLICY);
    // ET-TSA-03: the imprint is READ FROM THE TOKEN, and the request digest is recorded separately.
    expect(r.messageImprint).toBe(DIGEST);
    expect(r.requestDigestHex).toBe(DIGEST);
    expect(r.tokenBase64.length).toBeGreaterThan(100);
  }, 30_000);

  it("a FORGED self-signed token is FAILED (untrusted chain), token kept for triage", async () => {
    configure();
    tsa.mode = "forged";
    const r = await stamp();
    expect(r.status).toBe("FAILED");
    expect(r.failureCode).toBe("tsa_token_untrusted");
    expect(r.validatedAtUtc).toBeNull();
    expect(r.tokenBase64.length).toBeGreaterThan(100);
  }, 30_000);

  it("a token signed by an EXPIRED signer certificate is FAILED", async () => {
    configure();
    tsa.mode = "expired_signer";
    const r = await stamp();
    expect(r.status).toBe("FAILED");
    expect(r.failureCode).toBe("tsa_token_untrusted");
  }, 30_000);

  it("a genuine token for a DIFFERENT digest is FAILED as an imprint mismatch, with the token's imprint recorded", async () => {
    configure();
    tsa.mode = "wrong_imprint";
    const r = await stamp();
    expect(r.status).toBe("FAILED");
    expect(r.failureCode).toBe("tsa_message_imprint_mismatch");
    expect(r.messageImprint).toBe("ab".repeat(32));
    expect(r.requestDigestHex).toBe(DIGEST);
  }, 30_000);

  it("a genuine token answering a DIFFERENT nonce (replay) is FAILED", async () => {
    configure();
    tsa.mode = "wrong_nonce";
    const r = await stamp();
    expect(r.status).toBe("FAILED");
    expect(r.failureCode).toBe("tsa_nonce_mismatch");
  }, 30_000);

  it("a token whose signature bytes were altered is FAILED", async () => {
    configure();
    tsa.mode = "corrupted";
    const r = await stamp();
    expect(r.status).toBe("FAILED");
    expect(["tsa_token_signature_invalid", "tsa_response_parse_failed"]).toContain(r.failureCode);
  }, 30_000);

  it("ET-TSA-02: a GRANTED status with NO token is FAILED, never STAMPED", async () => {
    configure();
    tsa.mode = "granted_no_token";
    const r = await stamp();
    expect(r.status).toBe("FAILED");
    expect(r.failureCode).toBe("tsa_token_missing");
  }, 30_000);

  it("a rejection is FAILED as not granted (distinct from provider unavailability)", async () => {
    configure();
    tsa.mode = "rejected";
    const r = await stamp();
    expect(r.status).toBe("FAILED");
    expect(r.failureCode).toBe("tsa_response_not_granted");
  }, 30_000);

  it("a policy outside TSA_ACCEPTED_POLICY_OIDS is FAILED", async () => {
    configure({ TSA_ACCEPTED_POLICY_OIDS: LOCAL_TSA_OTHER_POLICY });
    const r = await stamp();
    expect(r.status).toBe("FAILED");
    expect(r.failureCode).toBe("tsa_policy_not_accepted");
    configure({ TSA_ACCEPTED_POLICY_OIDS: `${LOCAL_TSA_OTHER_POLICY}, ${LOCAL_TSA_DEFAULT_POLICY}` });
    expect((await stamp()).status).toBe("STAMPED");
  }, 30_000);

  it("fails CLOSED when no trust anchor is configured (token kept so it can be validated later)", async () => {
    configure({ TSA_TRUST_BUNDLE_PATH: undefined });
    const r = await stamp();
    expect(r.status).toBe("FAILED");
    expect(r.failureCode).toBe("tsa_trust_anchor_not_configured");
    expect(r.tokenBase64.length).toBeGreaterThan(100);
  }, 30_000);

  it("owner decision 5: a TEST trust anchor is refused in Production", async () => {
    configure({ NODE_ENV: "production" });
    const r = await stamp();
    expect(r.status).toBe("FAILED");
    expect(r.failureCode).toBe("tsa_trust_anchor_refused");
  }, 30_000);

  it("ET-TSA-07: an unreachable provider is classified without echoing credentials", async () => {
    configure({ TSA_URL: "http://127.0.0.1:9/tsr" });
    const r = await stamp();
    expect(r.status).toBe("FAILED");
    expect(r.failureCode).toBe("tsa_provider_unreachable");
    expect(JSON.stringify(r)).not.toContain("local-secret-never-in-argv");
  }, 30_000);

  it("ET-TSA-09: the operator CLI's kept-token decision uses the same validator", async () => {
    configure();
    const good = await stamp();
    const row = { tsaTokenBase64: good.tokenBase64, tsaInputDigestHex: DIGEST, fileSha256: DIGEST };
    const ok = await evaluateKeptTsaToken(row);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.messageImprint).toBe(DIGEST);
      expect(ok.genTimeUtc).toBeInstanceOf(Date);
      expect(ok.signerCertSha256).toBe(good.signerCertSha256);
    }
    // Against a different recorded digest the same token is refused.
    expect(await evaluateKeptTsaToken({ ...row, tsaInputDigestHex: "ab".repeat(32) })).toMatchObject({ ok: false, code: "tsa_message_imprint_mismatch" });
    // A forged token is refused, never written STAMPED.
    tsa.mode = "forged";
    const forged = await stamp();
    expect(await evaluateKeptTsaToken({ ...row, tsaTokenBase64: forged.tokenBase64 })).toMatchObject({ ok: false, code: "tsa_token_untrusted" });
    // No anchor configured: nothing is validated.
    configure({ TSA_TRUST_BUNDLE_PATH: undefined });
    expect(await evaluateKeptTsaToken(row)).toMatchObject({ ok: false, code: "tsa_trust_anchor_not_configured" });
    // A reply with no token at all.
    expect(await evaluateKeptTsaToken({ ...row, tsaTokenBase64: "" })).toMatchObject({ ok: false, code: "tsa_token_missing" });
  }, 60_000);
});
