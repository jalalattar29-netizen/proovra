"use client";

/**
 * Phase M1.1 — Public mount of the PROOVRA Offline Verifier.
 *
 * Canonical route: `/offline-verifier`.
 *
 * Hard contract:
 *   * NO authentication required.
 *   * NO PROOVRA API calls.
 *   * The selected ZIP is NEVER uploaded.
 *   * Verification runs entirely in the browser.
 *   * The only network call this page makes is the JSZip script
 *     load via CDN with Subresource Integrity.
 *
 * The verifier algorithm here is a self-contained port of the same
 * bounded algorithm shipped by `@proovra/offline-verifier`. The
 * stand-alone static page at `apps/offline-verifier/index.html`
 * remains the canonical operator-self-hostable artifact; this page
 * adds the convenience of a no-install browser link.
 *
 * Phase M1.1 additions:
 *   * Reads `signers/historical-verification-material.json` when
 *     present and reports `historicalVerification`.
 *   * ALWAYS surfaces `currentTrustStatus="unknown"`.
 *   * Explicit copy distinguishing "verified against historical
 *     signing material" from current signer trust.
 *
 * The page uses a small inline algorithm (no bundler import of the
 * npm package) so it stays static-deployment safe and tree-shakes
 * cleanly.
 */

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Bounded enums (must match `packages/offline-verifier/src/result-schema.ts`)
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = "PROOVRA_OFFLINE_VERIFICATION_RESULT_V1";

const PATHS = {
  checksums: "package-checksums.json",
  manifest: "package-manifest.json",
  manifestSig: "package-manifest.sig",
  manifestPublicKey: "package-manifest-public-key.pem",
  custodyAttestations: "custody/attestations.json",
  signerSnapshot: "signers/signer-registry-snapshot.json",
  historicalMaterial: "signers/historical-verification-material.json",
  tsaToken: "timestamps/tsa.tsr",
  otsProof: "opentimestamps-proof.ots",
  otsJson: "opentimestamps.json",
  // Phase M2
  c2paSummary: "provenance/c2pa-summary.json",
};

const STANDING_LIMITATIONS = [
  "NO_LEGAL_ADMISSIBILITY_CLAIM",
  "NO_AUTHORSHIP_CLAIM",
  "TSA_REQUIRES_EXTERNAL_RFC3161_VERIFICATION",
  "OTS_REQUIRES_BITCOIN_NETWORK",
  "HISTORICAL_VERIFICATION_DOES_NOT_IMPLY_CURRENT_TRUST",
  "CURRENT_REVOCATION_STATUS_NOT_CHECKED_OFFLINE",
  "SIGNER_MAY_HAVE_BEEN_ROTATED_OR_REVOKED_AFTER_SIGNING",
  // Phase M2 — C2PA standing distinctions.
  "C2PA_DOES_NOT_PROVE_CONTENT_TRUTH",
  "C2PA_DOES_NOT_PROVE_LEGAL_ADMISSIBILITY",
  "C2PA_IS_NOT_A_REPLACEMENT_FOR_PROOVRA_CUSTODY",
  "MISSING_C2PA_DOES_NOT_REDUCE_PROOVRA_INTEGRITY",
  "INVALID_C2PA_DOES_NOT_OVERRIDE_PROOVRA_HASH_DECISION",
  "C2PA_VALIDATION_REQUIRES_TOOLING_NOT_BUNDLED_OFFLINE",
];

// JSZip pinned CDN + SRI hash. The hash MUST match the URL.
const JSZIP_SRC = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
const JSZIP_INTEGRITY =
  "sha384-WgK1mPZsqlOLwsoEXAh51U1RsftbHzdJWNm3OK21NLkkBcwzbLaXLR7pe5wuyKlA";

declare global {
  // eslint-disable-next-line no-var
  var JSZip: undefined | { loadAsync: (file: Blob) => Promise<JsZipInstance> };
}
type JsZipInstance = {
  files: Record<string, { dir: boolean }>;
  file(name: string): null | { async: (kind: "uint8array") => Promise<Uint8Array> };
};

