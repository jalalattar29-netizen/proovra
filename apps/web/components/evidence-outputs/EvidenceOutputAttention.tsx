"use client";

/**
 * THE THREE SUMMARIES OF ONE VALUE — the Overview "Evidence outputs" card, the
 * Artifacts tab indicator and the page-level banner.
 *
 * Each renders `EvidenceOutputAttention` (see output-attention.ts) and nothing
 * else: no fetch, no classification, no timer. The page derives the value once
 * per render from the artifact status it already holds, so the three cannot
 * disagree with each other or with the Artifacts tab.
 *
 * Actions are the existing ones, handed in: the updated-report dialog opener
 * (the one canonical dialog), the server-offered recovery verb (the one
 * recovery path), and the Artifacts navigation helper (the one tab router).
 *
 * Announcements: only the banner is a live region, and it renders only for
 * critical / action-required states. The card and the tab indicator are static
 * text, so a state change is announced once, not three times.
 */

import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Clock3, FileStack, OctagonAlert, RefreshCcw } from "lucide-react";
import {
  OUTPUT_PROGRESS_STEP_LABEL,
  outputActionLabel,
  reportFreshnessChangeCopy,
} from "@proovra/shared";

import { otsLabel, tsaLabel } from "./ArtifactTruthHeader";
import {
  presentOutputAttention,
  recoverySentence,
  type ArtifactsFocusTarget,
  type EvidenceOutputAttention,
  type OutputAttentionTone,
} from "./output-attention";

const TONE_ICON: Record<OutputAttentionTone, typeof CheckCircle2> = {
  ok: CheckCircle2,
  neutral: FileStack,
  info: RefreshCcw,
  progress: Clock3,
  warn: AlertTriangle,
  bad: OctagonAlert,
};

/** Steps before the report exists — the package still follows. */
const REPORT_STEPS: ReadonlySet<string> = new Set(["ACCEPTED", "QUEUED", "GENERATING_REPORT", "VERIFYING_REPORT"]);

function AttentionBadge({ text, tone }: { text: string; tone: OutputAttentionTone }) {
  const Icon = TONE_ICON[tone];
  return (
    <span className="rga-badge rga-attention__badge" data-tone={tone} data-testid="evidence-outputs-badge">
      <Icon size={13} strokeWidth={2.4} aria-hidden="true" />
      {text}
    </span>
  );
}

/** A version as shown: "v2", or "Not generated". Display only — never a verdict. */
function versionText(version: number | null): string {
  return version == null ? "Not generated" : `v${version}`;
}

function Fact({ label, value, testId }: { label: string; value: ReactNode; testId?: string }) {
  return (
    <div className="rga-attention__fact">
      <dt>{label}</dt>
      <dd data-testid={testId}>{value}</dd>
    </div>
  );
}

export type EvidenceOutputsCardProps = {
  attention: EvidenceOutputAttention;
  /** The one Artifacts navigation helper (tab + focus). */
  onOpenArtifacts: (focus: ArtifactsFocusTarget) => void;
  /** Opens the ONE canonical updated-report dialog. */
  onGenerateUpdatedReport: () => void;
  /** The server-offered recovery verb, through the existing recovery path. */
  onRecover: (action: "GENERATE" | "RETRY" | "RECOVER", output: "report" | "verificationPackage") => void;
  busy: boolean;
  formatDateTime: (value: string | null | undefined) => string;
};

