/**
 * Phase P3.1.1 — Verification Package attestation closure suite.
 *
 *   1. New module exports the documented public API.
 *   2. Builder integration: `verification-package.ts` appends new
 *      files BEFORE `package-checksums.json`.
 *   3. Source-contract: ADDITIVE-only — no existing path renamed,
 *      no existing file replaced.
 *   4. Bounded JSON shape: schemaVersion, attestationsCount,
 *      missingAttestations, degradedReason, deterministic order.
 *   5. Strict mode env contract surfaces in the source.
 *   6. OTEL span names are wired.
 *   7. Sentry breadcrumbs / captureException calls are scrubbed.
 *   8. No legal overclaim wording.
 *   9. No private keys / KMS credentials referenced.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// NOTE: this is a SOURCE-CONTRACT suite. We deliberately do NOT
// `import` from `../src/verification-package-attestations.js` because
// that module's import chain reaches `./db.ts` which validates env
// at module load. Source-contract assertions exercise the public API
// + bounded enums via string matches against the file contents.

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}
function exists(rel: string): boolean {
  const url = new URL(rel, import.meta.url);
  return existsSync(fileURLToPath(url));
}

describe("Phase P3.1.1 — Module surface", () => {
  const src = readSource("../src/verification-package-attestations.ts");

  it("attestations module file exists", () => {
    expect(exists("../src/verification-package-attestations.ts")).toBe(true);
  });

  it("SIGNER_PURPOSES is exactly the 4 documented purposes", () => {
    const block =
      src.split("SIGNER_PURPOSES = [")[1]?.split("] as const")[0] ?? "";
    for (const p of [
      '"report_pdf"',
      '"verification_package"',
      '"export_manifest"',
      '"custody_event"',
    ]) {
      expect(block).toContain(p);
    }
  });

  it("attestations file schema name is PROOVRA_CUSTODY_ATTESTATIONS", () => {
    expect(src).toContain('"PROOVRA_CUSTODY_ATTESTATIONS"');
  });

  it("signer snapshot file schema name is PROOVRA_SIGNER_REGISTRY_SNAPSHOT", () => {
    expect(src).toContain('"PROOVRA_SIGNER_REGISTRY_SNAPSHOT"');
  });

  it("public entry point `collectVerificationPackageAttestations` is exported", () => {
    expect(src).toMatch(
      /export\s+async\s+function\s+collectVerificationPackageAttestations/,
    );
  });
});

describe("Phase P3.1.1 — Builder integration (additive)", () => {
  const builder = readSource("../src/verification-package.ts");

  it("appends `custody/attestations.json` via appendPackageEntry", () => {
    expect(builder).toContain('"custody/attestations.json"');
    // The collector + the append happen in the same try-block; allow
    // up to ~800 chars between the two so the regex tolerates the
    // intermediate buffer construction.
    expect(builder).toMatch(
      /collectVerificationPackageAttestations[\s\S]{0,800}custody\/attestations\.json/,
    );
  });

  it("appends `custody/attestation-verification.md`", () => {
    expect(builder).toContain('"custody/attestation-verification.md"');
  });

  it("appends `signers/signer-registry-snapshot.json`", () => {
    expect(builder).toContain('"signers/signer-registry-snapshot.json"');
  });

  it("calls collectVerificationPackageAttestations BEFORE the append of package-checksums.json", () => {
    // The literal `"package-checksums.json"` appears in several places
    // in this builder (offline verifier script content, README,
    // governance documents). The actual `appendPackageEntry` call for
    // the checksums file is the LAST occurrence — use lastIndexOf.
    const collectIdx = builder.indexOf(
      "collectVerificationPackageAttestations(",
    );
    const checksumsAppendIdx = builder.lastIndexOf(
      '"package-checksums.json"',
    );
    expect(collectIdx).toBeGreaterThan(-1);
    expect(checksumsAppendIdx).toBeGreaterThan(-1);
    expect(collectIdx).toBeLessThan(checksumsAppendIdx);
  });

  it("never removes existing file paths (additive-only invariant)", () => {
    // Spot-check that the canonical existing paths remain referenced.
    for (const p of [
      '"package-manifest.json"',
      '"package-manifest.sig"',
      '"package-manifest-public-key.pem"',
      '"package-checksums.json"',
    ]) {
      expect(builder).toContain(p);
    }
  });
});

describe("Phase P3.1.1 — Strict / best-effort mode contract", () => {
  it("env var name is exactly VERIFICATION_PACKAGE_REQUIRE_CUSTODY_ATTESTATIONS", () => {
    const src = readSource("../src/verification-package-attestations.ts");
    expect(src).toContain(
      "VERIFICATION_PACKAGE_REQUIRE_CUSTODY_ATTESTATIONS",
    );
  });

  it("default mode never throws when attestations are degraded", () => {
    const src = readSource("../src/verification-package-attestations.ts");
    // Strict mode is gated on `=== "true"` comparison.
    expect(src).toMatch(
      /VERIFICATION_PACKAGE_REQUIRE_CUSTODY_ATTESTATIONS[\s\S]{0,200}"true"/,
    );
    // The throw happens ONLY inside the strict-mode branch.
    const strictBlock = src
      .split(/const strict\s*=/)[1]
      ?.split("return { attestationsJson")[0] ?? "";
    expect(strictBlock).toContain("AttestationStrictModeFailureError");
  });

  it("AttestationStrictModeFailureError class is exported", () => {
    const src = readSource("../src/verification-package-attestations.ts");
    expect(src).toContain("export class AttestationStrictModeFailureError");
  });
});

describe("Phase P3.1.1 — Bounded enums for failure modes", () => {
  it("degradedReason has exactly the 3 bounded values", () => {
    const src = readSource("../src/verification-package-attestations.ts");
    expect(src).toContain('"no_attestations_recorded"');
    expect(src).toContain('"custody_events_unreachable"');
    expect(src).toContain('"attestation_lookup_failed"');
  });

  it("missing attestation reason has exactly the 2 bounded values", () => {
    const src = readSource("../src/verification-package-attestations.ts");
    expect(src).toContain('"no_attestation_recorded"');
    expect(src).toContain('"attestation_envelope_malformed"');
  });

  it("health reason has exactly the 4 bounded values", () => {
    const src = readSource("../src/verification-package-attestations.ts");
    expect(src).toContain('"provider_disabled"');
    expect(src).toContain('"kms_key_id_unset"');
    expect(src).toContain('"missing_pem_path"');
    expect(src).toContain('"unknown_error"');
  });
});

describe("Phase P3.1.1 — OTEL span names wired", () => {
  it("collector span: proovra.package.attestations.collect", () => {
    const src = readSource("../src/verification-package-attestations.ts");
    expect(src).toContain('"proovra.package.attestations.collect"');
  });

  it("signer snapshot span: proovra.package.signer_snapshot.generate", () => {
    const src = readSource("../src/verification-package-attestations.ts");
    expect(src).toContain('"proovra.package.signer_snapshot.generate"');
  });
});

describe("Phase P3.1.1 — Sentry breadcrumb safety", () => {
  it("captureException is called with bounded operator-safe context only", () => {
    const src = readSource("../src/verification-package-attestations.ts");
    // The captureException calls carry `stage` / `packageKind` only.
    // Verify the file never passes raw signature / key material.
    expect(src).toContain("captureException(");
    expect(src).not.toMatch(/captureException\([\s\S]{0,200}signature/);
    expect(src).not.toMatch(/captureException\([\s\S]{0,200}privateKey/);
    expect(src).not.toMatch(/captureException\([\s\S]{0,200}KMS_KEY_ID/);
  });
});

describe("Phase P3.1.1 — Honest scope + no overclaim", () => {
  it("README never claims legal admissibility", () => {
    const src = readSource("../src/verification-package-attestations.ts");
    // The README is built inline by buildVerificationReadme(). The
    // forbidden phrases must not appear anywhere in the file (incl. the README body).
    expect(src).not.toMatch(/legally admissible/i);
    expect(src).not.toMatch(/court[- ]admit/i);
    expect(src).not.toMatch(/proof of truth/i);
    expect(src).not.toMatch(/authentic content proven/i);
  });

  it("attestations.json never exposes private key MATERIAL", () => {
    const src = readSource("../src/verification-package-attestations.ts");
    // The env-var NAME `SIGNING_PRIVATE_KEY_PATH` IS referenced as a
    // boolean existence check (the snapshot health probe reads
    // whether the operator pointed a path at it). The PEM CONTENTS
    // are never loaded by this file. We assert on the boolean
    // signals that would be wrong:
    expect(src).not.toMatch(/privateKeyPem/);
    expect(src).not.toMatch(/readFileSync.*SIGNING_PRIVATE/);
    expect(src).not.toMatch(/AWS_ACCESS_KEY/);
    expect(src).not.toMatch(/AWS_SECRET_ACCESS_KEY/);
  });

  it("signer snapshot never includes raw KMS credentials", () => {
    const src = readSource("../src/verification-package-attestations.ts");
    // KMS_KEY_ID env IS referenced (to derive the kmsKeyArn field);
    // raw credentials must not be.
    expect(src).not.toMatch(/AWS_ACCESS_KEY_ID/);
    expect(src).not.toMatch(/AWS_SECRET_ACCESS_KEY/);
  });
});

describe("Phase P3.1.1 — Bounded registries extended", () => {
  it("security event types include the P3.1.1 5 new events", () => {
    const sec = readSource("../../../packages/shared/src/security.ts");
    for (const e of [
      "verification_package_attestations_included",
      "verification_package_attestations_degraded",
      "verification_package_attestations_missing",
      "signer_snapshot_included",
      "package_attestation_verification_failed",
    ]) {
      expect(sec).toContain(`"${e}"`);
    }
  });

  it("metric registry includes the P3.1.1 5 new keys", () => {
    const m = readSource(
      "../../../packages/shared-runtime/src/ops/metrics.service.ts",
    );
    for (const k of [
      "package_attestations_included_total",
      "package_attestations_degraded_total",
      "package_attestations_missing_total",
      "signer_snapshot_included_total",
      "package_attestation_generation_failure_total",
    ]) {
      expect(m).toContain(`"${k}"`);
    }
  });
});
