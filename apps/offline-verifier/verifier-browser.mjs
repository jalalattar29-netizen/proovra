/**
 * PROOVRA Offline Verifier — browser entry.
 *
 * Reads a user-selected ZIP via JSZip, computes SHA-256 with WebCrypto,
 * and applies the same bounded result schema as the Node CLI.
 *
 * Hard rules enforced in this file:
 *   * The selected ZIP is NEVER POSTed anywhere. The only network
 *     call this page makes is the JSZip script tag at load time.
 *   * No telemetry, no analytics, no fetch() calls beyond the
 *     JSZip script.
 *   * Bounded enums everywhere — strings come from a fixed set.
 */

const SCHEMA_VERSION = "PROOVRA_OFFLINE_VERIFICATION_RESULT_V1";

const PATHS = {
  checksums: "package-checksums.json",
  manifest: "package-manifest.json",
  manifestSig: "package-manifest.sig",
  manifestPublicKey: "package-manifest-public-key.pem",
  custodyAttestations: "custody/attestations.json",
  signerSnapshot: "signers/signer-registry-snapshot.json",
  tsaToken: "timestamps/tsa.tsr",
  otsProof: "opentimestamps-proof.ots",
  otsJson: "opentimestamps.json",
};

const LEGACY_PATHS = {
  tsaToken: "timestamp.tsr",
};

const ARTIFACT_PREFIXES = ["evidence/", "evidence-parts/"];

function isArtifactPath(p) {
  for (const prefix of ARTIFACT_PREFIXES) {
    if (p.startsWith(prefix)) return true;
  }
  return false;
}

const STANDING_LIMITATIONS = [
  "NO_LEGAL_ADMISSIBILITY_CLAIM",
  "NO_AUTHORSHIP_CLAIM",
  "TSA_REQUIRES_EXTERNAL_RFC3161_VERIFICATION",
  "OTS_REQUIRES_BITCOIN_NETWORK",
];

const els = {
  zipInput: document.getElementById("zip-input"),
  verifyBtn: document.getElementById("verify-btn"),
  downloadBtn: document.getElementById("download-btn"),
  resultCard: document.getElementById("result-card"),
  overall: document.getElementById("overall"),
  sections: document.getElementById("sections"),
};

let selectedFile = null;
let lastResult = null;

els.zipInput.addEventListener("change", () => {
  selectedFile = els.zipInput.files?.[0] ?? null;
  els.verifyBtn.disabled = !selectedFile;
});

els.verifyBtn.addEventListener("click", async () => {
  if (!selectedFile) return;
  els.verifyBtn.disabled = true;
  els.verifyBtn.textContent = "Verifying…";
  try {
    lastResult = await verify(selectedFile);
    render(lastResult);
    els.downloadBtn.disabled = false;
  } catch (err) {
    els.overall.innerHTML =
      '<span class="badge badge-fail">FAIL</span>' +
      ` <span class="muted">Could not read ZIP: ${escapeHtml(
        (err && err.name) || "unknown",
      )}</span>`;
    els.sections.innerHTML = "";
    els.resultCard.style.display = "";
  } finally {
    els.verifyBtn.disabled = false;
    els.verifyBtn.textContent = "Verify package";
  }
});

