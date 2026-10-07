"use client";

/**
 * THE ARTIFACT TRUTH HEADER — what this record's outputs are, right now.
 *
 * Every value is the server's: the latest report and the package PAIRED with it
 * (never "any package"), their times and sizes, the timestamp and anchor state,
 * whether facts newer than the report were recorded (and which), and the durable
 * request in flight. Nothing is assumed: an absent field reads "Not available",
 * never a reassuring default.
 */

import type { ReactNode } from "react";
import { FileCheck2, RefreshCcw } from "lucide-react";
import {
  TRUST_SIGNAL_STATE_PRESENTATION,
  getTrustLayerStateLabel,
  presentedTsaStatus,
  reportFreshnessChangeCopy,
  resolveOtsTrustState,
  resolveTsaTrustState,
  type ReportFreshness,
  type TrustSignalState,
} from "@proovra/shared";

import type { ArtifactActiveRequest, ArtifactTrust, MatchedVersion } from "./artifact-status-types";

type TruthTone = "ok" | "warn" | "neutral";

/** THE canonical state's tone, in this header's three tones ("ok" only for PASSED). */
function toneOf(state: TrustSignalState): TruthTone {
  const tone = TRUST_SIGNAL_STATE_PRESENTATION[state].tone;
  return tone === "success" ? "ok" : tone === "danger" || tone === "warning" ? "warn" : "neutral";
}

export function tsaLabel(t: ArtifactTrust["tsa"] | null | undefined): { label: string; tone: TruthTone; measuredAtUtc: string | null } {
  if (!t) return { label: "Not available", tone: "neutral", measuredAtUtc: null };
  const presented = presentedTsaStatus({ tsaStatus: t.status, tsaValidatedAtUtc: t.validatedAtUtc });
  const s = resolveTsaTrustState({
    presentedStatus: presented,
    // With a recorded code the canonical resolver decides: a validation code
    // means a token was received, a provider code means none was.
    tokenPresent: t.failureCode ? true : null,
    failureCode: t.failureCode,
    validatedAtUtc: t.validatedAtUtc,
  });
  // FAILED with no code, or a code this surface does not know: never claim
  // that nothing was obtained, nor that a token was. Only a provider code
  // says no token came back.
  const providerCode = /^tsa_provider_|^tsa_unknown_error$|^tsa_token_missing$/.test(String(t.failureCode ?? ""));
  if (s.state === "UNAVAILABLE" && String(presented ?? "").toUpperCase() === "FAILED" && !providerCode) {
    return { label: "Not validated", tone: "warn", measuredAtUtc: null };
  }
  return {
    label: getTrustLayerStateLabel({ key: "trusted_timestamp", status: TRUST_SIGNAL_STATE_PRESENTATION[s.state].legacyStatus, state: s.state }),
    tone: toneOf(s.state),
    measuredAtUtc: s.measuredAtUtc,
  };
}

export function otsLabel(o: ArtifactTrust["ots"] | null | undefined): { label: string; tone: TruthTone; measuredAtUtc: string | null } {
  if (!o) return { label: "Not available", tone: "neutral", measuredAtUtc: null };
  // An attested proof is "present, not chain-verified"; only a recorded chain
  // check is verified (resolveOtsTrustState).
  const s = resolveOtsTrustState({
    status: o.status,
    anchoredAtUtc: o.anchoredAtUtc,
    anchorCheck: o.anchorCheck,
    anchorCheckedAtUtc: o.anchorCheckedAtUtc ?? null,
  });
  return {
    label: getTrustLayerStateLabel({ key: "bitcoin_anchoring", status: TRUST_SIGNAL_STATE_PRESENTATION[s.state].legacyStatus, state: s.state }),
    tone: toneOf(s.state),
    measuredAtUtc: s.measuredAtUtc,
  };
}

function Fact({
  label,
  value,
  tone,
  testId,
  note,
}: {
  label: string;
  value: ReactNode;
  tone?: "ok" | "warn" | "neutral";
  testId?: string;
  /** When the state was measured (shown beside it, never mixed into it). */
  note?: string | null;
}) {
  return (
    <div className="rga-truth__fact" data-tone={tone ?? "neutral"}>
      <dt>{label}</dt>
      <dd data-testid={testId}>{value}</dd>
      {note ? (
        <dd className="rga-truth__note" data-testid={testId ? `${testId}-measured` : undefined}>
          {note}
        </dd>
      ) : null}
    </div>
  );
}

