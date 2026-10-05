/**
 * UC-TRUST-006 — the RFC 3161 trust configuration is guarded.
 *
 *   - PROOVRA_ENV=production (NODE_ENV not production) still refuses a test
 *     anchor;
 *   - a configured anchor pin refuses a bundle whose anchor is not pinned;
 *   - a token whose genTime could not be parsed is not validated "now";
 *   - credentials are optional (an unauthenticated authority stamps);
 *   - readiness requires only a usable bundle and names its exact defect; the
 *     policy allowlist and the anchor pin are optional (2026-10-05).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEvidenceTimestamp } from "../src/services/timestamp.service.js";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  inspectTsaTrustBundle,
  tsaTrustConfigurationIssues,
  validateTsaToken,
} from "../src/services/timestamp/validate-tsa-token.js";

/** A real root + intermediate CA chain (no TEST marker), made with openssl. */
function makeChain() {
  const dir = mkdtempSync(path.join(tmpdir(), "tsa-chain-"));
  const ossl = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  writeFileSync(path.join(dir, "ca.ext"), "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n");
  ossl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "root.key", "-out", "root.pem", "-days", "30", "-subj", "/O=Chain Test/CN=Chain Root", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  ossl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "int.key", "-out", "int.csr", "-subj", "/O=Chain Test/CN=Chain Intermediate"]);
  ossl(["x509", "-req", "-in", "int.csr", "-CA", "root.pem", "-CAkey", "root.key", "-CAcreateserial", "-out", "int.pem", "-days", "30", "-extfile", "ca.ext"]);
  const root = readFileSync(path.join(dir, "root.pem"), "utf8");
  const int = readFileSync(path.join(dir, "int.pem"), "utf8");
  writeFileSync(path.join(dir, "bundle.pem"), int + root);
  writeFileSync(path.join(dir, "int-only.pem"), int);
  writeFileSync(path.join(dir, "empty.pem"), "not a certificate\n");
  const fp = (pem: string) => new X509Certificate(pem).fingerprint256.replace(/:/g, "").toLowerCase();
  return {
    dir,
    bundle: path.join(dir, "bundle.pem"),
    intermediateOnly: path.join(dir, "int-only.pem"),
    empty: path.join(dir, "empty.pem"),
    rootSha256: fp(root),
    intermediateSha256: fp(int),
  };
}
const chain = makeChain();
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
    configure({ PROOVRA_ENV: "production" });
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

  it("readiness requires only the minimum: a usable bundle — the policy list and the pin are optional", async () => {
    // Evidence-output incident (2026-10-05): production used to require
    // TSA_ACCEPTED_POLICY_OIDS and TSA_TRUST_ANCHOR_SHA256 as well, so /readyz
    // stayed 503 with neither supplied by the provider.
    configure({ PROOVRA_ENV: "production", TSA_TRUST_BUNDLE_PATH: undefined });
    expect(await tsaTrustConfigurationIssues(process.env)).toEqual(["tsa_trust_bundle_path_not_set"]);
    configure({ NODE_ENV: "production", TSA_TRUST_BUNDLE_PATH: chain.bundle });
    expect(await tsaTrustConfigurationIssues(process.env)).toEqual([]);
    configure();
    expect(await tsaTrustConfigurationIssues(process.env)).toEqual([]);
  });

  it("readiness names the EXACT defect of the bundle", async () => {
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ TSA_TRUST_BUNDLE_PATH: path.join(chain.dir, "missing.pem") }, "tsa_trust_bundle_unreadable"],
      [{ TSA_TRUST_BUNDLE_PATH: chain.empty }, "tsa_trust_bundle_no_certificates"],
      [{ TSA_TRUST_BUNDLE_PATH: chain.intermediateOnly }, "tsa_trust_bundle_no_root"],
      [{ TSA_TRUST_BUNDLE_PATH: chain.bundle, TSA_TRUST_ANCHOR_SHA256: "00".repeat(32) }, "tsa_trust_anchor_pin_mismatch"],
    ];
    for (const [extra, issue] of cases) {
      configure({ NODE_ENV: "production", ...extra });
      expect(await tsaTrustConfigurationIssues(process.env), issue).toEqual([issue]);
    }
    configure({ PROOVRA_ENV: "production" });
    expect(await tsaTrustConfigurationIssues(process.env)).toEqual(["tsa_trust_anchor_test_certificate"]);
  });

  it("the pin is computed from the installed bundle and covers its ROOT; an intermediate needs no pin", async () => {
    configure({ NODE_ENV: "production", TSA_TRUST_BUNDLE_PATH: chain.bundle, TSA_TRUST_ANCHOR_SHA256: chain.rootSha256 });
    const inspection = await inspectTsaTrustBundle(process.env);
    expect(inspection).toMatchObject({ ok: true, rootSha256: [chain.rootSha256] });
    expect(inspection.ok && inspection.certificateSha256).toHaveLength(2);
    // Colon-separated upper-case (openssl's format) is accepted too.
    configure({
      NODE_ENV: "production",
      TSA_TRUST_BUNDLE_PATH: chain.bundle,
      TSA_TRUST_ANCHOR_SHA256: chain.rootSha256.toUpperCase().match(/../g)!.join(":"),
    });
    expect(await tsaTrustConfigurationIssues(process.env)).toEqual([]);
    // Pinning only the intermediate does not pin the anchor.
    configure({ NODE_ENV: "production", TSA_TRUST_BUNDLE_PATH: chain.bundle, TSA_TRUST_ANCHOR_SHA256: chain.intermediateSha256 });
    expect(await tsaTrustConfigurationIssues(process.env)).toEqual(["tsa_trust_anchor_pin_mismatch"]);
  });

  it("the policy allowlist is enforced when configured, and the signed policy is recorded either way", async () => {
    configure();
    const open = await createEvidenceTimestamp({ digestHex: DIGEST });
    expect(open?.status).toBe("STAMPED");
    expect(open?.policyOid).toBe(LOCAL_TSA_DEFAULT_POLICY);
    configure({ TSA_ACCEPTED_POLICY_OIDS: LOCAL_TSA_DEFAULT_POLICY });
    expect((await createEvidenceTimestamp({ digestHex: DIGEST }))?.status).toBe("STAMPED");
    configure({ TSA_ACCEPTED_POLICY_OIDS: "1.3.6.1.4.1.55555.9.9" });
    const refused = await createEvidenceTimestamp({ digestHex: DIGEST });
    expect(refused?.status).toBe("FAILED");
    expect(refused?.failureCode).toBe("tsa_policy_not_accepted");
  }, 60_000);

});
