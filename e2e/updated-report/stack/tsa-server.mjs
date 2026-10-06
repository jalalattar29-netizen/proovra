/**
 * A LOCAL RFC 3161 TIME-STAMP AUTHORITY for the updated-report journey stack.
 *
 * The journey needs a record whose report v1 was issued while its timestamp was
 * NOT validated, and whose timestamp is later validated through the product's
 * own path (the kept-token validator, `repair-tsa-failed-with-token`). That
 * needs a real token from a real authority — and the stack must never contact a
 * real one. So this container IS the authority: `openssl ts -reply` over a
 * throwaway CA it mints on first boot into the shared `/tsa` volume.
 *
 *   /tsa/ca.pem   the trust anchor. The API is started WITHOUT it, so the
 *                 token issued at completion is kept but cannot be validated
 *                 (tsa_status FAILED). The journey later points
 *                 TSA_TRUST_BUNDLE_PATH at it and runs the repair script.
 *
 * Nothing here is reachable from outside the compose network.
 */
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = "/tsa";
const sh = (args) => execFileSync("openssl", args, { stdio: ["ignore", "pipe", "pipe"] });

function mint() {
  if (existsSync(join(DIR, "tsa.pem"))) return;
  mkdirSync(DIR, { recursive: true });
  sh(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30",
    "-subj", "/CN=PROOVRA E2E Test TSA Root",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    "-keyout", join(DIR, "ca.key"), "-out", join(DIR, "ca.pem")]);
  sh(["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=PROOVRA E2E Test TSA",
    "-keyout", join(DIR, "tsa.key"), "-out", join(DIR, "tsa.csr")]);
  writeFileSync(join(DIR, "ext.cnf"),
    "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,nonRepudiation\nextendedKeyUsage=critical,timeStamping\n");
  sh(["x509", "-req", "-in", join(DIR, "tsa.csr"), "-CA", join(DIR, "ca.pem"),
    "-CAkey", join(DIR, "ca.key"), "-CAcreateserial", "-days", "30",
    "-extfile", join(DIR, "ext.cnf"), "-out", join(DIR, "tsa.pem")]);
  writeFileSync(join(DIR, "serial"), "01\n");
  writeFileSync(join(DIR, "ts.cnf"), [
    "[ tsa ]", "default_tsa = tsa_config1", "[ tsa_config1 ]",
    `dir = ${DIR}`, "serial = $dir/serial", "crypto_device = builtin",
    "signer_cert = $dir/tsa.pem", "certs = $dir/ca.pem", "signer_key = $dir/tsa.key",
    "signer_digest = sha256", "default_policy = 1.3.6.1.4.1.99999.1.1",
    "digests = sha256, sha384, sha512", "accuracy = secs:1", "ordering = yes",
    "tsa_name = no", "ess_cert_id_chain = no", "ess_cert_id_alg = sha256", "",
  ].join("\n"));
  // Readable by the API's non-root user that mounts the volume read-only.
  execFileSync("chmod", ["-R", "a+rX", DIR]);
  console.log("tsa.minted");
}

mint();

createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200).end("ok");
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const work = mkdtempSync(join(tmpdir(), "tsq-"));
    try {
      writeFileSync(join(work, "q.tsq"), Buffer.concat(chunks));
      sh(["ts", "-reply", "-config", join(DIR, "ts.cnf"), "-queryfile", join(work, "q.tsq"),
        "-out", join(work, "r.tsr")]);
      const reply = readFileSync(join(work, "r.tsr"));
      res.writeHead(200, { "Content-Type": "application/timestamp-reply" }).end(reply);
      console.log("tsa.replied", reply.length);
    } catch (e) {
      console.error("tsa.reply_failed", String(e.stderr ?? e));
      res.writeHead(500).end();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
}).listen(8318, "0.0.0.0", () => console.log("tsa.listening 8318"));