/** The Overview card. */
export function EvidenceOutputsCard({
  attention: a,
  onOpenArtifacts,
  onGenerateUpdatedReport,
  onRecover,
  busy,
  formatDateTime,
}: EvidenceOutputsCardProps) {
  const p = presentOutputAttention(a);
  let body: ReactNode;
  let actions: ReactNode;

  switch (a.state) {
    case "CURRENT": {
      const tsa = tsaLabel(a.tsa);
      const ots = otsLabel(a.ots);
      body = (
        <>
          <dl className="rga-attention__facts">
            <Fact
              label="Report"
              value={versionText(a.latestReportVersion)}
              testId="evidence-outputs-report"
            />
            <Fact
              label="Verification package"
              value={versionText(a.latestPackageVersion)}
              testId="evidence-outputs-package"
            />
            <Fact label="Trusted timestamp" value={tsa.label} testId="evidence-outputs-tsa" />
            <Fact label="OpenTimestamps" value={ots.label} testId="evidence-outputs-ots" />
            {a.updatedAt ? <Fact label="Last generated" value={formatDateTime(a.updatedAt)} /> : null}
          </dl>
          {/* Said only when the server actually compared the facts. */}
          {a.factsCompared ? (
            <p className="rga-attention__text">All generated outputs reflect the latest verified facts.</p>
          ) : null}
        </>
      );
      actions = (
        <button type="button" className="app-secondary-action" onClick={() => onOpenArtifacts("status")} data-testid="evidence-outputs-view">
          View artifacts
        </button>
      );
      break;
    }
    case "NOT_AVAILABLE":
      body = (
        <p className="rga-attention__text">
          {a.reason === "NOT_INCLUDED"
            ? "Report PDFs and verification packages are not included for this record."
            : a.reason === "ENTITLEMENT_UNAVAILABLE"
              ? "Checking whether reports are included for this record. This page updates on its own."
              : "A report and verification package become available once this record is finalized."}
        </p>
      );
      actions = (
        <button type="button" className="app-secondary-action" onClick={() => onOpenArtifacts("status")} data-testid="evidence-outputs-view">
          View artifacts
        </button>
      );
      break;
    case "UPDATE_AVAILABLE":
      body = (
        <>
          <p className="rga-attention__lead">New verification facts are available</p>
          <ul className="rga-attention__list" data-testid="evidence-outputs-changes">
            {a.materialChanges.map((c) => (
              <li key={c.code} data-freshness-code={c.code}>
                {reportFreshnessChangeCopy(c, a.currentVersion)}
              </li>
            ))}
          </ul>
          {a.canGenerate ? (
            <p className="rga-attention__text">
              Create an updated immutable report and matching verification package.
              {a.currentVersion != null ? ` Report v${a.currentVersion} will remain unchanged.` : ""}
            </p>
          ) : a.unavailable ? (
            <p className="rga-attention__text" data-testid="evidence-outputs-unavailable">
              {a.unavailable.title}. {a.unavailable.description}
            </p>
          ) : null}
        </>
      );
      actions = (
        <>
          {a.canGenerate ? (
            <button
              type="button"
              className="app-primary-action"
              onClick={onGenerateUpdatedReport}
              disabled={busy}
              data-testid="evidence-outputs-generate"
            >
              Generate updated report
            </button>
          ) : null}
          <button type="button" className="app-secondary-action" onClick={() => onOpenArtifacts("status")} data-testid="evidence-outputs-review">
            Review artifacts
          </button>
        </>
      );
      break;
    case "IN_PROGRESS":
      body = (
        <>
          <p className="rga-attention__lead" data-testid="evidence-outputs-progress">
            {a.packageOnly
              ? `Recovering verification package${a.targetVersion != null ? ` v${a.targetVersion}` : ""}`
              : `Generating report${a.targetVersion != null ? ` v${a.targetVersion}` : ""}`}
          </p>
          <p className="rga-attention__text">
            Current step: {OUTPUT_PROGRESS_STEP_LABEL[a.stage]}.
            {a.packageOnly
              ? " The stored report is not changed."
              : REPORT_STEPS.has(a.stage)
                ? " The matching verification package is built next."
                : ""}
          </p>
        </>
      );
      actions = (
        <button type="button" className="app-secondary-action" onClick={() => onOpenArtifacts("progress")} data-testid="evidence-outputs-view-progress">
          View progress
        </button>
      );
      break;
    case "RECOVERY_AVAILABLE":
      body = (
        <>
          <p className="rga-attention__lead">{recoverySentence(a)}</p>
          {a.target === "verificationPackage" && a.reportVersion != null ? (
            <p className="rga-attention__text">Report v{a.reportVersion} remains safely recorded.</p>
          ) : a.target === "newVersion" ? (
            <p className="rga-attention__text">{a.error.title}. Earlier versions are unchanged.</p>
          ) : null}
        </>
      );
      actions = (
        <>
          {a.target === "newVersion" ? (
            <button type="button" className="app-primary-action" onClick={onGenerateUpdatedReport} disabled={busy} data-testid="evidence-outputs-recover">
              Try the updated report again
            </button>
          ) : a.action !== "NEW_VERSION" ? (
            <button
              type="button"
              className="app-primary-action"
              onClick={() => onRecover(a.action as "GENERATE" | "RETRY" | "RECOVER", a.target as "report" | "verificationPackage")}
              disabled={busy}
              data-testid="evidence-outputs-recover"
              data-evidence-generate-verb={a.action}
            >
              {busy ? "Requesting…" : outputActionLabel(a.target as "report" | "verificationPackage", a.action)}
            </button>
          ) : null}
          <button type="button" className="app-secondary-action" onClick={() => onOpenArtifacts("recovery")} data-testid="evidence-outputs-review">
            Review details
          </button>
        </>
      );
      break;
    case "BLOCKED":
      body = (
        <>
          <p className="rga-attention__lead">{a.title}</p>
          <p className="rga-attention__text">{a.safeMessage}</p>
        </>
      );
      actions = (
        <button type="button" className="app-secondary-action" onClick={() => onOpenArtifacts(a.focus)} data-testid="evidence-outputs-review">
          Review artifacts
        </button>
      );
      break;
  }

  return (
    <section
      className="rga-attention"
      aria-labelledby="evidence-outputs-title"
      data-testid="evidence-outputs-card"
      data-output-attention={a.state}
      data-tone={p.tone}
    >
      <div className="rga-attention__head">
        <h2 id="evidence-outputs-title" className="rga-attention__title">
          Evidence outputs
        </h2>
        <AttentionBadge text={p.badge} tone={p.tone} />
      </div>
      <div className="rga-attention__body">{body}</div>
      <div className="rga-attention__actions">{actions}</div>
    </section>
  );
}

