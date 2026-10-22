/**
 * EXTERNAL_DISCLOSURE covers TEXT documents too (2026-10-12).
 *
 * The field policy (@proovra/shared disclosure-profile) used to be applied to
 * JSON entries only, so README.txt, the certification templates and the
 * custody attestation note went out verbatim — any email address, network
 * address, presigned URL or ARN they carried left the workspace. Every text
 * entry now passes through projectTextForDisclosure; signatures and keys are
 * material, never text to redact. The policy itself is behaviour-tested in
 * packages/shared/tests/disclosure-and-tsa-record.test.mjs; this pins the one
 * place every entry is appended (createVerificationPackage needs live
 * governance state to run end to end; the updated-report journey builds real
 * EXTERNAL packages).
 */
import { readFileSync } from "node:fs";

import { projectTextForDisclosure } from "@proovra/shared";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../src/verification-package.ts", import.meta.url), "utf8");
const appendEntry = src.slice(src.indexOf("const appendEntry = (name: string"), src.indexOf("const evidenceFiles = selectPackageEvidenceFiles(data);"));

describe("the package's one append point projects text for the external profile", () => {
  it("text/plain and text/markdown entries go through projectTextForDisclosure, recorded in the disclosure manifest", () => {
    expect(appendEntry).toMatch(/contentType === "text\/plain" \|\| contentType === "text\/markdown"/);
    // F-14 closure: text entries take the record's location decision and coordinates too.
    expect(appendEntry).toContain(
      'projectTextForDisclosure(profile, name, buffer.toString("utf8"), {\n            recordedLocationDisclosed: data.recordedLocationDisclosed === true,\n            recordedCoordinates: data.recordedCoordinates,',
    );
    expect(appendEntry).toContain("disclosureRecords.push(...projected.records);");
  });

  it("signatures and keys are never projected", () => {
    expect(appendEntry).toContain('NEVER_PROJECTED_TEXT.has(name) && !/\\.(pem|sig)$/.test(name)');
    expect(src).toContain('const NEVER_PROJECTED_TEXT = new Set(["signature.txt"]);');
  });

  it("a README with an address, a presigned URL and an ARN loses all three in the external profile only", () => {
    const readme = "Owner: a.person@example.test\nFetched https://b.s3.amazonaws.com/k?X-Amz-Signature=x from 192.0.2.10\narn:aws:kms:eu-central-1:123456789012:key/k";
    expect(projectTextForDisclosure("FULL_FORENSIC", "README.txt", readme).value).toBe(readme);
    const ext = projectTextForDisclosure("EXTERNAL_DISCLOSURE", "README.txt", readme).value;
    expect(ext).not.toMatch(/a\.person@|X-Amz|192\.0\.2\.10|123456789012/);
  });
});

describe("no package, in any profile, carries secret material (the sealed-package gate)", () => {
  it("presigned URLs, cloud keys, private keys and passworded connection strings are recognised; public material is not", async () => {
    const { SECRET_MATERIAL } = await import("../src/output-verification.js");
    const carries = (text: string) => SECRET_MATERIAL.filter((s) => s.pattern.test(text)).map((s) => s.name);
    expect(carries("https://b.s3.amazonaws.com/k?X-Amz-Credential=x&X-Amz-Signature=y")).toContain("a presigned URL");
    expect(carries("key AKIAIOSFODNN7EXAMPLE")).toContain("a cloud access key id");
    expect(carries("aws_secret_access_key = x")).toContain("a cloud secret key");
    expect(carries("-----BEGIN PRIVATE KEY-----\nMC4C\n-----END PRIVATE KEY-----")).toContain("a private key");
    expect(carries("postgresql://user:hunter2@db:5432/proovra")).toContain("a connection string with a password");
    // Verification material is not secret: a public key, a digest, a verify link.
    expect(carries("-----BEGIN PUBLIC KEY-----\nMCow\n-----END PUBLIC KEY-----")).toEqual([]);
    expect(carries(`sha256 ${"a".repeat(64)} https://app.proovra.example/verify/abc`)).toEqual([]);
  });

  it("the gate runs over every text entry of the sealed ZIP", () => {
    const gate = readFileSync(new URL("../src/output-verification.ts", import.meta.url), "utf8");
    const body = gate.slice(gate.indexOf("export async function assertStagedPackage"));
    expect(body.indexOf("SECRET_MATERIAL.find")).toBeGreaterThan(0);
    expect(body.indexOf("SECRET_MATERIAL.find")).toBeLessThan(body.indexOf("verifySealedPackageEntries("));
  });
});
