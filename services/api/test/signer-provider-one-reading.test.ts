/**
 * CRYPTO-004 — every reader of SIGNER_PROVIDER takes the shared reading.
 * `aws_kms` read as local-pem in the startup validator, so a KMS deployment was
 * told to supply a PEM path, and the API and the console disagreed on one value.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { parseSignerProvider, readSignerProvider, signerProviderToken } from "@proovra/shared-runtime";
import { describe, expect, it } from "vitest";

import { collectStartupViolations } from "../src/config/index.js";

describe("the one reading", () => {
  it.each([
    [undefined, "local-pem", "local-pem", "local_pem"],
    ["", "local-pem", "local-pem", "local_pem"],
    ["local_pem", "local-pem", "local-pem", "local_pem"],
    ["AWS_KMS", "aws-kms", "aws-kms", "aws_kms"],
    [" aws-kms ", "aws-kms", "aws-kms", "aws_kms"],
    ["disabled", "disabled", "local-pem", "disabled"],
    ["hsm", "unknown", "local-pem", "local_pem"],
  ])("%j", (raw, full, signing, token) => {
    expect(readSignerProvider(raw)).toBe(full);
    expect(parseSignerProvider(raw)).toBe(signing);
    expect(signerProviderToken(raw)).toBe(token);
  });

  it("the startup validator accepts aws_kms as KMS, and asks for the key, not a PEM", () => {
    const saved = { ...process.env };
    try {
      process.env.NODE_ENV = "production";
      process.env.SIGNER_PROVIDER = "aws_kms";
      delete process.env.KMS_KEY_ID;
      delete process.env.SIGNING_PRIVATE_KEY_PATH;
      const reasons = collectStartupViolations().filter((v) => v.reason === "signing_provider_inconsistent");
      expect(reasons.map((v) => v.envName)).toEqual(["KMS_KEY_ID"]);
    } finally {
      process.env = saved;
    }
  });

  it("no service reads the variable by hand", () => {
    const roots = [new URL("../src", import.meta.url), new URL("../../worker/src", import.meta.url)];
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
      });
    const handRolled = roots
      .flatMap((root) => walk(root.pathname.replace(/^\/([A-Za-z]:)/, "$1")))
      .filter((file) => /SIGNER_PROVIDER\b[^\n]*\n?\s*\.trim\(\)/.test(readFileSync(file, "utf8")));
    expect(handRolled).toEqual([]);
  });
});
