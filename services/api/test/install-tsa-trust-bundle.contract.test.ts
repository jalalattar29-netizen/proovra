/**
 * scripts/install-tsa-trust-bundle.sh — EXECUTED against a generated root +
 * timestamp CA + a decoy test CA published as a PKCS#7 set (the shape of the
 * publisher's all-stamm-cert.p7b), served over file:// with the expected
 * fingerprints overridden. The real defaults are the GLOBALTRUST 2015 values.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..", "..", "..");
const SCRIPT = path.join(REPO, "scripts", "install-tsa-trust-bundle.sh");
const fp = (pem: string) => new X509Certificate(pem).fingerprint256.replace(/:/g, "").toLowerCase();
const url = (p: string) => `file://${p.replace(/\\/g, "/").replace(/^\/?([A-Za-z]):/, "/$1:")}`;

function makeAuthority() {
  const dir = mkdtempSync(path.join(tmpdir(), "tsa-install-"));
  const ossl = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  writeFileSync(path.join(dir, "ca.ext"), "basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n");
  const root = (name: string, subj: string) =>
    ossl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.pem`, "-days", "30", "-subj", subj, "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  const sub = (name: string, subj: string, ca: string) => {
    ossl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", subj]);
    ossl(["x509", "-req", "-in", `${name}.csr`, "-CA", `${ca}.pem`, "-CAkey", `${ca}.key`, "-CAcreateserial", "-out", `${name}.pem`, "-days", "30", "-extfile", "ca.ext"]);
  };
  root("root", "/O=Test Publisher/CN=Publisher Root");
  sub("ts", "/O=Test Publisher/CN=Publisher QUALIFIED TIMESTAMP 1", "root");
  root("decoy", "/O=Test Publisher/CN=ECM TEST 2015");
  ossl(["crl2pkcs7", "-nocrl", "-certfile", "decoy.pem", "-certfile", "ts.pem", "-certfile", "root.pem", "-outform", "DER", "-out", "set.p7b"]);
  const pem = (n: string) => readFileSync(path.join(dir, `${n}.pem`), "utf8");
  return { dir, rootSha: fp(pem("root")), tsSha: fp(pem("ts")), decoySha: fp(pem("decoy")) };
}

const A = makeAuthority();

function run(args: string[], env: Record<string, string>) {
  const dest = mkdtempSync(path.join(tmpdir(), "tsa-dest-"));
  const envFile = path.join(dest, "app.env");
  writeFileSync(envFile, env.ENV_BODY ?? "DATABASE_URL=postgresql://user:SuperSecretPw@db/x\n");
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME ?? dest,
      SYSTEMROOT: process.env.SYSTEMROOT,
      TSA_INSTALL_ROOT_URL: url(path.join(A.dir, "root.pem")),
      TSA_INSTALL_SET_URL: url(path.join(A.dir, "set.p7b")),
      TSA_INSTALL_ROOT_SHA256: A.rootSha,
      TSA_INSTALL_ISSUER_SHA256: A.tsSha,
      TSA_TRUST_DIR: path.join(dest, "tsa"),
      ENV_FILE: envFile,
      ...env,
    },
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, bundle: path.join(dest, "tsa", "trust-bundle.pem") };
}

describe("install-tsa-trust-bundle.sh", () => {
  it("installs EXACTLY the root and the timestamp CA — never the decoy test CA — and reports the optional settings", () => {
    const r = run([], {});
    expect(r.status, r.out).toBe(0);
    const pems = readFileSync(r.bundle, "utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)!;
    expect(pems.map(fp).sort()).toEqual([A.rootSha, A.tsSha].sort());
    expect(r.out).not.toContain(A.decoySha);
    expect(r.out).toMatch(/TSA_TRUST_ANCHOR_SHA256: not set \(optional\)/);
    expect(r.out).toMatch(/TSA_ACCEPTED_POLICY_OIDS: not set \(optional\)/);
    expect(r.out).toMatch(/OK: trust bundle installed and consistent/);
    expect(r.out).not.toContain("SuperSecretPw");
  });

  it("refuses a root whose fingerprint is not the expected one, and installs nothing", () => {
    const r = run([], { TSA_INSTALL_ROOT_SHA256: "00".repeat(32) });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/not the GLOBALTRUST 2015 root .* nothing installed/);
    expect(existsSync(r.bundle)).toBe(false);
  });

  it("refuses when the set has no CA with the expected fingerprint", () => {
    const r = run([], { TSA_INSTALL_ISSUER_SHA256: "11".repeat(32) });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/does not contain GLOBALTRUST 2015 QUALIFIED TIMESTAMP 1/);
    expect(existsSync(r.bundle)).toBe(false);
  });

  it("refuses a 'timestamp CA' that does not chain to the root (the decoy, by fingerprint)", () => {
    const r = run([], { TSA_INSTALL_ISSUER_SHA256: A.decoySha });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/does not verify under the root/);
    expect(existsSync(r.bundle)).toBe(false);
  });

  it("a set pin that omits the root, or an allowlist without the observed policy, is reported with the exact fix", () => {
    const pin = run([], { ENV_BODY: `TSA_TRUST_ANCHOR_SHA256=${A.tsSha}\n` });
    expect(pin.status).toBe(3);
    expect(pin.out).toMatch(/does NOT include the installed root/);
    expect(pin.out).toContain(`TSA_TRUST_ANCHOR_SHA256=${A.rootSha}`);
    const ok = run([], { ENV_BODY: `TSA_TRUST_ANCHOR_SHA256="${A.rootSha.toUpperCase()}"\nTSA_ACCEPTED_POLICY_OIDS=1.2.40.0.36.1.1.8.1\n` });
    expect(ok.status, ok.out).toBe(0);
    const policy = run([], { ENV_BODY: "TSA_ACCEPTED_POLICY_OIDS=1.2.3.4\n" });
    expect(policy.status).toBe(3);
    expect(policy.out).toMatch(/does NOT include the policy GLOBALTRUST tokens carry \(1\.2\.40\.0\.36\.1\.1\.8\.1\)/);
  });

  it("the real defaults are the GLOBALTRUST 2015 root and its timestamp CA", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toContain("https://www.globaltrust.eu/static/globaltrust-2015.crt");
    expect(src).toContain("https://www.globaltrust.eu/static/all-stamm-cert.p7b");
    expect(src).toContain("416b1f9e84e74c1d19b23d8d7191c6ad81246e641601f599132729f507beb3cc");
    expect(src).toContain("945522340e54b7f2226be9e6272f18d2c3d6eca5a579764518dac7b0e0883fc9");
    expect(src).not.toMatch(/BEGIN CERTIFICATE-----\n[A-Za-z0-9+/]/);
  });
});
