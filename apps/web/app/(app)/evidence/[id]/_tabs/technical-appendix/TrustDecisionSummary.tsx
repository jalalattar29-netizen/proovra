/**
 * TrustDecisionSummary — the structured replacement for the raw
 * `trustDecisionSnapshot` JSON dump.
 *
 * Reads the same `trustDecision` object the worker generates (and the report
 * renderer consumes) and states it signal by signal (2026-10-08): each
 * signal's ONE verification status (VERIFIED | FAILED | NOT_CHECKED |
 * NOT_APPLICABLE | UNAVAILABLE), the bounded summary, the anchoring posture
 * and the reviewer action. There is no score, weighted point, verdict,
 * reliance level or confidence label — the object is read through
 * readStoredTrustDecision, so an old snapshot that still carries one never
 * restates it. Nothing here re-derives or re-thresholds a technical result.
 *
 * Moved out of the tab file so the tab orchestrates and this owns the
 * decision presentation.
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
import {
  readStoredTrustDecision,
  toVerificationStatus,
  type TrustSignal,
  type TrustSignalState,
  type VerificationStatus,
} from "@proovra/shared";
import { appendixAppTone } from "./MetadataRow";
import { TechnicalDisclosure } from "./TechnicalDisclosure";

/**
 * The trust decision as the API returns it — read ONLY through
 * readStoredTrustDecision (an older snapshot may still carry a score, points,
 * a verdict or a reliance level; none of it is rendered).
 */
export type TrustDecisionForRender = Record<string, unknown>;

/** One icon per canonical state — text AND icon, never colour alone. */
const STATE_ICONS: Record<TrustSignalState, LucideIcon> = {
  PASSED: CircleCheck,
  FAILED: CircleAlert,
  PENDING: Clock,
  PRESENT_NOT_INDEPENDENTLY_VERIFIED: TriangleAlert,
  NOT_CHECKED: CircleHelp,
  STALE: TriangleAlert,
  UNAVAILABLE: CircleHelp,
  NOT_APPLICABLE: CircleMinus,
};

const STATUS_TONE: Record<VerificationStatus, "success" | "danger" | "warning" | "neutral"> = {
  VERIFIED: "success",
  FAILED: "danger",
  NOT_CHECKED: "warning",
  NOT_APPLICABLE: "neutral",
  UNAVAILABLE: "neutral",
};

function describeSignalStatus(signal: TrustSignal) {
  const status = toVerificationStatus(signal.state);
  return {
    state: signal.state,
    status,
    tone: STATUS_TONE[status],
    icon: STATE_ICONS[signal.state] ?? CircleSlash,
  };
}

export function TrustDecisionSummary({
  trust,
}: {
  trust: TrustDecisionForRender | null;
}) {
  const decision = readStoredTrustDecision(trust);
  if (!decision) {
    return (
      <p className="ta-empty" data-trust-summary-empty>
        Trust decision is not yet available for this record.
      </p>
    );
  }

  // Only facts the response actually carries are rendered.
  const facts: Array<{ label: string; value: string }> = [];
  if (decision.anchoringStatusLabel) {
    facts.push({ label: "Anchoring", value: decision.anchoringStatusLabel });
  }

  const signals = decision.signals;

  return (
    <div data-trust-summary className="ta-decision">
      <section className="ta-decision-card">
        <div className="ta-decision-card__head">
          <span className="ta-decision-card__icon" aria-hidden="true">
            <ShieldCheck size={20} strokeWidth={2} />
          </span>
          <h3 className="ta-decision-card__title">Verification summary</h3>
        </div>

        {/* THE bounded summary: what passed, that NOT_CHECKED was not
            independently verified, and the fixed limitation. */}
        <p className="ta-decision-boundary" data-trust-summary-bounded>
          {decision.summary}
        </p>

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

        {decision.reviewerAction ? (
          <div className="ta-decision-explanations">
            <div
              className="ta-decision-explanation"
              data-trust-summary-reviewer-action
            >
              <span className="ta-decision-explanation__title">
                <CircleCheck size={15} strokeWidth={2} aria-hidden="true" />
                Reviewer next step
              </span>
              <p className="ta-decision-explanation__body">{decision.reviewerAction}</p>
            </div>
          </div>
        ) : null}
      </section>

      {signals.length > 0 ? (
        <section className="ta-signals" data-trust-summary-signals>
          <div className="ta-signals__head">
            <h3 className="ta-signals__title">Per-signal detail</h3>
          </div>

          <p className="ta-signals__lede">
            Each signal is stated in exactly one status: VERIFIED, FAILED,
            NOT_CHECKED, NOT_APPLICABLE or UNAVAILABLE. A signal marked
            NOT_CHECKED was not independently verified.
          </p>

          <div className="ta-signals__list">
            {signals.map((signal) => {
              const described = describeSignalStatus(signal);
              const StateIcon = described.icon;
              return (
                <TechnicalDisclosure
                  key={signal.key}
                  title={signal.label}
                  data-trust-signal-key={signal.key}
                  data-trust-signal-status={described.status}
                  data-trust-signal-state={described.state}
                  data-trust-signal-tone={described.tone}
                  leading={<StateIcon size={15} strokeWidth={2.4} aria-hidden="true" />}
                  trailing={
                    <span className="ta-signal-trailing">
                      {/* The signal's ONE verification status, as text. */}
                      <span
                        className="app-status-text ta-signal-state"
                        data-size="xs"
                        data-tone={appendixAppTone(described.tone)}
                        data-trust-signal-pill
                      >
                        {described.status}
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
