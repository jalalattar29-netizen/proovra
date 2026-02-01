import canonicalize from "canonicalize";
import { createHash, sign } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function sha256Hex(data: Buffer | string): string {
  const h = createHash("sha256");
  h.update(data);
  return h.digest("hex");
}

export function canonicalJson(obj: unknown): string {
  const s = canonicalize(obj);
  if (!s) throw new Error("Failed to canonicalize JSON");
  return s;
}

export function loadPemFromPathEnv(envName: string): string {
  const p = must(envName);
  const abs = resolve(process.cwd(), p);
  return readFileSync(abs, "utf8").trim() + "\n";
}

export function ed25519SignHexWithKeyPath(
  messageHex: string,
  privateKeyPathEnv: string
): string {
  const privateKeyPem = loadPemFromPathEnv(privateKeyPathEnv);
  const msg = Buffer.from(messageHex, "hex");
  const sig = sign(null, msg, privateKeyPem);
  return sig.toString("base64");
}
