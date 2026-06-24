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
 *   * JSZip is bundled via npm — no external CDN script, no SRI hash,
 *     no jsdelivr load. The verifier is ready as soon as the page
 *     hydrates.
 *
 * Phase 2026-06-25 — JSZip CDN removed and replaced with the local
 * `import JSZip from "jszip"` build. Tool card moved into the hero so
 * a reviewer can begin verification without scrolling. The verify()
 * algorithm + JSON result shape are byte-identical to the prior
 * implementation.
 */

import Link from "next/link";
import JSZip from "jszip";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ArrowRight,
  PackageCheck,
  ShieldCheck,
  Fingerprint,
  Clock3,
  FileBadge,
  Lock,
  Upload,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  FileText,
  ListChecks,
  Sparkles,
  Eye,
} from "lucide-react";
import { MarketingHeader } from "../../components/marketing/MarketingHeader";
import { EnterpriseFooter } from "../../components/marketing/EnterpriseFooter";
import { RevealSection } from "../../components/motion";
import { MARKETING_BTN } from "../../lib/marketing-buttons";

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

const LEGACY_PATHS = {
  tsaToken: "timestamp.tsr",
};

const ARTIFACT_PREFIXES = ["evidence/", "evidence-parts/"] as const;

function isArtifactPath(p: string): boolean {
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
  "HISTORICAL_VERIFICATION_DOES_NOT_IMPLY_CURRENT_TRUST",
  "CURRENT_REVOCATION_STATUS_NOT_CHECKED_OFFLINE",
  "SIGNER_MAY_HAVE_BEEN_ROTATED_OR_REVOKED_AFTER_SIGNING",
  "C2PA_DOES_NOT_PROVE_CONTENT_TRUTH",
  "C2PA_DOES_NOT_PROVE_LEGAL_ADMISSIBILITY",
  "C2PA_IS_NOT_A_REPLACEMENT_FOR_PROOVRA_CUSTODY",
  "MISSING_C2PA_DOES_NOT_REDUCE_PROOVRA_INTEGRITY",
  "INVALID_C2PA_DOES_NOT_OVERRIDE_PROOVRA_HASH_DECISION",
  "C2PA_VALIDATION_REQUIRES_TOOLING_NOT_BUNDLED_OFFLINE",
];

type ResultPayload = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OfflineVerifierPage() {
  return (
    <>
      <main className="bg-white" data-testid="offline-verifier-root">
        <HeroWithTool />
        <RevealSection direction="up">
          <HowLocalVerification />
        </RevealSection>
        <RevealSection direction="right">
          <WhatItChecks />
        </RevealSection>
        <RevealSection direction="left">
          <WhatItDoesNot />
        </RevealSection>
        <RevealSection direction="up">
          <PrivacyByDesign />
        </RevealSection>
        <RevealSection direction="left">
          <OfflineFinalCta />
        </RevealSection>
      </main>
      <EnterpriseFooter />
    </>
  );
}

// ---------------------------------------------------------------------------
// Final CTA — premium navy→violet enterprise panel sitting just above
// the footer. Mirrors the /verify final CTA layout so the two pages
// read as siblings. Primary scrolls to the hero upload card; secondary
// links to Public Verify.
// ---------------------------------------------------------------------------