export function ArtifactTruthHeader({
  latest,
  trust,
  freshness,
  activeRequest,
  formatDateTime,
  formatBytes,
  actions,
}: {
  /** The newest immutable pair (from the matched history), or null. */
  latest: MatchedVersion | null;
  trust: ArtifactTrust | null | undefined;
  freshness: ReportFreshness | null | undefined;
  activeRequest: ArtifactActiveRequest | null | undefined;
  formatDateTime: (value: string | null | undefined) => string;
  formatBytes: (value: string | number | null | undefined) => string;
  /** The contextual actions, decided by the server and rendered by the tab. */
  actions: ReactNode;
}) {
  const tsa = tsaLabel(trust?.tsa);
  const ots = otsLabel(trust?.ots);
  const live =
    activeRequest &&
    (activeRequest.progress.outcome === "ACTIVE" || activeRequest.progress.outcome === "RETRYING");
  const pkg = latest?.package ?? null;

  return (
    <section className="rga-truth" aria-labelledby="rga-truth-title" data-testid="artifact-truth-header">
      <div className="rga-truth__head">
        <span className="rga-truth__icon" aria-hidden="true">
          <FileCheck2 size={20} strokeWidth={2} />
        </span>
        <div className="rga-truth__copy">
          <h2 id="rga-truth-title" className="rga-truth__title">
            {latest ? `Report v${latest.reportVersion}` : "No report yet"}
            {latest ? (
              <span className="rga-badge rga-badge--accent" data-testid="truth-latest-badge">Latest</span>
            ) : null}
            {latest ? <span className="rga-badge">Immutable</span> : null}
          </h2>
          <p className="rga-truth__sub">
            {latest
              ? pkg
                ? `Certified by verification package v${pkg.version}`
                : "No verification package certifies this version yet"
              : "A report and its verification package appear here once generated."}
          </p>
        </div>
      </div>

      {freshness?.hasNewerFacts ? (
        <div className="rga-truth__fresh" role="status" data-testid="truth-freshness">
          <RefreshCcw size={16} strokeWidth={2.2} aria-hidden="true" />
          <div>
            <strong>New verification facts are available</strong>
            <ul>
              {freshness.changes.map((c) => (
                <li key={c.code} data-freshness-code={c.code}>
                  {reportFreshnessChangeCopy(c, freshness.reportVersion)}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <dl className="rga-truth__facts">
        <Fact
          label="Report generated"
          value={latest ? formatDateTime(latest.generatedAtUtc) : "—"}
          testId="truth-report-generated"
        />
        <Fact label="Report size" value={latest ? formatBytes(latest.sizeBytes) : "—"} />
        <Fact
          label="Verification package"
          value={pkg ? `v${pkg.version} · ${formatDateTime(pkg.generatedAtUtc)}` : latest ? "Missing" : "—"}
          tone={latest && !pkg ? "warn" : undefined}
          testId="truth-package"
        />
        <Fact label="Package size" value={pkg ? formatBytes(pkg.sizeBytes) : "—"} />
        <Fact
          label="Trusted timestamp"
          value={tsa.label}
          tone={tsa.tone}
          testId="truth-tsa"
          note={tsa.measuredAtUtc ? `Validated ${formatDateTime(tsa.measuredAtUtc)}` : null}
        />
        <Fact
          label="OpenTimestamps"
          value={ots.label}
          tone={ots.tone}
          testId="truth-ots"
          note={ots.measuredAtUtc ? `Checked against the Bitcoin chain ${formatDateTime(ots.measuredAtUtc)}` : null}
        />
        <Fact
          label="Report facts"
          value={
            !latest
              ? "—"
              : freshness == null
                ? "Not available"
                : freshness.hasNewerFacts
                  ? "Newer facts recorded"
                  : "Current"
          }
          tone={freshness?.hasNewerFacts ? "warn" : freshness ? "ok" : undefined}
          testId="truth-freshness-state"
        />
        <Fact
          label="In progress"
          value={
            live && activeRequest
              ? `${activeRequest.progress.steps.find((s) => s.key === activeRequest.progress.currentStep)?.label ?? "Working"}${
                  activeRequest.targetVersion != null ? ` (v${activeRequest.targetVersion})` : ""
                }`
              : "Nothing"
          }
          testId="truth-active"
        />
      </dl>

      <div className="rga-truth__actions" data-testid="truth-actions">
        {actions}
      </div>
    </section>
  );
}
