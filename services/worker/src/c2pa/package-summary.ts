/**
 * PROOVRA C2PA — Verification Package summary builder.
 *
 * Phase M2.
 *
 * Called from `verification-package.ts` to assemble the bounded
 * `provenance/c2pa-summary.json` payload that ships inside every
 * Verification Package generated under M2+.
 *
 * Strategy:
 *   * If the Evidence row already carries a previously-computed
 *     `verificationPackageMetadata.c2pa` summary (from worker-side
 *     ingest processing), prefer it — packages should not re-run the
 *     external tool unless explicitly asked.
 *   * If no prior summary exists and the provider is disabled, emit
 *     the bounded "disabled" summary so the package always ships an
 *     honest C2PA file (preferable to silence).
 *   * If no prior summary exists and the provider is enabled, emit a
 *     bounded "not_present" summary by default — we do not block
 *     package generation on re-running C2PA extraction here. The
 *     extraction job runs in the dedicated post-upload pipeline.
 *
 * NEVER opens the original evidence bytes. Reads the projection only.
 */

import {
  buildDisabledC2paSummary,
  aggregateC2paFileResults,
  type C2paEvidenceSummary,
  type C2paProviderMode,
} from "@proovra/shared";
import { env } from "../config.js";
import { PROOVRA_SPAN_NAMES, withProovraSpan } from "../otel.js";

export type BuildC2paSummaryInput = {
  evidenceId: string;
  /**
   * Existing summary projection from `Evidence.verificationPackageMetadata.c2pa`
   * when present, otherwise null.
   */
  existingSummary: C2paEvidenceSummary | null;
};

/**
 * Phase O1.1 — async wrapper that emits the bounded
 * `proovra.c2pa.package_summary` span. Synchronous callers can keep
 * using `buildC2paPackageSummary`; the verification-package builder
 * uses this async version when it wants the span.
 */
export async function buildC2paPackageSummaryWithSpan(
  input: BuildC2paSummaryInput,
): Promise<C2paEvidenceSummary> {
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.C2PA_PACKAGE_SUMMARY,
    { evidenceId: input.evidenceId },
    () => buildC2paPackageSummary(input),
  );
}

export function buildC2paPackageSummary(
  input: BuildC2paSummaryInput,
): C2paEvidenceSummary {
  const generatedAtUtc = new Date().toISOString();
  if (input.existingSummary) {
    // Honor existing projection but stamp a fresh `generatedAtUtc`
    // so package consumers see when the summary was last assembled.
    return {
      ...input.existingSummary,
      generatedAtUtc,
      evidenceId: input.evidenceId,
    };
  }
  const mode = resolveProviderMode();
  if (mode === "disabled") {
    return buildDisabledC2paSummary({
      evidenceId: input.evidenceId,
      generatedAtUtc,
    });
  }
  // Provider enabled but no prior result — emit an honest
  // "not_checked / not_present" aggregate. We do NOT call out to
  // c2patool here because the package build path should be cheap and
  // deterministic; extraction happens in the dedicated post-upload
  // pipeline.
  return aggregateC2paFileResults({
    evidenceId: input.evidenceId,
    generatedAtUtc,
    providerMode: mode,
    toolVersion: null,
    files: [],
    note:
      "C2PA evaluation was not run for this evidence record at finalization time. Re-run the C2PA extraction job to populate per-file results.",
  });
}

function resolveProviderMode(): C2paProviderMode {
  if (env.C2PA_ENABLED !== "true") return "disabled";
  return (env.C2PA_PROVIDER_MODE ?? "detect_only") as C2paProviderMode;
}

/**
 * Bounded README that ships next to the JSON summary. Procurement
 * reviewers and forensic teams can read this to understand exactly
 * what the package's C2PA section means and does not mean.
 */
export function buildC2paPackageReadme(): string {
  return [
    "# Provenance — C2PA Summary",
    "",
    "This directory contains a bounded summary of any C2PA (Coalition for Content Provenance and Authenticity)",
    "manifests PROOVRA detected on the evidence files in this package.",
    "",
    "## What this is",
    "",
    "- `c2pa-summary.json` — bounded, machine-readable summary of detected manifests and their validation status",
    "  at the moment this package was generated.",
    "- `c2pa-verification.md` — this file.",
    "",
    "## What this is not",
    "",
    "- This summary does NOT prove the content is true.",
    "- This summary does NOT prove the content is authentic in any legal sense.",
    "- This summary does NOT replace PROOVRA's hash + custody + timestamp integrity. A missing or invalid C2PA",
    "  manifest by itself NEVER fails PROOVRA's core integrity verdict.",
    "- This summary does NOT make any admissibility claim.",
    "",
    "## How to read it",
    "",
    "Each bounded `status` is one of:",
    "- `not_present`  — no C2PA manifest was found on the file. Not a failure.",
    "- `present`     — a manifest was detected; validation was not run or not requested.",
    "- `valid`       — a manifest was detected AND cryptographically validated under the configured provider.",
    "- `invalid`     — a manifest was detected AND validation failed. PROOVRA's hash + custody verdict still stands.",
    "- `unsupported` — the file format or provider mode cannot validate C2PA here.",
    "- `disabled`    — PROOVRA's C2PA provider is operationally disabled at this deployment.",
    "- `error`       — extraction failed for an operational reason (timeout, tool missing, etc.).",
    "",
    "## Offline verification",
    "",
    "The PROOVRA offline verifier reads `c2pa-summary.json` and reports the bounded status. It does NOT run",
    "external C2PA validation tooling, so even a `valid` status here is reported as `unsupported` for any path",
    "that would require re-running cryptographic validation offline. Use external C2PA tooling (e.g. `c2patool`)",
    "against the original evidence files if you need an independent cryptographic check.",
    "",
    "## Standing limitations",
    "",
    "- C2PA_DOES_NOT_PROVE_CONTENT_TRUTH",
    "- C2PA_DOES_NOT_PROVE_LEGAL_ADMISSIBILITY",
    "- C2PA_IS_NOT_A_REPLACEMENT_FOR_PROOVRA_CUSTODY",
    "- MISSING_C2PA_DOES_NOT_REDUCE_PROOVRA_INTEGRITY",
    "- INVALID_C2PA_DOES_NOT_OVERRIDE_PROOVRA_HASH_DECISION",
    "- C2PA_VALIDATION_REQUIRES_TOOLING_NOT_BUNDLED_OFFLINE",
    "",
  ].join("\n");
}
