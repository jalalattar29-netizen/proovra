import canonicalize from "canonicalize";
import { createHash, sign, verify } from "crypto";
import { existsSync, readFileSync, statSync } from "fs";
import { isAbsolute, resolve } from "path";

function must(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`${name} is not set`);
  }
  return v.trim();
}

function resolveExistingFilePath(rawPath: string): string {
  const absolutePath = isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath);

  if (!existsSync(absolutePath)) {
    throw new Error(`Key file not found: ${absolutePath}`);
  }

  const stats = statSync(absolutePath);
  if (!stats.isFile()) {
    throw new Error(`Key path is not a file: ${absolutePath}`);
  }

  return absolutePath;
}

export function sha256Hex(data: Buffer | string): string {
  const h = createHash("sha256");
  h.update(data);
  return h.digest("hex");
}

export function canonicalJson(obj: unknown): string {
  const s = canonicalize(obj);
  if (!s) {
    throw new Error("Failed to canonicalize JSON");
  }
  return s;
}

export function loadPemFromPathEnv(envName: string): string {
  const configuredPath = must(envName);
  const absolutePath = resolveExistingFilePath(configuredPath);
  const pem = readFileSync(absolutePath, "utf8").trim();

  if (!pem.includes("BEGIN") || !pem.includes("END")) {
    throw new Error(`Invalid PEM content in ${envName}`);
  }

  return `${pem}\n`;
}

export function ed25519SignHexWithKeyPath(
  messageHex: string,
  privateKeyPathEnv: string
): string {
  const normalizedHex = messageHex.trim().toLowerCase();

  if (!/^[a-f0-9]+$/.test(normalizedHex) || normalizedHex.length % 2 !== 0) {
    throw new Error("ed25519SignHexWithKeyPath: messageHex must be valid hex");
  }

  const privateKeyPem = loadPemFromPathEnv(privateKeyPathEnv);
  const msg = Buffer.from(normalizedHex, "hex");
  const sig = sign(null, msg, privateKeyPem);

  return sig.toString("base64");
}

export function ed25519VerifyHexSignature(params: {
  messageHex: string;
  signatureBase64: string;
  publicKeyPem: string;
}): boolean {
  const normalizedHex = params.messageHex.trim().toLowerCase();

  if (!/^[a-f0-9]+$/.test(normalizedHex) || normalizedHex.length % 2 !== 0) {
    throw new Error("ed25519VerifyHexSignature: messageHex must be valid hex");
  }

  const publicKeyPem = params.publicKeyPem.trim();
  if (!publicKeyPem.includes("BEGIN") || !publicKeyPem.includes("END")) {
    throw new Error("ed25519VerifyHexSignature: publicKeyPem is invalid");
  }

  const msg = Buffer.from(normalizedHex, "hex");
  const sig = Buffer.from(params.signatureBase64, "base64");

  return verify(null, msg, `${publicKeyPem}\n`, sig);
}