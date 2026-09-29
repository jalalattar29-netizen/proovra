/**
 * A disposable, locally generated RFC 3161 authority for the TSA validation
 * suites. Nothing here is committed key material: every key and certificate
 * is minted into a temp directory per run and deleted by `dispose()`.
 *
 * The trust anchor's subject carries TEST_TSA_ANCHOR_SUBJECT_MARKER, which the
 * production validator refuses by identity (owner decision 5: test anchors are
 * never accepted in Production).
 *
 * The HTTP server answers a timestamp query according to `mode`, so one suite
 * can drive every outcome the validator must distinguish:
 *   trusted          signed by the TSA whose root is in the bundle
 *   forged           signed by a self-signed TSA that is NOT in the bundle
 *   expired_signer   signed by a bundle-rooted TSA whose certificate expired
 *   wrong_imprint    a genuine reply for a DIFFERENT digest
 *   wrong_nonce      a genuine reply for the same digest under a fresh nonce
 *   rejected         a well-formed rejection (no token)
 *   granted_no_token status granted, no timeStampToken (hand-built DER)
 *   corrupted        a trusted reply with one signature byte flipped
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { TEST_TSA_ANCHOR_SUBJECT_MARKER } from "../../src/services/timestamp/validate-tsa-token.js";

const run = promisify(execFile);

export type LocalTsaMode =
  | "trusted"
  | "forged"
  | "expired_signer"
  | "wrong_imprint"
  | "wrong_nonce"
  | "rejected"
  | "granted_no_token"
  | "corrupted";

export const LOCAL_TSA_DEFAULT_POLICY = "1.3.6.1.4.1.55555.1.1";
export const LOCAL_TSA_OTHER_POLICY = "1.3.6.1.4.1.55555.1.2";

export type LocalTsa = {
  url: string;
  trustBundlePath: string;
  dir: string;
  mode: LocalTsaMode;
  requests: number;
  dispose(): Promise<void>;
};

const TSA_EXT = [
  "[v3_tsa]",
  "basicConstraints = critical,CA:FALSE",
  "keyUsage = critical,digitalSignature",
  "extendedKeyUsage = critical,timeStamping",
  "subjectKeyIdentifier = hash",
  "",
].join("\n");

function tsaConfig(dir: string, signer: string, key: string): string {
  const p = (f: string) => path.join(dir, f).replace(/\\/g, "/");
  return [
    "[tsa]",
    "default_tsa = tsa1",
    "[tsa1]",
    `serial = ${p("tsaserial")}`,
    `signer_cert = ${p(signer)}`,
    `certs = ${p(signer)}`,
    `signer_key = ${p(key)}`,
    "signer_digest = sha256",
    `default_policy = ${LOCAL_TSA_DEFAULT_POLICY}`,
    `other_policies = ${LOCAL_TSA_OTHER_POLICY}`,
    "digests = sha256, sha384, sha512",
    "accuracy = secs:1",
    "ordering = no",
    "tsa_name = yes",
    "ess_cert_id_chain = no",
    "ess_cert_id_alg = sha256",
    "",
  ].join("\n");
}

function caConfig(dir: string): string {
  const p = (f: string) => path.join(dir, f).replace(/\\/g, "/");
  return [
    "[ca]",
    "default_ca = CA_default",
    "[CA_default]",
    `database = ${p("index.txt")}`,
    `new_certs_dir = ${p("issued")}`,
    `serial = ${p("caserial")}`,
    `certificate = ${p("root.pem")}`,
    `private_key = ${p("root.key")}`,
    "default_md = sha256",
    "policy = policy_any",
    "copy_extensions = none",
    "unique_subject = no",
    "[policy_any]",
    "commonName = supplied",
    TSA_EXT,
  ].join("\n");
}

async function openssl(args: string[], cwd: string) {
  return run("openssl", args, { cwd, timeout: 30_000 });
}

async function mintAuthority(dir: string): Promise<void> {
  await writeFile(path.join(dir, "tsa-ext.cnf"), TSA_EXT);
  await writeFile(path.join(dir, "ca.cnf"), caConfig(dir));
  await writeFile(path.join(dir, "index.txt"), "");
  await writeFile(path.join(dir, "caserial"), "1000\n");
  await writeFile(path.join(dir, "tsaserial"), "01\n");
  await (await import("node:fs/promises")).mkdir(path.join(dir, "issued"));

  // Trust anchor (carries the test marker).
  await openssl([
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "root.key", "-out", "root.pem",
    "-days", "30", "-subj", `/O=${TEST_TSA_ANCHOR_SUBJECT_MARKER}/CN=Local Test Root`,
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ], dir);
  // Bundle-rooted TSA signer.
  await openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "tsa.key", "-out", "tsa.csr", "-subj", "/CN=Local Test TSA"], dir);
  await openssl([
    "x509", "-req", "-in", "tsa.csr", "-CA", "root.pem", "-CAkey", "root.key", "-set_serial", "4097",
    "-out", "tsa.pem", "-days", "30", "-extfile", "tsa-ext.cnf", "-extensions", "v3_tsa",
  ], dir);
  // Bundle-rooted TSA signer whose certificate expired long ago.
  await openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "expired.key", "-out", "expired.csr", "-subj", "/CN=Local Expired TSA"], dir);
  await openssl([
    "ca", "-batch", "-config", "ca.cnf", "-in", "expired.csr", "-out", "expired.pem", "-notext",
    "-startdate", "20200101000000Z", "-enddate", "20210101000000Z", "-extensions", "v3_tsa",
  ], dir);
  // A self-signed "TSA" that is nobody's anchor: the forged-token signer.
  await openssl([
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "forged.key", "-out", "forged.pem",
    "-days", "30", "-subj", "/CN=Forged TSA",
    "-addext", "basicConstraints=critical,CA:FALSE", "-addext", "keyUsage=critical,digitalSignature",
    "-addext", "extendedKeyUsage=critical,timeStamping",
  ], dir);

  await writeFile(path.join(dir, "cfg-trusted.cnf"), tsaConfig(dir, "tsa.pem", "tsa.key"));
  await writeFile(path.join(dir, "cfg-expired.cnf"), tsaConfig(dir, "expired.pem", "expired.key"));
  await writeFile(path.join(dir, "cfg-forged.cnf"), tsaConfig(dir, "forged.pem", "forged.key"));
}

async function reply(dir: string, cfg: string, queryFile: string, out: string): Promise<Buffer> {
  await openssl(["ts", "-reply", "-config", cfg, "-queryfile", queryFile, "-out", out], dir);
  return readFile(path.join(dir, out));
}

/** Flip one byte inside the CMS signature value (the last bytes of the token). */
function corruptSignature(der: Buffer): Buffer {
  const copy = Buffer.from(der);
  copy[copy.length - 8] ^= 0xff;
  return copy;
}