els.downloadBtn.addEventListener("click", () => {
  if (!lastResult) return;
  const blob = new Blob([JSON.stringify(lastResult, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "proovra-offline-verification-result.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
});

async function verify(file) {
  const zip = await window.JSZip.loadAsync(file);
  const reader = makeReader(zip);
  const warnings = [];
  const limitations = [...STANDING_LIMITATIONS];

  // -----------------------------------------------------------------
  // Checksums
  // -----------------------------------------------------------------
  const checksumsText = await reader.readText(PATHS.checksums);
  let filesIndexed = 0;
  let extraFiles = 0;
  let checksumsStatus = "unsupported";
  const checksumFailures = [];
  let parsedIndex = null;
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
      let allMatched = true;
      const indexedSet = new Set();
      for (const e of parsedIndex.files) {
        indexedSet.add(e.path);
        if (e.path === PATHS.checksums) continue;
        const bytes = await reader.readBytes(e.path);
        if (bytes === null) {
          allMatched = false;
          checksumFailures.push({ path: e.path, reason: "missing" });
          warnings.push("CHECKSUMS_MISSING_FILE");
          continue;
        }
        const actual = await sha256Hex(bytes);
        if (actual.toLowerCase() !== String(e.sha256).toLowerCase()) {
          allMatched = false;
          checksumFailures.push({
            path: e.path,
            reason: "sha256_mismatch",
          });
        }
      }
      const filesInZip = await reader.listFiles();
      for (const f of filesInZip) {
        if (!indexedSet.has(f) && f !== PATHS.checksums) extraFiles++;
      }
      if (extraFiles > 0) warnings.push("EXTRA_FILES_NOT_IN_CHECKSUMS");
      checksumsStatus = allMatched ? "verified" : "mismatch";
    }
  }

  // -----------------------------------------------------------------
  // Manifest
  // -----------------------------------------------------------------
  const manifestText = await reader.readText(PATHS.manifest);
  let manifestStatus = "missing";
  if (manifestText) {
    try {
      const parsed = JSON.parse(manifestText);
      manifestStatus =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? "verified"
          : "schema_invalid";
    } catch {
      manifestStatus = "schema_invalid";
    }
  } else {
    warnings.push("PACKAGE_MANIFEST_MISSING");
  }

  // -----------------------------------------------------------------
  // Package signature — Ed25519 via WebCrypto when available
  // -----------------------------------------------------------------
  let signatureStatus = "missing";
  const sigText = await reader.readText(PATHS.manifestSig);
  const publicKeyPem = await reader.readText(PATHS.manifestPublicKey);
  const manifestBytes = await reader.readBytes(PATHS.manifest);
  if (!sigText) {
    warnings.push("PACKAGE_SIGNATURE_MISSING");
  } else if (!publicKeyPem) {
    warnings.push("PACKAGE_PUBLIC_KEY_MISSING");
    signatureStatus = "unsupported";
  } else if (!manifestBytes) {
    signatureStatus = "unsupported";
  } else {
    try {
      const env = JSON.parse(sigText);
      const sha = await sha256Hex(manifestBytes);
      if (
        env.manifestSha256 &&
        sha.toLowerCase() !== String(env.manifestSha256).toLowerCase()
      ) {
        signatureStatus = "failed";
      } else if (env.signatureBase64) {
        const verified = await verifyEd25519(
          publicKeyPem,
          sha,
          env.signatureBase64,
        );
        signatureStatus =
          verified === null ? "unsupported" : verified ? "verified" : "failed";
        if (verified === null) {
          limitations.push("AWS_KMS_SIGNATURE_REQUIRES_PUBLIC_KEY");
        }
      } else {
        signatureStatus = "unsupported";
      }
    } catch {
      signatureStatus = "unsupported";
    }
  }

  // -----------------------------------------------------------------
  // Custody attestations + signer snapshot (P3.1.1)
  // -----------------------------------------------------------------
  const attestationsText = await reader.readText(PATHS.custodyAttestations);
  const snapshotText = await reader.readText(PATHS.signerSnapshot);
  let custody = {
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
      const parsed = JSON.parse(attestationsText);
      const arr = parsed.attestations ?? [];
      const missing = parsed.missingAttestations ?? [];
      if (parsed.degradedReason) warnings.push("ATTESTATIONS_DEGRADED");
      if (missing.length > 0) warnings.push("ATTESTATIONS_PARTIAL_COVERAGE");
      let structurallyOk = 0;
      const failures = [];
      for (const a of arr) {
        if (
          typeof a.custodyEventId !== "string" ||
          typeof a.canonicalPayloadHash !== "string" ||
          typeof a.signature !== "string" ||
          (a.provider !== "aws_kms" && a.provider !== "local_pem")
        ) {
          failures.push({
            custodyEventId:
              typeof a.custodyEventId === "string"
                ? a.custodyEventId
                : "<malformed>",
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
        structurallyOk++;
      }
      let status;
      if (arr.length === 0) status = "missing";
      else if (failures.length > 0 && failures.length === arr.length) status = "failed";
      else if (
        failures.length === 0 &&
        missing.length === 0 &&
        parsed.degradedReason == null
      )
        status = "unsupported";
      else status = "partial";
      custody = {
        status,
        attestationsExpected: arr.length + missing.length,
        attestationsChecked: arr.length,
        attestationsVerified: structurallyOk,
        failures,
        canonicalPayloadRecomputeAvailable: false,
      };
    } catch {
      custody = { ...custody, status: "unsupported" };
    }
  }

  // -----------------------------------------------------------------
  // TSA + OTS
  // -----------------------------------------------------------------
  let tsaToken = await reader.readBytes(PATHS.tsaToken);
  if (!tsaToken || tsaToken.byteLength === 0) {
    tsaToken = await reader.readBytes(LEGACY_PATHS.tsaToken);
  }
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
    let companion = null;
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

  // -----------------------------------------------------------------
  // Aggregate
  // -----------------------------------------------------------------
  let packageStatus;
  if (checksumsStatus === "verified" && manifestStatus === "verified") {
    if (signatureStatus === "verified") packageStatus = "verified";
    else if (signatureStatus === "failed") packageStatus = "failed";
    else packageStatus = "partial";
  } else if (
    checksumsStatus === "mismatch" ||
    manifestStatus === "schema_invalid"
  ) {
    packageStatus = "failed";
  } else if (checksumsStatus === "missing_index" && manifestStatus === "missing") {
    packageStatus = "unsupported";
  } else {
    packageStatus = "partial";
  }

  const evidenceList = (parsedIndex?.files ?? []).filter((f) =>
    isArtifactPath(f.path),
  );
  let artifactStatus = "unsupported";
  const artifactFailures = [];
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
          artifactFailures.push({
            path: f.path,
            reason: "sha256_mismatch",
          });
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
      `package=${packageStatus}; artifact=${artifactStatus}; ` +
      `custody_attestations=${custody.status}; tsa=${tsaStatus}; ots=${otsStatus}`,
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
    overall: {
      status: overall,
      warnings: dedupe(warnings),
      limitations: dedupe(limitations),
    },
  };
}

function makeReader(zip) {
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  return {
    async listFiles() {
      return [...names].sort();
    },
    async readBytes(path) {
      const f = zip.file(path);
      if (!f) return null;
      const blob = await f.async("uint8array");
      return blob;
    },
    async readText(path) {
      const bytes = await this.readBytes(path);
      if (!bytes) return null;
      if (bytes.byteLength > 32 * 1024 * 1024) return null;
      return new TextDecoder("utf-8").decode(bytes);
    },
  };
}

async function sha256Hex(bytes) {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  const arr = new Uint8Array(buf);
  let out = "";
  for (const b of arr) out += b.toString(16).padStart(2, "0");
  return out;
}

async function verifyEd25519(pubPem, messageHex, signatureBase64) {
  if (!("subtle" in crypto)) return null;
  try {
    // Strip the PEM header/footer + decode base64.
    const der = pemToDer(pubPem);
    const key = await crypto.subtle.importKey(
      "spki",
      der,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const message = hexToBytes(messageHex);
    const signature = base64ToBytes(signatureBase64);
    return await crypto.subtle.verify("Ed25519", key, signature, message);
  } catch {
    // Most browsers don't yet ship Ed25519 in WebCrypto. We return
    // null so the verifier reports `unsupported`.
    return null;
  }
}

function pemToDer(pem) {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  return base64ToBytes(body);
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function hexToBytes(hex) {
  if (hex.length % 2 !== 0) throw new Error("odd hex length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}
function dedupe(arr) {
  return Array.from(new Set(arr));
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function render(r) {
  els.resultCard.style.display = "";
  els.overall.innerHTML =
    `<span class="badge ${badge(r.overall.status)}">${r.overall.status}</span> ` +
    `<span class="muted" style="margin-left:8px">${escapeHtml(r.summary)}</span>`;
  els.sections.innerHTML = "";
  els.sections.appendChild(
    table("Package", [
      ["status", `<span class="badge ${badge(r.package.status)}">${r.package.status}</span>`],
      ["checksums", badgeRow(r.package.checksumsStatus)],
      ["manifest", badgeRow(r.package.manifestStatus)],
      ["signature", badgeRow(r.package.signatureStatus)],
      ["files indexed", r.package.filesIndexed],
      ["extra files (not in checksums)", r.package.extraFiles],
    ]),
  );
  if (r.package.checksumFailures.length > 0) {
    els.sections.appendChild(
      list(
        "Checksum failures",
        r.package.checksumFailures.map((f) => `${escapeHtml(f.path)} — ${f.reason}`),
      ),
    );
  }
  els.sections.appendChild(
    table("Artifact integrity", [
      ["status", badgeRow(r.artifactIntegrity.status)],
      ["items checked", r.artifactIntegrity.itemsChecked],
    ]),
  );
  els.sections.appendChild(
    table("Report signature", [
      ["status", badgeRow(r.reportSignature.status)],
      ["detail", `<code>${escapeHtml(r.reportSignature.detail ?? "")}</code>`],
    ]),
  );
  els.sections.appendChild(
    table("Custody attestations", [
      ["status", badgeRow(r.custodyAttestations.status)],
      ["expected", r.custodyAttestations.attestationsExpected],
      ["checked", r.custodyAttestations.attestationsChecked],
      ["structurally ok", r.custodyAttestations.attestationsVerified],
    ]),
  );
  els.sections.appendChild(
    table("Timestamping", [
      [
        "TSA",
        `${badgeRow(r.timestamping.tsaStatus)} <code>${escapeHtml(
          r.timestamping.tsaDetail ?? "",
        )}</code>`,
      ],
      [
        "OTS",
        `${badgeRow(r.timestamping.otsStatus)} <code>${escapeHtml(
          r.timestamping.otsDetail ?? "",
        )}</code>`,
      ],
    ]),
  );
  if (r.overall.warnings.length > 0) {
    els.sections.appendChild(list("Warnings", r.overall.warnings));
  }
  if (r.overall.limitations.length > 0) {
    els.sections.appendChild(list("Limitations", r.overall.limitations));
  }
}

function badge(status) {
  if (status === "verified") return "badge-ok";
  if (status === "failed" || status === "mismatch") return "badge-fail";
  if (
    status === "partial" ||
    status === "pending" ||
    status === "unsupported"
  )
    return "badge-warn";
  return "badge-neutral";
}
function badgeRow(status) {
  return `<span class="badge ${badge(status)}">${escapeHtml(status)}</span>`;
}
function table(title, rows) {
  const wrap = document.createElement("div");
  wrap.style.marginTop = "12px";
  wrap.innerHTML = `<h4 style="margin:0 0 4px;font-size:13px">${escapeHtml(
    title,
  )}</h4><table><tbody>${rows
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${v}</td></tr>`)
    .join("")}</tbody></table>`;
  return wrap;
}
function list(title, items) {
  const wrap = document.createElement("div");
  wrap.style.marginTop = "12px";
  wrap.innerHTML = `<h4 style="margin:0 0 4px;font-size:13px">${escapeHtml(
    title,
  )}</h4><ul style="margin:0;padding-left:18px;font-size:12px">${items
    .map((i) => `<li><code>${escapeHtml(i)}</code></li>`)
    .join("")}</ul>`;
  return wrap;
}
