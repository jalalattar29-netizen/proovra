/**
 * TrustDecisionSummary — the structured replacement for the raw
 * `trustDecisionSnapshot` JSON dump.
 *
 * Reads the same `trustDecision` object the worker generates (and the report
 * renderer consumes) and surfaces it as a decision card + per-signal rows.
 * Presentation ONLY: every verdict, score, confidence, reliance level,
 * anchoring label, count, reason and per-signal status below is read
 * straight from that object. Nothing here re-derives, re-thresholds or
 * re-interprets a technical result, and nothing is defaulted into existence —
 * a value the response does not carry is not rendered.
 *
 * Moved out of the tab file so the tab orchestrates and this owns the
 * decision presentation; it was ~250 lines of inline-styled markup inside the
 * orchestrator.
 */

"use client";

import {
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleMinus,
  CircleSlash,
  Clock,
  ShieldCheck,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { appendixAppTone } from "./MetadataRow";
import { TechnicalDisclosure } from "./TechnicalDisclosure";

export type TrustSignalForRender = {
  key: string;
  label: string;
  status: string;
  tone: string;
  points: number;
  maxPoints: number;
  summary: string;
  detail: string;
};

export type TrustDecisionForRender = {
  verdictLabel?: string;
  shortLabel?: string;
  scoreLabel?: string;
  score?: number;
  maxScore?: number;
  confidenceLabel?: string;
  relianceLevel?: string;
  anchoringStatusLabel?: string;
  summary?: string;
  primaryReason?: string;
  reviewerAction?: string;
  passedSignals?: number;
  degradedSignals?: number;
  failedSignals?: number;
  signals?: TrustSignalForRender[];
};

/**
 * The signal-state vocabulary this surface may render. Each maps to one
 * label, one icon and one semantic tone — text AND colour, never colour
 * alone. An unrecognised backend status is shown verbatim under the neutral
 * tone rather than being coerced into a state we cannot vouch for.
 */
const SIGNAL_STATES: Record<
  string,
  { label: string; tone: "success" | "warning" | "danger" | "neutral" | "info"; icon: LucideIcon }
> = {
  passed: { label: "Passed", tone: "success", icon: CircleCheck },
  partial: { label: "Degraded", tone: "warning", icon: TriangleAlert },
  degraded: { label: "Degraded", tone: "warning", icon: TriangleAlert },
  failed: { label: "Failed", tone: "danger", icon: CircleAlert },
  pending: { label: "Pending", tone: "info", icon: Clock },
  missing: { label: "Unavailable", tone: "neutral", icon: CircleHelp },
  unavailable: { label: "Unavailable", tone: "neutral", icon: CircleHelp },
  not_applicable: { label: "Not applicable", tone: "neutral", icon: CircleMinus },
};

function describeSignalState(status: string) {
  return (
    SIGNAL_STATES[status] ?? {
      label: status,
      tone: "neutral" as const,
      icon: CircleSlash,
    }
  );
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

export function TrustDecisionSummary({
  trust,
}: {
  trust: TrustDecisionForRender | null;
}) {
  if (!trust || (!trust.verdictLabel && (trust.signals ?? []).length === 0)) {
    return (
      <p className="ta-empty" data-trust-summary-empty>
        Trust decision is not yet available for this record.
      </p>
    );
  }

  // Only facts the response actually carries are rendered. A missing
  // confidence or reliance level is absent from the grid, never "Unknown"
  // and never a placeholder that reads like a result.
  const facts: Array<{ label: string; value: string }> = [];
  if (trust.verdictLabel) facts.push({ label: "Verdict", value: trust.verdictLabel });
  if (trust.scoreLabel) facts.push({ label: "Score", value: trust.scoreLabel });
  if (trust.confidenceLabel) {
    facts.push({ label: "Confidence", value: trust.confidenceLabel });
  }
  if (trust.relianceLevel) {
    facts.push({ label: "Reliance level", value: capitalise(trust.relianceLevel) });
  }
  if (trust.anchoringStatusLabel) {
    facts.push({ label: "Anchoring", value: trust.anchoringStatusLabel });
  }

  const signals = trust.signals ?? [];

  // Counts come from the response. When the response omits a count we say so
  // rather than printing 0 — "no failed signals" and "we were not told how
  // many failed" are different facts.
  const totals: Array<{
    key: string;
    label: string;
    value: number | undefined;
    tone: "success" | "warning" | "danger";
  }> = [
    { key: "passed", label: "Passed signals", value: trust.passedSignals, tone: "success" },
    { key: "degraded", label: "Degraded signals", value: trust.degradedSignals, tone: "warning" },
    { key: "failed", label: "Failed signals", value: trust.failedSignals, tone: "danger" },
  ];

  const totalPoints = signals.reduce((sum, s) => sum + (s.maxPoints ?? 0), 0);

  return (
    <div data-trust-summary className="ta-decision">
      <section className="ta-decision-card">
        <div className="ta-decision-card__head">
          <span className="ta-decision-card__icon" aria-hidden="true">
            <ShieldCheck size={20} strokeWidth={2} />
          </span>
          <h3 className="ta-decision-card__title">Trust decision summary</h3>
        </div>

        {facts.length > 0 ? (
          <div className="ta-decision-facts" data-trust-summary-facts>
            {facts.map((fact) => (
              <div key={fact.label} className="ta-decision-fact">
                <span className="ta-decision-fact__label">{fact.label}</span>
                <span
                  className="ta-decision-fact__value"
                  data-trust-fact={fact.label.toLowerCase().replace(/\s+/g, "-")}
                >
                  {fact.value}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        <div className="ta-decision-totals" data-trust-summary-totals>
          {totals.map((total) => (
            <div
              key={total.key}
              className="ta-decision-total"
              data-tone={total.tone}
              data-trust-total={total.key}
            >
              <span className="ta-decision-total__label">{total.label}</span>
              <span className="ta-decision-total__value">
                {total.value == null ? "Not reported" : String(total.value)}
              </span>
            </div>
          ))}
        </div>

        {trust.primaryReason || trust.reviewerAction ? (
          <div className="ta-decision-explanations">
            {trust.primaryReason ? (
              <div
                className="ta-decision-explanation"
                data-trust-summary-primary-reason
              >
                <span className="ta-decision-explanation__title">
                  <CircleHelp size={15} strokeWidth={2} aria-hidden="true" />
                  Primary reason
                </span>
                <p className="ta-decision-explanation__body">{trust.primaryReason}</p>
              </div>
            ) : null}
            {trust.reviewerAction ? (
              <div
                className="ta-decision-explanation"
                data-trust-summary-reviewer-action
              >
                <span className="ta-decision-explanation__title">
                  <CircleCheck size={15} strokeWidth={2} aria-hidden="true" />
                  Reviewer next step
                </span>
                <p className="ta-decision-explanation__body">{trust.reviewerAction}</p>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* The boundary of the conclusion, stated where the conclusion is
            shown. This wording is the product's, not this component's — it is
            not broadened or softened here. */}
        {trust.summary ? (
          <p className="ta-decision-boundary" data-trust-summary-narrative>
            {trust.summary}
          </p>
        ) : null}
      </section>

      {signals.length > 0 ? (
        <section className="ta-signals" data-trust-summary-signals>
          <div className="ta-signals__head">
            <h3 className="ta-signals__title">Per-signal detail</h3>
            {totalPoints > 0 ? (
              <span className="ta-signals__weighting">
                Weighting: {totalPoints} points
              </span>
            ) : null}
          </div>

          <p className="ta-signals__lede">
            Scores show each signal’s contribution to the 100-point technical
            assessment; they are not counts of separate checks.
          </p>

          <div className="ta-signals__list">
            {signals.map((signal) => {
              const state = describeSignalState(signal.status);
              const StateIcon = state.icon;
              return (
                <TechnicalDisclosure
                  key={signal.key}
                  title={signal.label}
                  data-trust-signal-key={signal.key}
                  data-trust-signal-status={signal.status}
                  data-trust-signal-tone={state.tone}
                  leading={<StateIcon size={15} strokeWidth={2.4} aria-hidden="true" />}
                  trailing={
                    <span className="ta-signal-trailing">
                      {/* The signal's OUTCOME, as text. Eight signal rows each
                          carried a tinted pill next to a score, which made the
                          column of outcomes compete with the scores that
                          quantify them. The state vocabulary, the icon and the
                          tone are all unchanged — only the surface is gone. */}
                      <span
                        className="app-status-text ta-signal-state"
                        data-tone={appendixAppTone(state.tone)}
                        data-trust-signal-pill
                      >
                        {state.label}
                      </span>
                      {/* A weighted CONTRIBUTION to the 100-point assessment,
                          labelled so it cannot read as a count of checks. */}
                      <span className="ta-signal-score">
                        {signal.points} / {signal.maxPoints}
                        <span className="ta-signal-score__unit">points</span>
                      </span>
                    </span>
                  }
                >
                  {signal.summary ? (
                    <p className="ta-signal-summary">{signal.summary}</p>
                  ) : null}
                  {signal.detail ? (
                    <p className="ta-signal-detail">{signal.detail}</p>
                  ) : null}
                  {!signal.summary && !signal.detail ? (
                    <p className="ta-signal-summary">
                      No further detail was recorded for this signal.
                    </p>
                  ) : null}
                </TechnicalDisclosure>
              );
            })}
          </div>

        </section>
      ) : null}
    </div>
  );
}
