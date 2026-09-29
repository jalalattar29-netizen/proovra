/**
 * RUNTIME PROBE RT-TSA — audit-only, no network, no database.
 *
 * Claim under test (TSA-01/02/03): the production acceptance path for an
 * RFC 3161 reply is `openssl ts -reply -text` + parseTsaReply(); nothing
 * verifies the signature or the certificate chain.
 *
 * The probe mints a THROWAWAY self-signed "TSA" in a temp directory (never
 * written into the repository), issues three replies with the real openssl
 * binary, feeds each through the unmodified production parser, and contrasts
 * with `openssl ts -verify` against the system CA bundle.
 *
 * Run: node_modules/.bin/tsx <this file> <results.json>   (cwd services/api)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseTsaReply } from "../../../../../../services/api/src/services/timestamp/parse-tsa-reply.ts";

const out = process.argv[2];
const dir = mkdtempSync(path.join(tmpdir(), "et-tsa-"));
const run = (args: string[], opts: { allowFail?: boolean } = {}) => {
  const r = spawnSync("openssl", args, { cwd: dir, encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`openssl ${args.join(" ")}: ${r.stderr}`);
  return r;
};
const sha256 = (s: string) => execFileSync("node", ["-e", `process.stdout.write(require("crypto").createHash("sha256").update(${JSON.stringify(s)}).digest("hex"))`], { encoding: "utf8" });

try {
  writeFileSync(path.join(dir, "tsa.cnf"), [
    "[ req ]", "distinguished_name = dn", "prompt = no", "x509_extensions = v3_tsa",
    "[ dn ]", "CN = Audit Untrusted Self-Signed TSA (NOT A REAL AUTHORITY)",
    "[ v3_tsa ]", "basicConstraints = critical,CA:false", "keyUsage = critical,digitalSignature,nonRepudiation", "extendedKeyUsage = critical,timeStamping",
    "[ tsa_config ]", "serial = ./serial", "crypto_device = builtin", "signer_cert = ./tsa.crt", "signer_key = ./tsa.key",
    "signer_digest = sha256", "default_policy = 1.2.3.4.1", "other_policies = 1.2.3.4.2", "digests = sha256", "accuracy = secs:1",
    "ordering = no", "tsa_name = no", "ess_cert_id_chain = no", "ess_cert_id_alg = sha256", "",
  ].join("\n"));
  writeFileSync(path.join(dir, "serial"), "01\n");
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "tsa.key", "-out", "tsa.crt", "-days", "30", "-config", "tsa.cnf"]);

  const digest = sha256("audit-evidence-bytes");
  const other = sha256("some-other-bytes");
  run(["ts", "-query", "-digest", digest, "-sha256", "-cert", "-out", "req.tsq"]);
  run(["ts", "-query", "-digest", other, "-sha256", "-cert", "-out", "other.tsq"]);
  run(["ts", "-reply", "-config", "tsa.cnf", "-section", "tsa_config", "-queryfile", "req.tsq", "-out", "forged-granted.tsr"]);
  run(["ts", "-reply", "-config", "tsa.cnf", "-section", "tsa_config", "-queryfile", "other.tsq", "-out", "mismatch.tsr"]);
  writeFileSync(path.join(dir, "granted-no-token.tsr"), Buffer.from([0x30, 0x05, 0x30, 0x03, 0x02, 0x01, 0x00]));

  const caBundle = process.env.ET_CA_BUNDLE ?? "/mingw64/etc/ssl/certs/ca-bundle.crt";
  const cases = ["forged-granted", "mismatch", "granted-no-token"].map((name) => {
    // Exactly what timestamp.service.ts:253 runs.
    const text = run(["ts", "-reply", "-in", `${name}.tsr`, "-text"], { allowFail: true });
    const parsed = parseTsaReply(text.status === 0 ? text.stdout : "", digest);
    const verify = run(["ts", "-verify", "-digest", digest, "-in", `${name}.tsr`, "-CAfile", caBundle], { allowFail: true });
    return {
      name,
      opensslReplyTextExit: text.status,
      productionParser: { granted: parsed.granted, imprintMatchesRequest: parsed.imprintMatchesRequest, failureCode: parsed.failureCode, warnings: parsed.warnings },
      productionPersistedStatus: text.status !== 0 ? "FAILED (subprocess error branch, timestamp.service.ts:334)" : parsed.granted ? "STAMPED" : "FAILED",
      opensslVerifyAgainstSystemRoots: verify.status === 0 ? "VERIFIED" : `REFUSED: ${(verify.stderr.match(/Verify error:[^\n]*/) ?? [verify.stderr.trim().split("\n").pop()])[0]!.trim()}`,
    };
  });
  const result = {
    probe: "RT-TSA",
    openssl: run(["version"]).stdout.trim(),
    digest,
    cases,
    verdict: {
      "TSA-01": cases[0].productionPersistedStatus === "STAMPED" && cases[0].opensslVerifyAgainstSystemRoots.startsWith("REFUSED") ? "DEFECT_REPRODUCED" : "NOT_REPRODUCED",
      "imprint-mismatch-rejection": cases[1].productionParser.failureCode === "tsa_message_imprint_mismatch" ? "CORRECT" : "DEFECT",
      "TSA-02-no-token": cases[2].productionPersistedStatus.startsWith("FAILED") ? "REFUTED_ON_THIS_OPENSSL" : "DEFECT_REPRODUCED",
    },
  };
  writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result.verdict));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