type ResultPayload = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function OfflineVerifierPage() {
  const [jszipReady, setJszipReady] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResultPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dropRef = useRef<HTMLDivElement | null>(null);

  // Lazy-detect JSZip after the Script tag loads.
  useEffect(() => {
    const t = setInterval(() => {
      if (typeof window !== "undefined" && window.JSZip) {
        setJszipReady(true);
        clearInterval(t);
      }
    }, 100);
    return () => clearInterval(t);
  }, []);

  // Drag-and-drop handler.
  useEffect(() => {
    const el = dropRef.current;
    if (!el) return;
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const f = e.dataTransfer?.files?.[0];
      if (f) setFile(f);
    };
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("drop", onDrop);
    return () => {
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("drop", onDrop);
    };
  }, []);

  const runVerify = useCallback(async () => {
    if (!file || !window.JSZip) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await verify(file);
      setResult(r);
    } catch (err) {
      setError((err as { name?: string })?.name ?? "verification_failed");
    } finally {
      setBusy(false);
    }
  }, [file]);

  const download = useCallback(() => {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "proovra-offline-verification-result.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
  }, [result]);

  return (
    <>
      <Script
        src={JSZIP_SRC}
        integrity={JSZIP_INTEGRITY}
        crossOrigin="anonymous"
        referrerPolicy="no-referrer"
        strategy="afterInteractive"
      />
      <main
        data-testid="offline-verifier-root"
        style={{
          minHeight: "100vh",
          background: "#f8fafc",
          color: "#0f172a",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        <div style={{ maxWidth: 880, margin: "0 auto", padding: 24 }}>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>
            PROOVRA Offline Verifier
          </h1>
          <p
            style={{
              marginTop: 4,
              color: "#475569",
              fontSize: 13,
            }}
            data-testid="subtitle"
          >
            Bounded, third-party-runnable verification of PROOVRA Verification
            Packages. No login required.
          </p>

          <div
            data-testid="privacy-notice"
            style={{
              marginTop: 12,
              padding: 12,
              background: "#fff",
              border: "1px solid #e2e8f0",
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            <strong>Privacy:</strong> Verification runs locally in your
            browser. The selected ZIP is{" "}
            <strong>never uploaded to PROOVRA</strong>. No data is sent to
            PROOVRA or any third party. You can confirm this by watching
            your browser&apos;s Network tab — only the JSZip script tag
            loads from the CDN; nothing else.
          </div>

          <section
            ref={dropRef}
            style={{
              marginTop: 12,
              padding: 16,
              background: "#fff",
              border: "1px dashed #cbd5e1",
              borderRadius: 8,
              textAlign: "center",
            }}
          >
            <div
              style={{
                display: "flex",
                gap: 12,
                alignItems: "center",
                justifyContent: "center",
                flexWrap: "wrap",
              }}
            >
              <input
                data-testid="file-input"
                type="file"
                accept=".zip"
                onChange={(e) =>
                  setFile(e.target.files?.[0] ?? null)
                }
                aria-label="Select Verification Package ZIP"
              />
              <button
                data-testid="verify-button"
                type="button"
                disabled={!file || !jszipReady || busy}
                onClick={runVerify}
                style={btnPrimary}
              >
                {busy ? "Verifying…" : "Verify package"}
              </button>
              <button
                data-testid="download-button"
                type="button"
                disabled={!result}
                onClick={download}
                style={btnGhost}
              >
                Download result JSON
              </button>
            </div>
            <p style={{ marginTop: 8, color: "#64748b", fontSize: 12 }}>
              Drag and drop a ZIP here, or use the file picker.
              {!jszipReady ? " (Loading JSZip…)" : null}
            </p>
          </section>

          {error ? (
            <div
              data-testid="error-box"
              style={{
                marginTop: 12,
                padding: 10,
                background: "#fef2f2",
                color: "#7f1d1d",
                border: "1px solid #fecaca",
                borderRadius: 6,
                fontSize: 13,
              }}
            >
              {error === "verification_failed"
                ? "Could not read this ZIP. Confirm the file is a PROOVRA Verification Package and is not corrupted."
                : error}
            </div>
          ) : null}

          {result ? <ResultRender result={result} /> : null}

          <section
            style={{
              marginTop: 12,
              padding: 12,
              background: "#fff",
              border: "1px solid #e2e8f0",
              borderRadius: 6,
              fontSize: 12,
              color: "#475569",
            }}
          >
            <strong>Bounded scope.</strong>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              <li>
                Verifies: checksum integrity, package manifest sanity, presence
                of detached attestations + signer snapshot, presence of TSA /
                OTS material, and{" "}
                <strong>historical signing-time signer material</strong> when
                the package carries{" "}
                <code>signers/historical-verification-material.json</code>.
              </li>
              <li>
                Does NOT claim legal admissibility, authorship, or current
                signer trust. Current signer revocation status cannot be
                determined offline.
              </li>
              <li>
                Historical verification ≠ current signer trust. The
                signer may have been rotated or revoked after this package
                was generated.
              </li>
            </ul>
          </section>
        </div>
      </main>
    </>
  );
}

// ---------------------------------------------------------------------------
// Verification algorithm (inline; matches @proovra/offline-verifier)
// ---------------------------------------------------------------------------

async function verify(file: File): Promise<ResultPayload> {
  const zip = await window.JSZip!.loadAsync(file);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const reader = {
    listFiles() {
      return [...names].sort();
    },
    async readBytes(path: string): Promise<Uint8Array | null> {
      const f = zip.file(path);
      if (!f) return null;
      return await f.async("uint8array");
    },
    async readText(path: string): Promise<string | null> {
      const b = await this.readBytes(path);
      if (!b) return null;
      if (b.byteLength > 32 * 1024 * 1024) return null;
      return new TextDecoder("utf-8").decode(b);
    },
  };
  const warnings: string[] = [];
  const limitations = [...STANDING_LIMITATIONS];

  // Checksums
  const checksumsText = await reader.readText(PATHS.checksums);
  let parsedIndex: { files?: Array<{ path: string; sha256: string }> } | null = null;
  let checksumsStatus = "unsupported";
  let filesIndexed = 0;
  let extraFiles = 0;
  const checksumFailures: Array<{ path: string; reason: string }> = [];
  if (!checksumsText) {
    checksumsStatus = "missing_index";
    warnings.push("PACKAGE_MANIFEST_MISSING");
  } else {
    try {
      parsedIndex = JSON.parse(checksumsText);
    } catch {
      checksumsStatus = "unsupported";
    }
    if (parsedIndex && Array.isArray(parsedIndex.files)) {
      filesIndexed = parsedIndex.files.length;
      let ok = true;
      const indexedSet = new Set<string>();
      for (const e of parsedIndex.files) {
        indexedSet.add(e.path);
        if (e.path === PATHS.checksums) continue;
        const bytes = await reader.readBytes(e.path);
        if (!bytes) {
          ok = false;
          checksumFailures.push({ path: e.path, reason: "missing" });
          warnings.push("CHECKSUMS_MISSING_FILE");
          continue;
        }
        const actual = await sha256Hex(bytes);
        if (actual.toLowerCase() !== String(e.sha256).toLowerCase()) {
          ok = false;
          checksumFailures.push({ path: e.path, reason: "sha256_mismatch" });
        }
      }
      for (const n of names) {
        if (!indexedSet.has(n) && n !== PATHS.checksums) extraFiles++;
      }
      if (extraFiles > 0) warnings.push("EXTRA_FILES_NOT_IN_CHECKSUMS");
      checksumsStatus = ok ? "verified" : "mismatch";
    }
  }

  // Manifest
  const manifestText = await reader.readText(PATHS.manifest);
  let manifestStatus = "missing";
  if (manifestText) {
    try {
      const p = JSON.parse(manifestText);
      manifestStatus =
        p && typeof p === "object" && !Array.isArray(p) ? "verified" : "schema_invalid";
    } catch {
      manifestStatus = "schema_invalid";
    }
  } else {
    warnings.push("PACKAGE_MANIFEST_MISSING");
  }

  // Package signature (best-effort; WebCrypto Ed25519 is recent + not universal)
  let signatureStatus = "missing";
  const sigText = await reader.readText(PATHS.manifestSig);
  const pubPem = await reader.readText(PATHS.manifestPublicKey);
  const manifestBytes = await reader.readBytes(PATHS.manifest);
  if (!sigText) {
    warnings.push("PACKAGE_SIGNATURE_MISSING");
  } else if (!pubPem) {
    warnings.push("PACKAGE_PUBLIC_KEY_MISSING");
    signatureStatus = "unsupported";
  } else if (!manifestBytes) {
    signatureStatus = "unsupported";
  } else {
    try {
      const env = JSON.parse(sigText);
      const sha = await sha256Hex(manifestBytes);
      if (env.manifestSha256 && sha.toLowerCase() !== String(env.manifestSha256).toLowerCase()) {
        signatureStatus = "failed";
      } else if (env.signatureBase64) {
        const v = await verifyEd25519(pubPem, sha, env.signatureBase64);
        signatureStatus = v === null ? "unsupported" : v ? "verified" : "failed";
        if (v === null) limitations.push("AWS_KMS_SIGNATURE_REQUIRES_PUBLIC_KEY");
      } else {
        signatureStatus = "unsupported";
      }
    } catch {
      signatureStatus = "unsupported";
    }
  }

  // Custody attestations + signer snapshot
  const attestationsText = await reader.readText(PATHS.custodyAttestations);
  const snapshotText = await reader.readText(PATHS.signerSnapshot);
  let custody: ResultPayload = {
    status: "missing",
    attestationsExpected: 0,
    attestationsChecked: 0,
    attestationsVerified: 0,
    failures: [],
    canonicalPayloadRecomputeAvailable: false,
  };
  if (!attestationsText) {
    warnings.push("ATTESTATIONS_FILE_MISSING");
    warnings.push("PRE_P3_1_1_PACKAGE_DETECTED");
  } else {
    if (!snapshotText) warnings.push("SIGNER_SNAPSHOT_MISSING");
    limitations.push(
      "VERIFIER_CANNOT_RECOMPUTE_CANONICAL_PAYLOAD_WITHOUT_CUSTODY_EVENT_DATA",
    );
    try {
      const p = JSON.parse(attestationsText);
      const arr = p.attestations ?? [];
      const missing = p.missingAttestations ?? [];
      if (p.degradedReason) warnings.push("ATTESTATIONS_DEGRADED");
      if (missing.length > 0) warnings.push("ATTESTATIONS_PARTIAL_COVERAGE");
      let ok = 0;
      const failures: Array<{ custodyEventId: string; reason: string }> = [];
      for (const a of arr) {
        if (
          typeof a.custodyEventId !== "string" ||
          typeof a.canonicalPayloadHash !== "string" ||
          typeof a.signature !== "string" ||
          (a.provider !== "aws_kms" && a.provider !== "local_pem")
        ) {
          failures.push({
            custodyEventId:
              typeof a.custodyEventId === "string" ? a.custodyEventId : "<malformed>",
            reason: "signature_invalid",
          });
          continue;
        }
        if (a.provider === "aws_kms" && a.algorithm !== "ED25519_SHA_512") {
          failures.push({
            custodyEventId: a.custodyEventId,
            reason: "unsupported_algorithm",
          });
          continue;
        }
        if (a.provider === "local_pem" && a.algorithm !== "ED25519") {
          failures.push({
            custodyEventId: a.custodyEventId,
            reason: "unsupported_algorithm",
          });
          continue;
        }
        ok++;
      }
      let status: string;
      if (arr.length === 0) status = "missing";
      else if (failures.length > 0 && failures.length === arr.length)
        status = "failed";
      else if (
        failures.length === 0 &&
        missing.length === 0 &&
        p.degradedReason == null
      )
        status = "unsupported";
      else status = "partial";
      custody = {
        status,
        attestationsExpected: arr.length + missing.length,
        attestationsChecked: arr.length,
        attestationsVerified: ok,
        failures,
        canonicalPayloadRecomputeAvailable: false,
      };
    } catch {
      custody = { ...custody, status: "unsupported" };
    }
  }

  // Historical verification material (M1.1)
  const historicalText = await reader.readText(PATHS.historicalMaterial);
  let historical: ResultPayload;
  if (!historicalText) {
    warnings.push("HISTORICAL_VERIFICATION_MATERIAL_MISSING");
    historical = {
      status: "missing",
      materialEntriesBundled: 0,
      materialEntriesVerifiable: 0,
    };
  } else {
    try {
      const p = JSON.parse(historicalText);
      const entries: Array<{
        algorithm?: string;
        verificationMaterialType?: string;
        verificationMaterial?: { publicKeyPem?: string };
      }> = p.signers ?? [];
      const bundled = entries.length;
      let verifiable = 0;
      let unsupportedAlgo = 0;
      for (const e of entries) {
        const pem = e.verificationMaterial?.publicKeyPem ?? null;
        const supportedAlgo =
          e.algorithm === "ED25519" || e.algorithm === "ED25519_SHA_512";
        if (!pem || !supportedAlgo) {
          if (pem && !supportedAlgo) unsupportedAlgo++;
          continue;
        }
        if (
          e.verificationMaterialType === "ed25519_spki_pem" ||
          e.verificationMaterialType === "kms_public_key_pem"
        ) {
          verifiable++;
        }
      }
      if (unsupportedAlgo > 0) {
        warnings.push("HISTORICAL_VERIFICATION_UNSUPPORTED_ALGORITHM");
      }
      if (verifiable < bundled) {
        warnings.push("HISTORICAL_VERIFICATION_PARTIAL_COVERAGE");
      }
      let status: string;
      if (bundled === 0) status = "unsupported";
      else if (verifiable === bundled) status = "verified";
      else if (verifiable === 0) status = "unsupported";
      else status = "partial";
      historical = {
        status,
        materialEntriesBundled: bundled,
        materialEntriesVerifiable: verifiable,
      };
    } catch {
      historical = {
        status: "unsupported",
        materialEntriesBundled: 0,
        materialEntriesVerifiable: 0,
      };
    }
  }

  // TSA / OTS
  const tsaToken = await reader.readBytes(PATHS.tsaToken);
  let tsaStatus = "missing";
  let tsaDetail = "missing";
  if (tsaToken && tsaToken.byteLength > 0) {
    tsaStatus = "unsupported";
    tsaDetail = "rfc3161_external_verification_required";
  } else {
    warnings.push("TSA_PROOF_MISSING");
  }
  const otsProof = await reader.readBytes(PATHS.otsProof);
  let otsStatus = "missing";
  let otsDetail = "missing";
  if (otsProof && otsProof.byteLength > 0) {
    const otsJson = await reader.readText(PATHS.otsJson);
    let companion: string | null = null;
    if (otsJson) {
      try {
        companion = String(JSON.parse(otsJson).status ?? "").toLowerCase();
      } catch {
        companion = null;
      }
    }
    if (companion === "pending") {
      otsStatus = "pending";
      otsDetail = "pending";
    } else {
      otsStatus = "unsupported";
      otsDetail = "calendar_network_required";
    }
  } else {
    warnings.push("OTS_PROOF_MISSING");
  }

  // Phase M2 — C2PA provenance summary
  type C2paBlock = {
    status: string;
    validationStatus: string;
    itemsChecked: number;
    providerMode: string;
  };
  let c2pa: C2paBlock = {
    status: "missing",
    validationStatus: "not_checked",
    itemsChecked: 0,
    providerMode: "unknown",
  };
  const c2paText = await reader.readText(PATHS.c2paSummary);
  if (!c2paText) {
    warnings.push("C2PA_SUMMARY_FILE_MISSING");
  } else {
    try {
      const parsedC2pa = JSON.parse(c2paText) as {
        aggregateStatus?: string;
        aggregateValidationStatus?: string;
        itemsChecked?: number;
        providerMode?: string;
        files?: ReadonlyArray<unknown>;
      };
      const allowedStatus = [
        "not_present",
        "present",
        "valid",
        "invalid",
        "unsupported",
        "disabled",
        "error",
      ];
      const allowedValidation = [
        "not_checked",
        "valid",
        "invalid",
        "unsupported",
        "error",
      ];
      const allowedProvider = [
        "disabled",
        "detect_only",
        "validate",
        "embed_supported",
      ];
      const status =
        parsedC2pa.aggregateStatus &&
        allowedStatus.includes(parsedC2pa.aggregateStatus)
          ? parsedC2pa.aggregateStatus
          : "error";
      const validationStatus =
        parsedC2pa.aggregateValidationStatus &&
        allowedValidation.includes(parsedC2pa.aggregateValidationStatus)
          ? parsedC2pa.aggregateValidationStatus
          : "error";
      const itemsChecked = Number.isInteger(parsedC2pa.itemsChecked)
        ? Math.max(0, Number(parsedC2pa.itemsChecked))
        : Array.isArray(parsedC2pa.files)
          ? parsedC2pa.files.length
          : 0;
      const providerMode =
        parsedC2pa.providerMode &&
        allowedProvider.includes(parsedC2pa.providerMode)
          ? parsedC2pa.providerMode
          : "unknown";
      c2pa = { status, validationStatus, itemsChecked, providerMode };
      if (status === "invalid") {
        warnings.push("C2PA_PROVIDER_REPORTED_INVALID_MANIFEST");
      } else if (status === "error") {
        warnings.push("C2PA_PROVIDER_REPORTED_EXTRACTION_ERROR");
      }
    } catch {
      warnings.push("C2PA_SUMMARY_SCHEMA_INVALID");
      c2pa = {
        status: "error",
        validationStatus: "error",
        itemsChecked: 0,
        providerMode: "unknown",
      };
    }
  }

  // Package + overall aggregation
  let packageStatus;
  if (checksumsStatus === "verified" && manifestStatus === "verified") {
    if (signatureStatus === "verified") packageStatus = "verified";
    else if (signatureStatus === "failed") packageStatus = "failed";
    else packageStatus = "partial";
  } else if (checksumsStatus === "mismatch" || manifestStatus === "schema_invalid") {
    packageStatus = "failed";
  } else if (
    checksumsStatus === "missing_index" &&
    manifestStatus === "missing"
  ) {
    packageStatus = "unsupported";
  } else {
    packageStatus = "partial";
  }

  const evidenceList = (parsedIndex?.files ?? []).filter((f) =>
    f.path.startsWith("evidence/"),
  );
  let artifactStatus = "unsupported";
  const artifactFailures: Array<{ path: string; reason: string }> = [];
  if (parsedIndex) {
    if (evidenceList.length === 0) {
      artifactStatus = "missing";
      warnings.push("ARTIFACT_HASH_MISSING_FROM_PACKAGE");
    } else {
      const failedSet = new Set(checksumFailures.map((f) => f.path));
      let anyFail = false;
      for (const f of evidenceList) {
        if (failedSet.has(f.path)) {
          anyFail = true;
          artifactFailures.push({ path: f.path, reason: "sha256_mismatch" });
        }
      }
      artifactStatus = anyFail ? "failed" : "verified";
    }
  }

  let overall;
  if (packageStatus === "failed" || artifactStatus === "failed") {
    overall = "failed";
  } else if (
    packageStatus === "verified" &&
    (custody.status === "verified" || custody.status === "missing")
  ) {
    overall = custody.status === "missing" ? "partial" : "verified";
  } else {
    overall = "partial";
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    verifiedAtUtc: new Date().toISOString(),
    summary:
      `package=${packageStatus}; artifact=${artifactStatus}; custody_attestations=${custody.status}; ` +
      `historical_verification=${historical.status}; current_trust=unknown; tsa=${tsaStatus}; ots=${otsStatus}`,
    package: {
      status: packageStatus,
      checksumsStatus,
      manifestStatus,
      signatureStatus,
      filesIndexed,
      extraFiles,
      checksumFailures,
    },
    artifactIntegrity: {
      status: artifactStatus,
      itemsChecked: evidenceList.length,
      failures: artifactFailures,
    },
    reportSignature: {
      status: evidenceList.some((f) => f.path.endsWith(".pdf"))
        ? "unsupported"
        : signatureStatus === "verified"
          ? "unsupported"
          : "missing",
      detail: evidenceList.some((f) => f.path.endsWith(".pdf"))
        ? "embedded_pdf_signature_external_tool_required"
        : signatureStatus === "verified"
          ? "package_manifest_signature_verified_separately"
          : "missing",
    },
    custodyAttestations: custody,
    timestamping: { tsaStatus, otsStatus, tsaDetail, otsDetail },
    historicalVerification: historical,
    currentTrustStatus: {
      status: "unknown",
      note:
        "The offline verifier does not contact PROOVRA. Current signer trust / revocation status cannot be determined here. Consult /operations/signers on the live PROOVRA deployment for current state.",
    },
    c2pa,
    overall: {
      status: overall,
      warnings: dedupe(warnings),
      limitations: dedupe(limitations),
    },
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  const arr = new Uint8Array(buf);
  let out = "";
  for (const b of arr) out += b.toString(16).padStart(2, "0");
  return out;
}
async function verifyEd25519(
  pubPem: string,
  messageHex: string,
  signatureBase64: string,
): Promise<boolean | null> {
  if (!("subtle" in crypto)) return null;
  try {
    const der = pemToDer(pubPem);
    const key = await crypto.subtle.importKey(
      "spki",
      der as unknown as ArrayBuffer,
      { name: "Ed25519" } as unknown as AlgorithmIdentifier,
      false,
      ["verify"],
    );
    const message = hexToBytes(messageHex);
    const signature = base64ToBytes(signatureBase64);
    return await crypto.subtle.verify(
      "Ed25519" as unknown as AlgorithmIdentifier,
      key,
      signature as unknown as ArrayBuffer,
      message as unknown as ArrayBuffer,
    );
  } catch {
    return null;
  }
}
function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  return base64ToBytes(body);
}
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}
function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

// ---------------------------------------------------------------------------
// Result render
// ---------------------------------------------------------------------------

function ResultRender({ result }: { result: ResultPayload }) {
  const r = result as {
    summary: string;
    overall: { status: string; warnings: string[]; limitations: string[] };
    package: Record<string, unknown>;
    artifactIntegrity: Record<string, unknown>;
    custodyAttestations: Record<string, unknown>;
    historicalVerification: Record<string, unknown>;
    currentTrustStatus: { status: string; note: string };
    timestamping: Record<string, unknown>;
    c2pa?: {
      status: string;
      validationStatus: string;
      itemsChecked: number;
      providerMode: string;
    };
  };
  return (
    <section
      data-testid="result-card"
      style={{
        marginTop: 12,
        padding: 16,
        background: "#fff",
        border: "1px solid #e2e8f0",
        borderRadius: 8,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Badge status={r.overall.status} />
        <span style={{ color: "#475569", fontSize: 13 }}>{r.summary}</span>
      </div>
      <Section
        title="Package integrity"
        data={r.package as Record<string, unknown>}
      />
      <Section title="Artifact integrity" data={r.artifactIntegrity} />
      <Section title="Custody attestations" data={r.custodyAttestations} />
      <Section
        title="Historical verification (signing-time material)"
        data={r.historicalVerification}
      />
      <div
        data-testid="current-trust"
        style={{
          marginTop: 12,
          padding: 10,
          background: "#fef3c7",
          border: "1px solid #fde68a",
          borderRadius: 6,
          fontSize: 13,
          color: "#78350f",
        }}
      >
        <strong>Current trust status:</strong>{" "}
        <Badge status={r.currentTrustStatus.status} />
        <p style={{ margin: "6px 0 0" }}>{r.currentTrustStatus.note}</p>
      </div>
      <Section title="Timestamping" data={r.timestamping} />
      {/* Phase M2 — C2PA provenance panel. Separate from PROOVRA core
          integrity by design. Never elevates overall, never overrides
          hash/custody. */}
      <div
        data-testid="c2pa-panel"
        style={{
          marginTop: 12,
          padding: 10,
          background: "#f8fafc",
          border: "1px solid #e2e8f0",
          borderRadius: 6,
          fontSize: 13,
          color: "#0f172a",
        }}
      >
        <strong>C2PA provenance:</strong>{" "}
        <Badge status={r.c2pa?.status ?? "missing"} />{" "}
        <span style={{ color: "#475569", marginLeft: 6 }}>
          validation={r.c2pa?.validationStatus ?? "not_checked"} ·
          items={r.c2pa?.itemsChecked ?? 0} · mode=
          {r.c2pa?.providerMode ?? "unknown"}
        </span>
        <p style={{ margin: "6px 0 0", color: "#475569" }}>
          C2PA provenance is an interoperability signal. It does NOT
          determine factual truth, authorship, or legal admissibility.
          Missing or invalid C2PA does not by itself reduce
          PROOVRA&apos;s hash + custody integrity verdict.
        </p>
      </div>
      {r.overall.warnings.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <strong style={{ fontSize: 12 }}>Warnings</strong>
          <ul style={{ margin: 4, paddingLeft: 18, fontSize: 12 }}>
            {r.overall.warnings.map((w) => (
              <li key={w}>
                <code>{w}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {r.overall.limitations.length > 0 ? (
        <div style={{ marginTop: 8 }}>
          <strong style={{ fontSize: 12 }}>Limitations</strong>
          <ul style={{ margin: 4, paddingLeft: 18, fontSize: 12 }}>
            {r.overall.limitations.map((l) => (
              <li key={l}>
                <code>{l}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function Section({
  title,
  data,
}: {
  title: string;
  data: Record<string, unknown>;
}) {
  return (
    <div style={{ marginTop: 12 }}>
      <strong style={{ fontSize: 13 }}>{title}</strong>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 12,
          marginTop: 4,
        }}
      >
        <tbody>
          {Object.entries(data).map(([k, v]) => (
            <tr key={k}>
              <td
                style={{
                  padding: "4px 8px",
                  borderBottom: "1px solid #f1f5f9",
                  color: "#475569",
                  verticalAlign: "top",
                }}
              >
                {k}
              </td>
              <td
                style={{
                  padding: "4px 8px",
                  borderBottom: "1px solid #f1f5f9",
                }}
              >
                {renderValue(v)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  return JSON.stringify(v);
}

function Badge({ status }: { status: string }) {
  const palette = badgePalette(status);
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 10,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: 0.3,
        background: palette.bg,
        color: palette.fg,
        border: `1px solid ${palette.border}`,
      }}
    >
      {status}
    </span>
  );
}

function badgePalette(status: string): { bg: string; fg: string; border: string } {
  switch (status) {
    case "verified":
      return { bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" };
    case "failed":
    case "mismatch":
      return { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" };
    case "partial":
    case "pending":
    case "unsupported":
    case "unknown":
      return { bg: "#fef3c7", fg: "#78350f", border: "#fde68a" };
    default:
      return { bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" };
  }
}

const btnPrimary: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: 12,
  fontWeight: 600,
  background: "#1e293b",
  color: "#fff",
  border: "1px solid #1e293b",
  borderRadius: 6,
  cursor: "pointer",
};
const btnGhost: React.CSSProperties = {
  ...btnPrimary,
  background: "#fff",
  color: "#0f172a",
  borderColor: "#cbd5e1",
};