/**
 * The Artifacts tab's accessible name: the visible label, completed by the
 * attention ("Artifacts — update available"). It starts with the visible text,
 * so speech input still matches it; undefined leaves the plain label.
 */
export function outputAttentionTabName(label: string, attention: EvidenceOutputAttention | null): string | undefined {
  const tab = attention ? presentOutputAttention(attention).tab : null;
  return tab ? `${label} — ${tab.suffix}` : undefined;
}

/**
 * The Artifacts tab indicator: an icon whose SHAPE differs per state (never
 * colour alone). Decorative — the state is in the tab's name (above). Static
 * content inside the tab, no control.
 */
export function OutputAttentionTabIndicator({ attention }: { attention: EvidenceOutputAttention | null }) {
  if (!attention) return null;
  const tab = presentOutputAttention(attention).tab;
  if (!tab) return null;
  const Icon = TONE_ICON[tab.tone];
  return (
    <>
      <span
        className="rga-tab-indicator"
        data-tone={tab.tone}
        data-testid="artifacts-tab-indicator"
        data-output-attention={attention.state}
        aria-hidden="true"
      >
        <Icon size={12} strokeWidth={2.6} />
      </span>
    </>
  );
}

/** The page-level banner — critical / action-required states only. */
export function EvidenceOutputAttentionBanner({
  attention,
  onReview,
}: {
  attention: EvidenceOutputAttention | null;
  onReview: (focus: ArtifactsFocusTarget) => void;
}) {
  if (!attention) return null;
  const banner = presentOutputAttention(attention).banner;
  if (!banner) return null;
  const critical = attention.state === "BLOCKED" && attention.severity === "CRITICAL";
  return (
    <aside
      className="evidence-detail-record-banner evidence-detail-record-banner--split"
      data-banner-tone={critical ? "danger" : "warn"}
      role="status"
      aria-live="polite"
      data-testid="output-attention-banner"
      data-output-attention={attention.state}
    >
      <div className="evidence-detail-record-banner__copy">
        <strong className="evidence-detail-record-banner__title">{banner.title}</strong>
        <span className="evidence-detail-record-banner__body">{banner.body}</span>
      </div>
      <button
        type="button"
        className="app-secondary-action app-secondary-action--filled"
        onClick={() => onReview(banner.focus)}
        data-testid="output-attention-banner-review"
      >
        Review artifacts
      </button>
    </aside>
  );
}