function OfflineFinalCta() {
  return (
    <section
      data-testid="offline-final-cta"
      className="mx-auto max-w-[1320px] px-6 pb-16 pt-12 md:px-8 md:pb-20 md:pt-16"
    >
      <div
        className="relative overflow-hidden rounded-[28px] p-8 text-white shadow-[0_32px_80px_rgba(6,20,46,0.40)] md:p-12"
        style={{
          background:
            "linear-gradient(120deg,#06142E 0%,#123B7A 35%,#2563EB 70%,#7C3AED 100%)",
        }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 opacity-[0.10]"
          style={{
            backgroundImage:
              "radial-gradient(circle, #FFFFFF 1px, transparent 1px)",
            backgroundSize: "22px 22px",
            maskImage:
              "linear-gradient(180deg, transparent 0%, #000 100%)",
            WebkitMaskImage:
              "linear-gradient(180deg, transparent 0%, #000 100%)",
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -right-16 -top-16 h-72 w-72 rounded-full"
          style={{
            background:
              "radial-gradient(circle, rgba(219,39,119,0.22) 0%, transparent 70%)",
          }}
        />

        <div className="relative grid items-center gap-8 md:grid-cols-[1fr_auto] md:gap-10">
          <div>
            <h2 className="text-[1.6rem] font-semibold leading-[1.18] tracking-[-0.02em] text-white md:text-[2rem]">
              Verify a package independently.
            </h2>
            <p className="mt-3 max-w-[640px] text-[15px] leading-[1.7] text-white/85">
              Inspect a PROOVRA Verification Package locally in your browser,
              or use Public Verify to review a token-based verification record
              online.
            </p>
          </div>

          <div className="flex flex-wrap gap-3 md:flex-nowrap md:justify-end">
            <a
              href="#verifier"
              onClick={(e) => {
                e.preventDefault();
                const card = document.getElementById("verifier");
                if (!card) return;
                card.scrollIntoView({ behavior: "smooth", block: "start" });
                const input = card.querySelector<HTMLInputElement>(
                  'input[type="file"]',
                );
                if (input) {
                  window.setTimeout(() => input.click(), 220);
                }
              }}
              className="inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[14px] bg-white px-6 text-[14px] font-semibold text-[#0B1E3A] shadow-[0_10px_24px_rgba(0,0,0,0.28)] transition hover:-translate-y-0.5"
            >
              Choose verification package
              <ArrowRight size={14} />
            </a>
            <Link
              href="/verify"
              className="inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[14px] border border-white/40 bg-transparent px-6 text-[14px] font-semibold text-white transition hover:-translate-y-0.5 hover:bg-white/10"
            >
              Public Verify
              <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Hero with tool card — left copy, right verifier card
// ---------------------------------------------------------------------------

function HeroWithTool() {
  const TRUST_CHIPS = [
    "Local browser processing",
    "No account required",
    "Verification Package ZIP",
    "JSON result export",
  ];

  return (
    <section className="relative overflow-hidden bg-white">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0 bg-[url('/assets/hero/verify-hero.png')] bg-cover bg-center bg-no-repeat"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0 bg-white/20"
      />

      <div className="relative z-10">
        <MarketingHeader />

        <div
          className="mx-auto grid max-w-[1320px] gap-10 px-6 pb-14 pt-16 md:px-8 md:pb-16 md:pt-20 lg:grid-cols-[minmax(0,560px)_1fr] lg:items-start lg:gap-12 lg:pb-20 lg:pt-24"
          style={{ minHeight: "min(680px, calc(100vh - 96px))" }}
        >
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-[#DDE7F3] bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#2563EB] shadow-[0_2px_8px_rgba(37,99,235,0.06)]">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#2563EB]" />
              Offline Verifier
            </span>
            <h1 className="mt-5 max-w-[580px] text-[2rem] font-semibold leading-[1.06] tracking-[-0.028em] text-[#071326] md:text-[2.65rem] lg:text-[3rem]">
              Verify packages locally.{" "}
              <span
                className="bg-clip-text text-transparent"
                style={{
                  backgroundImage:
                    "linear-gradient(90deg,#2563EB 0%,#7C3AED 60%,#DB2777 100%)",
                }}
              >
                Without uploading evidence.
              </span>
            </h1>
            <p className="mt-5 max-w-[540px] text-[15.5px] leading-[1.7] text-[#526176]">
              Inspect a PROOVRA Verification Package directly in your browser.
              The selected ZIP is processed locally, so reviewers can check
              recorded integrity and package materials without signing in or
              sending the file to PROOVRA.
            </p>

            <div className="mt-6 flex flex-wrap gap-3">
              <a
                href="#verifier"
                onClick={(e) => {
                  e.preventDefault();
                  const card = document.getElementById("verifier");
                  if (card) {
                    card.scrollIntoView({ behavior: "smooth", block: "start" });
                    // Focus the file picker so the next keystroke / click
                    // is already pointed at the right control.
                    const input = card.querySelector<HTMLInputElement>(
                      'input[type="file"]',
                    );
                    if (input) {
                      window.setTimeout(() => input.click(), 220);
                    }
                  }
                }}
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-2xl bg-[#07132B] px-5 py-2.5 text-[14px] font-semibold text-white shadow-[0_12px_28px_rgba(7,19,43,0.22)] transition hover:bg-[#0B1E3A]"
              >
                Choose verification package
                <ArrowRight size={14} />
              </a>
              <Link href="/verify" className={MARKETING_BTN.heroSecondary}>
                Public Verify
                <ArrowRight size={14} />
              </Link>
            </div>

            <ul className="mt-6 flex max-w-[560px] flex-wrap gap-2">
              {TRUST_CHIPS.map((label) => (
                <li
                  key={label}
                  className="inline-flex items-center gap-2 rounded-full border border-[#DDE7F3] bg-white px-3 py-1.5 text-[12.5px] font-medium text-[#0F172A] shadow-[0_2px_8px_rgba(15,23,42,0.04)]"
                >
                  <CheckCircle2 size={13} strokeWidth={2.4} className="text-[#10A37F]" />
                  {label}
                </li>
              ))}
            </ul>
          </div>

          {/* Desktop-only top offset (~32px) so the upload card sits closer
              to the vertical center of the hero headline. Mobile and tablet
              keep their natural stacking — no extra top spacing there. */}
          <div className="lg:mt-8">
            <VerifierToolCard />
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Verifier Tool Card — interactive surface inside the hero column
// ---------------------------------------------------------------------------

function VerifierToolCard() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResultPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dropRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Drag-and-drop handler — uses the same DOM ref the surface renders into.
  useEffect(() => {
    const el = dropRef.current;
    if (!el) return;
    const stop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onDrop = (e: DragEvent) => {
      stop(e);
      const f = e.dataTransfer?.files?.[0];
      if (f) {
        setFile(f);
        setResult(null);
        setError(null);
      }
    };
    el.addEventListener("dragover", stop);
    el.addEventListener("dragenter", stop);
    el.addEventListener("drop", onDrop);
    return () => {
      el.removeEventListener("dragover", stop);
      el.removeEventListener("dragenter", stop);
      el.removeEventListener("drop", onDrop);
    };
  }, []);

  const onFileChange = useCallback((f: File | null) => {
    setFile(f);
    setResult(null);
    setError(null);
  }, []);

  const runVerify = useCallback(async () => {
    if (!file) {
      setError("no_file_selected");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await verify(file);
      setResult(r);
    } catch (err) {
      const name = (err as { name?: string })?.name ?? "verification_failed";
      setError(name);
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
    const stamp =
      typeof result.verifiedAtUtc === "string"
        ? String(result.verifiedAtUtc).replace(/[:.]/g, "-").slice(0, 19)
        : "result";
    a.download = `proovra-offline-verification-${stamp}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
  }, [result]);

  // Surface a friendly state string for the helper line. The actual
  // verify-button disabled gate is below, but this label tells the
  // user *why* a state is what it is — no more silent grey buttons.
  const stateLabel = useMemo(() => {
    if (busy) {
      return {
        kind: "loading",
        text: "Verifying package locally…",
      } as const;
    }
    if (!file) {
      return {
        kind: "empty",
        text: "Choose a PROOVRA Verification Package ZIP to begin.",
      } as const;
    }
    if (error === "no_file_selected") {
      return {
        kind: "warn",
        text: "Please choose a ZIP before verifying.",
      } as const;
    }
    if (error) {
      return {
        kind: "error",
        text:
          error === "verification_failed"
            ? "Could not read this ZIP. Confirm the file is a PROOVRA Verification Package and is not corrupted."
            : `Verification error: ${error}`,
      } as const;
    }
    if (result) {
      const status =
        ((result as { overall?: { status?: string } }).overall?.status) ?? "";
      if (status === "verified") {
        return {
          kind: "success",
          text: "Package verification completed.",
        } as const;
      }
      if (status === "failed") {
        return {
          kind: "error",
          text: "Package could not be verified.",
        } as const;
      }
      return {
        kind: "warn",
        text: "Package verified with warnings.",
      } as const;
    }
    return {
      kind: "ready",
      text: `Ready to verify ${file.name}.`,
    } as const;
  }, [busy, file, error, result]);

  const verifyDisabled = !file || busy;
  const downloadDisabled = !result;

  return (
    <div
      id="verifier"
      className="overflow-hidden rounded-[20px] border bg-white"
      style={{
        borderColor: "#DDE7F3",
        boxShadow: "0 28px 64px rgba(15, 23, 42, 0.12)",
      }}
    >
      <div className="px-5 pt-5 pb-4 md:px-6 md:pt-6">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex h-10 w-10 items-center justify-center rounded-[12px]"
            style={{
              background: "rgba(37,99,235,0.10)",
              border: "1px solid rgba(37,99,235,0.28)",
            }}
          >
            <PackageCheck size={18} strokeWidth={2} className="text-[#2563EB]" />
          </span>
          <div>
            <h2 className="text-[17px] font-semibold tracking-[-0.005em] text-[#07142F]">
              Offline package verifier
            </h2>
            <p className="text-[13px] text-[#526176]">
              Select a PROOVRA Verification Package ZIP to inspect locally.
            </p>
          </div>
        </div>
      </div>

      <div
        ref={dropRef}
        className="border-t px-5 py-4 md:px-6 md:py-5"
        style={{ borderColor: "#E5ECF5", background: "#FAFCFE" }}
      >
        <div
          className="flex items-center gap-3 rounded-[12px] border-2 border-dashed bg-white px-4 py-3"
          style={{ borderColor: "#C9D7EA" }}
        >
          <span
            aria-hidden
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
            style={{
              background: "rgba(37,99,235,0.10)",
              border: "1px solid rgba(37,99,235,0.28)",
            }}
          >
            <Upload size={14} strokeWidth={2} className="text-[#2563EB]" />
          </span>
          <div className="min-w-0 flex-1">
            {file ? (
              <>
                <div className="truncate text-[13px] font-semibold text-[#07142F]">
                  {file.name}
                </div>
                <div className="text-[11.5px] text-[#526176]">
                  {formatBytes(file.size)} · ready for local verification
                </div>
              </>
            ) : (
              <>
                <div className="text-[12.5px] font-semibold text-[#07142F]">
                  Drop your Verification Package ZIP
                </div>
                <div className="text-[11px] text-[#526176]">
                  or choose a file — stays on your device.
                </div>
              </>
            )}
          </div>
          {file ? (
            <button
              type="button"
              onClick={() => onFileChange(null)}
              className="shrink-0 text-[11.5px] font-semibold text-[#2563EB] hover:underline"
            >
              Remove
            </button>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="shrink-0 rounded-[10px] border-2 border-[#2563EB] bg-white px-3 py-1.5 text-[12.5px] font-semibold text-[#2563EB] transition hover:bg-[#EEF6FF]"
            >
              Choose ZIP
            </button>
          )}
          <input
            ref={fileInputRef}
            data-testid="file-input"
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            className="sr-only"
            onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
            aria-label="Select Verification Package ZIP"
          />
        </div>

        <div className="mt-4">
          <StatePill state={stateLabel.kind} text={stateLabel.text} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            data-testid="verify-button"
            onClick={runVerify}
            disabled={verifyDisabled}
            className="inline-flex items-center justify-center gap-2 rounded-[12px] px-5 py-2.5 text-[14px] font-semibold transition"
            style={
              verifyDisabled
                ? {
                    background: "#E5ECF5",
                    color: "#94A3B8",
                    cursor: "not-allowed",
                    border: "1px solid #DDE7F3",
                  }
                : {
                    background: "#07132B",
                    color: "#FFFFFF",
                    border: "1px solid #07132B",
                    boxShadow: "0 12px 28px rgba(7,19,43,0.22)",
                    cursor: "pointer",
                  }
            }
          >
            {busy ? "Verifying…" : "Verify package"}
          </button>
          <button
            type="button"
            data-testid="download-button"
            onClick={download}
            disabled={downloadDisabled}
            className="inline-flex items-center justify-center gap-2 rounded-[12px] px-5 py-2.5 text-[14px] font-semibold transition"
            style={
              downloadDisabled
                ? {
                    background: "#FFFFFF",
                    color: "#94A3B8",
                    cursor: "not-allowed",
                    border: "1px solid #E5ECF5",
                  }
                : {
                    background: "#FFFFFF",
                    color: "#0B1E3A",
                    border: "2px solid #2563EB",
                    cursor: "pointer",
                  }
            }
          >
            Download result JSON
          </button>
        </div>
        <p className="mt-3 text-[11.5px] text-[#64748B]">
          Download becomes available after verification.
        </p>
      </div>

      {result ? (
        <div className="border-t px-5 py-5 md:px-6 md:py-6" style={{ borderColor: "#E5ECF5" }}>
          <ResultRender result={result} />
        </div>
      ) : null}
    </div>
  );
}

function StatePill({
  state,
  text,
}: {
  state: "empty" | "ready" | "loading" | "success" | "warn" | "error";
  text: string;
}) {
  const palette: Record<
    typeof state,
    { bg: string; fg: string; border: string; Icon: React.ElementType }
  > = {
    empty: { bg: "#F1F5F9", fg: "#475569", border: "#E5ECF5", Icon: FileText },
    ready: { bg: "#EEF6FF", fg: "#1D4ED8", border: "#BFD7FF", Icon: ListChecks },
    loading: {
      bg: "#FEF3C7",
      fg: "#78350F",
      border: "#FDE68A",
      Icon: Sparkles,
    },
    success: {
      bg: "#ECFDF5",
      fg: "#065F46",
      border: "#A7F3D0",
      Icon: CheckCircle2,
    },
    warn: {
      bg: "#FEF3C7",
      fg: "#78350F",
      border: "#FDE68A",
      Icon: AlertTriangle,
    },
    error: { bg: "#FEF2F2", fg: "#7F1D1D", border: "#FECACA", Icon: XCircle },
  };
  const p = palette[state];
  const Icon = p.Icon;
  return (
    <div
      role="status"
      className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[13px] font-medium"
      style={{ background: p.bg, color: p.fg, border: `1px solid ${p.border}` }}
    >
      <Icon size={14} strokeWidth={2} />
      {text}
    </div>
  );
}

function formatBytes(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// Verification algorithm (inline; matches @proovra/offline-verifier)
// ---------------------------------------------------------------------------

async function verify(file: File): Promise<ResultPayload> {
  const zip = await JSZip.loadAsync(file);
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

  // TSA / OTS — accept canonical and legacy TSA token paths.
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
    isArtifactPath(f.path),
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
// Result render — enterprise card list with badges, no raw JSON wall.
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
    <div data-testid="result-card">
      <div className="flex flex-wrap items-center gap-3">
        <Badge status={r.overall.status} />
        <span className="text-[13.5px] font-mono text-[#475569]">
          {r.summary}
        </span>
      </div>

      <ResultBlock title="Package integrity" data={r.package} />
      <ResultBlock title="Artifact integrity" data={r.artifactIntegrity} />
      <ResultBlock title="Custody attestations" data={r.custodyAttestations} />
      <ResultBlock
        title="Historical verification (signing-time material)"
        data={r.historicalVerification}
      />

      <div
        data-testid="current-trust"
        className="mt-4 rounded-[12px] p-4"
        style={{
          background: "#FEF3C7",
          border: "1px solid #FDE68A",
          color: "#78350F",
        }}
      >
        <div className="flex items-center gap-2 text-[13.5px] font-semibold">
          Current trust status: <Badge status={r.currentTrustStatus.status} />
        </div>
        <p className="mt-1 text-[12.5px] leading-[1.55]">
          {r.currentTrustStatus.note}
        </p>
      </div>

      <ResultBlock title="Timestamping" data={r.timestamping} />

      <div
        data-testid="c2pa-panel"
        className="mt-4 rounded-[12px] p-4"
        style={{
          background: "#F8FAFC",
          border: "1px solid #E5ECF5",
          color: "#0F172A",
        }}
      >
        <div className="flex flex-wrap items-center gap-2 text-[13.5px] font-semibold">
          C2PA provenance: <Badge status={r.c2pa?.status ?? "missing"} />
          <span className="text-[12.5px] font-normal text-[#475569]">
            validation={r.c2pa?.validationStatus ?? "not_checked"} · items=
            {r.c2pa?.itemsChecked ?? 0} · mode={r.c2pa?.providerMode ?? "unknown"}
          </span>
        </div>
        <p className="mt-1 text-[12.5px] leading-[1.55] text-[#475569]">
          C2PA provenance is an interoperability signal. It does NOT determine
          factual truth, authorship, or legal admissibility. Missing or invalid
          C2PA does not by itself reduce PROOVRA&apos;s hash + custody integrity
          verdict.
        </p>
      </div>

      {r.overall.warnings.length > 0 ? (
        <div className="mt-4">
          <strong className="text-[12.5px] uppercase tracking-[0.16em] text-[#475569]">
            Warnings
          </strong>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {r.overall.warnings.map((w) => (
              <li
                key={w}
                className="rounded-md px-2 py-0.5 font-mono text-[11.5px]"
                style={{
                  background: "#FEF3C7",
                  color: "#78350F",
                  border: "1px solid #FDE68A",
                }}
              >
                {w}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {r.overall.limitations.length > 0 ? (
        <div className="mt-3">
          <strong className="text-[12.5px] uppercase tracking-[0.16em] text-[#475569]">
            Limitations
          </strong>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {r.overall.limitations.map((l) => (
              <li
                key={l}
                className="rounded-md px-2 py-0.5 font-mono text-[11.5px]"
                style={{
                  background: "#F1F5F9",
                  color: "#475569",
                  border: "1px solid #E5ECF5",
                }}
              >
                {l}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ResultBlock({
  title,
  data,
}: {
  title: string;
  data: Record<string, unknown>;
}) {
  const status = String(data.status ?? "—");
  return (
    <div
      className="mt-4 rounded-[12px] border bg-white p-4"
      style={{ borderColor: "#E5ECF5" }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13.5px] font-semibold text-[#07142F]">
          {title}
        </span>
        <Badge status={status} />
      </div>
      <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 md:grid-cols-2">
        {Object.entries(data)
          .filter(([k]) => k !== "status")
          .map(([k, v]) => (
            <div
              key={k}
              className="flex items-start justify-between gap-3 border-b py-1 text-[12.5px] last:border-b-0"
              style={{ borderColor: "#F1F5F9" }}
            >
              <dt className="font-mono text-[#64748B]">{k}</dt>
              <dd className="font-mono text-right text-[#0F172A]">
                {renderValue(v)}
              </dd>
            </div>
          ))}
      </dl>
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
      className="inline-block rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em]"
      style={{
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
      return { bg: "#ECFDF5", fg: "#065F46", border: "#A7F3D0" };
    case "failed":
    case "mismatch":
      return { bg: "#FEF2F2", fg: "#991B1B", border: "#FECACA" };
    case "partial":
    case "pending":
    case "unsupported":
    case "unknown":
      return { bg: "#FEF3C7", fg: "#78350F", border: "#FDE68A" };
    default:
      return { bg: "#F1F5F9", fg: "#475569", border: "#CBD5E1" };
  }
}

// ---------------------------------------------------------------------------
// Supporting sections — concise enterprise marketing surface.
// ---------------------------------------------------------------------------

const SECTION_BORDER = "#DDE7F3";
const SECTION_MUTED = "#526176";
const SECTION_INK = "#07142F";

function SectionEyebrow({ children, color = "#2563EB" }: { children: React.ReactNode; color?: string }) {
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em]"
      style={{ color, borderColor: SECTION_BORDER }}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {children}
    </span>
  );
}

function HowLocalVerification() {
  const STEPS = [
    { Icon: Upload, title: "Select package", body: "Choose a PROOVRA Verification Package ZIP from your device." },
    { Icon: FileText, title: "Inspect manifest", body: "The verifier reads the package manifest and structure schema." },
    { Icon: Fingerprint, title: "Check recorded hashes", body: "Files referenced in the manifest are hashed and compared against recorded SHA-256 values." },
    { Icon: ShieldCheck, title: "Review signatures and timestamps", body: "Where included: detached attestations, signer snapshots, TSA / OpenTimestamps materials." },
    { Icon: FileBadge, title: "Export result JSON", body: "Download the structured outcome with statuses, warnings, and standing limitations." },
  ];
  return (
    <section id="how-it-works" className="bg-white py-16 md:py-20">
      <div className="mx-auto max-w-[1200px] px-6 md:px-8">
        <div className="mx-auto flex max-w-[820px] flex-col items-center text-center">
          <SectionEyebrow>How it works</SectionEyebrow>
          <h2
            className="mt-3 text-[1.9rem] font-semibold leading-[1.12] tracking-[-0.02em] md:text-[2.2rem]"
            style={{ color: SECTION_INK }}
          >
            How local verification works.
          </h2>
          <p
            className="mt-3 max-w-[700px] text-[15px] leading-[1.7]"
            style={{ color: SECTION_MUTED }}
          >
            The verifier is a small browser routine. It opens the ZIP, walks
            recorded materials, and produces a structured result without
            contacting any PROOVRA service.
          </p>
        </div>

        <ol className="mx-auto mt-8 grid max-w-[1100px] gap-4 md:grid-cols-2 lg:grid-cols-5">
          {STEPS.map((s, i) => (
            <li
              key={s.title}
              className="rounded-[16px] border bg-white p-5"
              style={{
                borderColor: SECTION_BORDER,
                boxShadow: "0 8px 22px rgba(15,23,42,0.05)",
              }}
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="flex h-8 w-8 items-center justify-center rounded-full"
                  style={{
                    background: "rgba(37,99,235,0.10)",
                    border: "1px solid rgba(37,99,235,0.28)",
                  }}
                >
                  <s.Icon size={14} className="text-[#2563EB]" strokeWidth={2} />
                </span>
                <span
                  className="font-mono text-[12px] font-semibold text-[#2563EB]"
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
              </div>
              <h3 className="mt-3 text-[14.5px] font-semibold tracking-[-0.005em]" style={{ color: SECTION_INK }}>
                {s.title}
              </h3>
              <p className="mt-1 text-[13px] leading-[1.55]" style={{ color: SECTION_MUTED }}>
                {s.body}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function WhatItChecks() {
  const CARDS = [
    { Icon: FileText, title: "Package manifest", body: "Manifest presence, schema sanity, and structural completeness.", color: "#2563EB" },
    { Icon: Fingerprint, title: "File checksums", body: "Recorded SHA-256 entries compared against bytes inside the ZIP.", color: "#7C3AED" },
    { Icon: ShieldCheck, title: "Detached attestations", body: "Custody attestation file format, presence, and signer references.", color: "#10A37F" },
    { Icon: FileBadge, title: "Signer snapshot (where included)", body: "Historical signing-time verification material when bundled by the package.", color: "#F97316" },
    { Icon: Clock3, title: "TSA / OpenTimestamps (where included)", body: "Presence of RFC 3161 token and OTS proof material. External verification required to anchor.", color: "#DB2777" },
    { Icon: PackageCheck, title: "Package completeness", body: "Extra files, missing files, and degraded coverage reported as warnings.", color: "#2563EB" },
  ];
  return (
    <section className="bg-[#F7FAFC] py-16 md:py-20">
      <div className="mx-auto max-w-[1200px] px-6 md:px-8">
        <div className="mx-auto flex max-w-[820px] flex-col items-center text-center">
          <SectionEyebrow>What it checks</SectionEyebrow>
          <h2
            className="mt-3 text-[1.9rem] font-semibold leading-[1.12] tracking-[-0.02em] md:text-[2.2rem]"
            style={{ color: SECTION_INK }}
          >
            What the Offline Verifier checks.
          </h2>
        </div>
        <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {CARDS.map((c) => (
            <article
              key={c.title}
              className="rounded-[16px] border bg-white p-5"
              style={{
                borderColor: SECTION_BORDER,
                boxShadow: "0 8px 22px rgba(15,23,42,0.05)",
              }}
            >
              <span
                aria-hidden
                className="flex h-10 w-10 items-center justify-center rounded-[12px]"
                style={{ background: `${c.color}14`, border: `1px solid ${c.color}3D` }}
              >
                <c.Icon size={18} className="text-[var(--icon)]" style={{ color: c.color } as CSSProperties} strokeWidth={2} />
              </span>
              <h3
                className="mt-4 text-[15px] font-semibold tracking-[-0.005em]"
                style={{ color: SECTION_INK }}
              >
                {c.title}
              </h3>
              <p className="mt-2 text-[13.5px] leading-[1.6]" style={{ color: SECTION_MUTED }}>
                {c.body}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function WhatItDoesNot() {
  const BOUNDARY = [
    "Factual truth",
    "Authorship",
    "Identity",
    "Legal admissibility",
    "Evidentiary weight",
    "Real-world event occurrence",
  ];
  return (
    <section
      className="relative overflow-hidden py-16 md:py-20"
      style={{
        backgroundColor: "#07132B",
        backgroundImage: "url('/assets/cards/icon-card.png')",
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(90deg, rgba(7,19,43,0.88) 0%, rgba(7,19,43,0.78) 50%, rgba(7,19,43,0.68) 100%)",
        }}
      />
      <div className="relative mx-auto max-w-[1100px] px-6 md:px-8">
        <div className="grid gap-10 lg:grid-cols-[0.95fr_1.05fr] lg:items-start">
          <div>
            <span
              className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em]"
              style={{
                color: "#E2EBF8",
                borderColor: "rgba(255,255,255,0.20)",
                background: "rgba(255,255,255,0.06)",
              }}
            >
              <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: "#F8717A" }} />
              What it does not decide
            </span>
            <h2 className="mt-3 text-[1.9rem] font-semibold leading-[1.12] tracking-[-0.02em] text-white md:text-[2.2rem]">
              The Offline Verifier inspects materials.
              <br />
              It does not decide outcomes.
            </h2>
            <p
              className="mt-3 max-w-[520px] text-[15px] leading-[1.7]"
              style={{ color: "#D8E2F0" }}
            >
              The verifier reports the state of recorded package materials. It
              does not assert anything about the underlying event or content.
            </p>
          </div>
          <div
            className="rounded-[18px] border p-6"
            style={{
              background: "rgba(255,255,255,0.08)",
              borderColor: "rgba(255,255,255,0.16)",
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
              boxShadow: "0 24px 60px rgba(0,0,0,0.32)",
            }}
          >
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className="flex h-9 w-9 items-center justify-center rounded-[12px]"
                style={{
                  background: "rgba(248,113,122,0.18)",
                  border: "1px solid rgba(248,113,122,0.36)",
                }}
              >
                <AlertTriangle size={16} className="text-[#FCA5A5]" strokeWidth={2} />
              </span>
              <span className="text-[12.5px] font-semibold uppercase tracking-[0.18em] text-[#FCA5A5]">
                Out of scope
              </span>
            </div>
            <ul className="mt-4 grid gap-2 sm:grid-cols-2">
              {BOUNDARY.map((b) => (
                <li
                  key={b}
                  className="flex items-start gap-2 text-[14px]"
                  style={{ color: "#E2EBF8" }}
                >
                  <XCircle size={14} className="mt-0.5 shrink-0 text-[#FCA5A5]" strokeWidth={2.4} />
                  <span>{b}</span>
                </li>
              ))}
            </ul>
            <p
              className="mt-4 text-[12.5px] leading-[1.55]"
              style={{ color: "#C7D2E4" }}
            >
              Legal admissibility, court acceptance, and credibility are
              decisions for qualified reviewers and adjudicators — not for any
              automated verifier.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function PrivacyByDesign() {
  return (
    <section className="bg-[#F7FAFC] py-16 md:py-20">
      <div className="mx-auto max-w-[1100px] px-6 md:px-8">
        <div
          className="rounded-[20px] border bg-white p-7 md:p-9"
          style={{
            borderColor: SECTION_BORDER,
            boxShadow: "0 12px 32px rgba(15,23,42,0.06)",
          }}
        >
          <div className="grid gap-8 lg:grid-cols-[1fr_1fr] lg:items-center">
            <div>
              <SectionEyebrow color="#10A37F">Privacy</SectionEyebrow>
              <h2
                className="mt-3 text-[1.7rem] font-semibold leading-[1.18] tracking-[-0.015em] md:text-[2rem]"
                style={{ color: SECTION_INK }}
              >
                Privacy by design.
              </h2>
              <p className="mt-3 text-[15px] leading-[1.7]" style={{ color: SECTION_MUTED }}>
                The selected ZIP is read locally in the browser. PROOVRA does
                not receive the package during offline verification. The only
                network call this page initiates is the JSZip script load from
                the pinned CDN with Subresource Integrity.
              </p>
              <p className="mt-3 text-[13.5px] leading-[1.65]" style={{ color: SECTION_MUTED }}>
                You can confirm this in your browser&apos;s network panel: only
                static page assets and the JSZip script are requested. No
                upload of the ZIP is made.
              </p>
              <div className="mt-5 flex flex-wrap gap-3">
                <Link href="/trust" className={MARKETING_BTN.heroSecondary}>
                  Trust Center
                  <ArrowRight size={14} />
                </Link>
                <Link
                  href="/verify"
                  className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[#0B1E3A] px-5 py-2.5 text-[14px] font-semibold text-white transition hover:bg-[#091628]"
                >
                  Public Verify page
                  <ArrowRight size={14} />
                </Link>
              </div>
            </div>

            <ul className="grid gap-3">
              {[
                {
                  Icon: Lock,
                  title: "ZIP processed locally",
                  body: "All hashing, signature, and manifest checks run in your browser.",
                },
                {
                  Icon: ShieldCheck,
                  title: "No PROOVRA API calls",
                  body: "The offline verifier never contacts PROOVRA services.",
                },
                {
                  Icon: Eye,
                  title: "Observable in DevTools",
                  body: "Only the pinned JSZip script and page assets appear in the network panel.",
                },
              ].map((p) => (
                <li
                  key={p.title}
                  className="flex items-start gap-3 rounded-[14px] border bg-white p-4"
                  style={{ borderColor: SECTION_BORDER }}
                >
                  <span
                    aria-hidden
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px]"
                    style={{
                      background: "rgba(16,163,127,0.10)",
                      border: "1px solid rgba(16,163,127,0.28)",
                    }}
                  >
                    <p.Icon size={16} className="text-[#10A37F]" strokeWidth={2} />
                  </span>
                  <div>
                    <div className="text-[14px] font-semibold" style={{ color: SECTION_INK }}>
                      {p.title}
                    </div>
                    <div className="mt-0.5 text-[13px] leading-[1.55]" style={{ color: SECTION_MUTED }}>
                      {p.body}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