export async function startLocalTsa(): Promise<LocalTsa> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-tsa-"));
  await mintAuthority(dir);
  const trustBundlePath = path.join(dir, "root.pem");
  let seq = 0;

  const state: { mode: LocalTsaMode; requests: number } = { mode: "trusted", requests: 0 };

  const answer = async (query: Buffer): Promise<Buffer> => {
    const n = ++seq;
    const q = `q-${n}.tsq`;
    await writeFile(path.join(dir, q), query);
    switch (state.mode) {
      case "trusted":
        return reply(dir, "cfg-trusted.cnf", q, `r-${n}.tsr`);
      case "forged":
        return reply(dir, "cfg-forged.cnf", q, `r-${n}.tsr`);
      case "expired_signer":
        return reply(dir, "cfg-expired.cnf", q, `r-${n}.tsr`);
      case "corrupted":
        return corruptSignature(await reply(dir, "cfg-trusted.cnf", q, `r-${n}.tsr`));
      case "wrong_imprint": {
        const other = `o-${n}.tsq`;
        await openssl(["ts", "-query", "-digest", "ab".repeat(32), "-sha256", "-cert", "-out", other], dir);
        return reply(dir, "cfg-trusted.cnf", other, `r-${n}.tsr`);
      }
      case "wrong_nonce": {
        // Same digest, a fresh query (hence a fresh nonce).
        const { stdout } = await openssl(["ts", "-query", "-in", q, "-text"], dir);
        const hex = /Message data:\s*\n([\s\S]*?)\n\s*Nonce/.exec(stdout)?.[1] ?? "";
        const digest = Array.from(hex.matchAll(/-\s*((?:[0-9a-f]{2}[ -]?)+)/gi))
          .map((m) => m[1]!.replace(/[^0-9a-f]/gi, ""))
          .join("");
        const other = `o-${n}.tsq`;
        await openssl(["ts", "-query", "-digest", digest, "-sha256", "-cert", "-out", other], dir);
        return reply(dir, "cfg-trusted.cnf", other, `r-${n}.tsr`);
      }
      case "rejected":
        // PKIStatusInfo { status rejection(2) }, no token.
        return Buffer.from([0x30, 0x05, 0x30, 0x03, 0x02, 0x01, 0x02]);
      case "granted_no_token":
        // PKIStatusInfo { status granted(0) }, no token.
        return Buffer.from([0x30, 0x05, 0x30, 0x03, 0x02, 0x01, 0x00]);
    }
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      state.requests += 1;
      answer(Buffer.concat(chunks)).then(
        (body) => {
          res.writeHead(200, { "content-type": "application/timestamp-reply" });
          res.end(body);
        },
        (err: unknown) => {
          res.writeHead(500);
          res.end(String(err));
        },
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;

  const tsa: LocalTsa = {
    url: `http://127.0.0.1:${port}/tsr`,
    trustBundlePath,
    dir,
    get mode() {
      return state.mode;
    },
    set mode(m: LocalTsaMode) {
      state.mode = m;
    },
    get requests() {
      return state.requests;
    },
    set requests(v: number) {
      state.requests = v;
    },
    async dispose() {
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    },
  };
  return tsa;
}
