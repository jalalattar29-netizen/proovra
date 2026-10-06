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
  OTS_ANCHOR_CLAIM_LABELS,
  presentedTsaStatus,
  reportFreshnessChangeCopy,
  resolveOtsAnchorClaim,
  TSA_RECORDED_NOT_VALIDATED,
  type ReportFreshness,
} from "@proovra/shared";

import type { ArtifactActiveRequest, ArtifactTrust, MatchedVersion } from "./artifact-status-types";

function tsaLabel(t: ArtifactTrust["tsa"] | null | undefined): { label: string; tone: "ok" | "warn" | "neutral" } {
  if (!t) return { label: "Not available", tone: "neutral" };
  const presented = presentedTsaStatus({ tsaStatus: t.status, tsaValidatedAtUtc: t.validatedAtUtc });
  switch ((presented ?? "").toUpperCase()) {
    case "STAMPED":
      return { label: "Validated", tone: "ok" };
    case TSA_RECORDED_NOT_VALIDATED:
      return { label: "Recorded, not validated", tone: "warn" };
    case "FAILED":
      return { label: "Not validated", tone: "warn" };
    case "PENDING":
      return { label: "Pending", tone: "neutral" };
    case "DISABLED":
      return { label: "Not enabled", tone: "neutral" };
    case "":
      return { label: "Not recorded", tone: "neutral" };
    default:
      return { label: String(presented), tone: "neutral" };
  }
}

function otsLabel(o: ArtifactTrust["ots"] | null | undefined): { label: string; tone: "ok" | "warn" | "neutral" } {
  if (!o) return { label: "Not available", tone: "neutral" };
  const claim = resolveOtsAnchorClaim({ status: o.status, anchoredAtUtc: o.anchoredAtUtc, anchorCheck: o.anchorCheck });
  switch (claim) {
    case "VERIFIED":
      return { label: "Anchored, verified against Bitcoin", tone: "ok" };
    case "ANCHORED_NOT_CHECKED":
      return { label: "Anchored (chain not checked)", tone: "ok" };
    case "PENDING":
      return { label: "Anchoring pending", tone: "neutral" };
    case "FAILED":
      return { label: "Anchoring failed", tone: "warn" };
    default:
      return { label: OTS_ANCHOR_CLAIM_LABELS[claim], tone: "neutral" };
  }
}

function Fact({ label, value, tone, testId }: { label: string; value: ReactNode; tone?: "ok" | "warn" | "neutral"; testId?: string }) {
  return (
    <div className="rga-truth__fact" data-tone={tone ?? "neutral"}>
      <dt>{label}</dt>
      <dd data-testid={testId}>{value}</dd>
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
        <Fact label="Trusted timestamp" value={tsa.label} tone={tsa.tone} testId="truth-tsa" />
        <Fact label="OpenTimestamps" value={ots.label} tone={ots.tone} testId="truth-ots" />
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
