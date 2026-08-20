"use client";

/**
 * Phase D1/D2/C5/C6 (UI) — Case Copilot on the Case page.
 *
 * WHAT IT IS. It compares the METADATA of evidence an operator explicitly
 * selects — title, type, mime type, status, verification status, whether a
 * report and a package exist, when it was created — and returns an advisory
 * reading of the case: timeline highlights, categories of evidence that appear
 * missing, workflow gaps, metadata that conflicts between records, reviewer
 * preparation notes, a disclosure checklist and open questions. Every
 * substantive observation carries a citation the server resolved against real
 * records; unresolvable ones are dropped before the response is sent.
 *
 * Advisory only. No auto-run. Raw evidence content is never sent. Nothing here
 * is a finding of authenticity, factual truth or admissibility.
 *
 * WHAT WENT WRONG, AND WHERE IT IS FIXED
 * ---------------------------------------------------------------------------
 * Selecting TWO records always failed with "Invalid selection. (INVALID_INPUT)".
 * Nothing about the selection was invalid: this panel built its idempotency key
 * as `${caseId}:${ids.join(",")}` — 73 characters for one record, 110 for two —
 * and the route validates it with `z.string().max(80)`. The key describing the
 * request was too long, so the request never reached the feature.
 *
 * The key is now built by `buildCopilotIdempotencyKey`, which digests the
 * selection instead of concatenating it, so its length no longer grows with the
 * selection. It is bounded BY the route's own limit, declared once.
 *
 * The panel also listed every linked record — including ones still uploading —
 * with no statement about whether they could be analyzed, and the route
 * enforced no rule at all. Eligibility is now
 * `evaluateCopilotEvidenceEligibility`, derived from persisted fields, and the
 * SAME function runs on the server before any spend.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  FileText,
  Image as ImageIcon,
  Mic,
  Video,
} from "lucide-react";

import {
  COPILOT_SELECTION_MAX,
  COPILOT_SELECTION_REFRESH_MESSAGE,
  buildCopilotIdempotencyKey,
  copilotIneligibilityReason,
  evaluateCopilotEvidenceEligibility,
  type CopilotEligibility,
} from "@proovra/shared";

import { apiFetch, ApiError } from "../../lib/api";
import { AppStatusBadge, type AppTone } from "../app-primitives/AppStatusBadge";
import { CopilotCitationList, type CopilotCitationData } from "./CopilotCitation";
import "./case-copilot.css";

export type CaseCopilotEvidence = {
  id: string;
  title: string;
  type: string;
  version: number;
  status: string;
  /** `EvidenceLifecycleState`. Absent on an older projection. */
  lifecycleState?: string | null;
  /** Whether this record is linked to the case being analyzed. */
  caseLinked?: boolean;
  stale?: boolean;
};

type CaseCopilotData = {
  caseSummary: string;
  timelineHighlights: string[];
  missingEvidenceCategories: string[];
  workflowGaps: string[];
  conflictingMetadata: string[];
  reviewerPreparation: string[];
  disclosureChecklist: string[];
  unresolvedQuestions: string[];
  citations: CopilotCitationData[];
  advisoryBoundary: string;
};

type RunResult = {
  status: string;
  decision?: string;
  data?: CaseCopilotData;
  droppedCitations?: number;
  advisoryBoundary?: string;
  versionMeta?: {
    outputSchemaVersion?: string;
    contextObjectVersions?: Array<{ id: string; version: number | null }>;
  };
};

type UiState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string; retryable: boolean }
  | { kind: "result"; result: RunResult };

const SECTIONS: Array<{ key: keyof CaseCopilotData; label: string }> = [
  { key: "timelineHighlights", label: "Timeline highlights" },
  { key: "missingEvidenceCategories", label: "Missing evidence categories" },
  { key: "workflowGaps", label: "Workflow gaps" },
  { key: "conflictingMetadata", label: "Conflicting metadata" },
  { key: "reviewerPreparation", label: "Reviewer preparation" },
  { key: "disclosureChecklist", label: "Disclosure checklist" },
  { key: "unresolvedQuestions", label: "Unresolved questions" },
];

/**
 * The lifecycle tone for a record STATUS.
 *
 * One vocabulary, one map. `REPORTED` and `UPLOADING` are not equivalent and
 * must not look it, and a failed integrity check is not a caution.
 */
function statusTone(status: string): AppTone {
  switch (status.toUpperCase()) {
    case "REPORTED":
    case "SIGNED":
      return "green";
    case "UPLOADED":
      return "blue";
    case "CREATED":
    case "UPLOADING":
      return "amber";
    case "FAILED_HASH_MISMATCH":
      return "red";
    default:
      return "slate";
  }
}

function statusLabel(status: string): string {
  if (!status) return "Unknown";
  const s = status.toUpperCase();
  if (s === "FAILED_HASH_MISMATCH") return "Integrity failed";
  return s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");
}

/** A semantic glyph for the record KIND. Decorative; the label carries meaning. */
function KindIcon({ type }: { type: string }) {
  const common = { size: 14, strokeWidth: 2, "aria-hidden": true } as const;
  switch (type.toUpperCase()) {
    case "PHOTO":
    case "IMAGE":
      return <ImageIcon {...common} />;
    case "VIDEO":
      return <Video {...common} />;
    case "AUDIO":
      return <Mic {...common} />;
    default:
      return <FileText {...common} />;
  }
}

export function CaseCopilotPanel({
  caseId,
  linkedEvidence,
  aiEnabled = true,
  onRefreshEvidence,
}: {
  caseId: string;
  linkedEvidence: CaseCopilotEvidence[];
  aiEnabled?: boolean;
  /** Re-read the case, when the server refuses a selection this list allowed. */
  onRefreshEvidence?: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [state, setState] = useState<UiState>({ kind: "idle" });
  /**
   * The client half of duplicate-run protection. The button is disabled while
   * committing; a ref rejects a re-entrant call the disabled attribute cannot
   * catch, and the route's dedupe window is the third.
   */
  const runInFlight = useRef(false);

  /**
   * ONE eligibility verdict per record, derived from persisted fields by the
   * shared authority the ROUTE also runs. The panel never composes its own
   * rule and never infers one from rendered text.
   */
  const evaluated = useMemo(
    () =>
      linkedEvidence.map((e) => ({
        evidence: e,
        verdict: evaluateCopilotEvidenceEligibility({
          status: e.status,
          lifecycleState: e.lifecycleState,
          // Absent on an older projection. `undefined` means "not stated",
          // which the authority treats as linked — this panel only ever lists
          // the case's own evidence.
          caseLinked: e.caseLinked,
          stale: e.stale,
        }) as CopilotEligibility,
      })),
    [linkedEvidence],
  );

  const eligibleIds = useMemo(
    () => evaluated.filter((x) => x.verdict.eligible).map((x) => x.evidence.id),
    [evaluated],
  );

  /**
   * PRUNE STALE SELECTIONS.
   *
   * A record can finish uploading, be unlinked or be scheduled for destruction
   * between rendering the list and pressing Run. Dropping it here means the
   * count, the pre-run summary and the request all describe the same set —
   * rather than the request quietly carrying a record the panel no longer
   * shows.
   */
  useEffect(() => {
    setSelected((prev) => {
      const allowed = new Set(eligibleIds);
      const next = new Set([...prev].filter((id) => allowed.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [eligibleIds]);

  const selectedList = evaluated
    .filter((x) => selected.has(x.evidence.id) && x.verdict.eligible)
    .map((x) => x.evidence);
  const selectedCount = selectedList.length;
  const overLimit = selectedCount > COPILOT_SELECTION_MAX;

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const run = useCallback(async () => {
    if (runInFlight.current) return;
    if (selectedCount === 0 || overLimit) return;
    runInFlight.current = true;
    setState({ kind: "loading" });

    const ids = selectedList.map((e) => e.id);
    const versions: Record<string, number> = {};
    for (const e of selectedList) versions[e.id] = e.version;

    try {
      const res = (await apiFetch(`/v1/ai/case/${caseId}/copilot`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          selectedEvidenceIds: ids,
          selectedEvidenceVersions: versions,
          processingMode: "METADATA_ONLY",
          // BOUNDED. The previous key concatenated every id and exceeded the
          // route's own `max(80)` at two selections, which is what produced
          // "Invalid selection. (INVALID_INPUT)".
          idempotencyKey: buildCopilotIdempotencyKey({
            scope: "case",
            scopeId: caseId,
            selection: ids,
          }),
        }),
      })) as { data?: RunResult; status?: string };
      const result: RunResult = res.data ?? (res as RunResult);
      setState({ kind: "result", result });
    } catch (err) {
      setState({ kind: "error", ...describeFailure(err, onRefreshEvidence) });
    } finally {
      runInFlight.current = false;
    }
  }, [caseId, selectedCount, overLimit, selectedList, onRefreshEvidence]);

  if (!aiEnabled) {
    return (
      <section className="app-panel app-panel__body case-copilot" aria-label="Evidence Operations Copilot">
        <CopilotHeader />
        <p className="case-copilot__restricted" data-case-copilot-restricted>
          AI assistance is turned off for this workspace by policy. Case and
          evidence workflows are unaffected.
        </p>
      </section>
    );
  }

  const disabledReason =
    selectedCount === 0
      ? "Select at least one eligible evidence record to run the Copilot."
      : overLimit
        ? `Select at most ${COPILOT_SELECTION_MAX} records.`
        : null;

  return (
    <section
      className="app-panel app-panel__body case-copilot"
      aria-label="Evidence Operations Copilot"
      data-case-copilot
    >
      <CopilotHeader />

      {/* ---- Selection toolbar ------------------------------------------- */}
      <div className="case-copilot__toolbar">
        <h4 className="case-copilot__section-title">Select evidence</h4>
        <div className="case-copilot__toolbar-actions">
          <span
            className="case-copilot__count"
            data-case-copilot-selected-count={selectedCount}
            aria-live="polite"
          >
            {selectedCount} selected
          </span>
          <button
            type="button"
            className="app-secondary-action"
            onClick={() => setSelected(new Set(eligibleIds))}
            disabled={eligibleIds.length === 0}
            data-case-copilot-select-all
          >
            Select all
          </button>
          <button
            type="button"
            className="app-secondary-action app-secondary-action--danger"
            onClick={() => setSelected(new Set())}
            disabled={selected.size === 0}
            data-case-copilot-clear
          >
            Clear
          </button>
        </div>
      </div>

      {/* ---- Bounded selector -------------------------------------------- */}
      {linkedEvidence.length === 0 ? (
        <p className="case-copilot__empty" data-case-copilot-empty>
          No evidence is linked to this case yet.
        </p>
      ) : (
        <ul className="case-copilot__list" data-case-copilot-list>
          {evaluated.map(({ evidence: e, verdict }) => {
            const isSelected = selected.has(e.id);
            const disabled = !verdict.eligible;
            return (
              <li
                key={e.id}
                className="case-copilot__row"
                data-case-copilot-row={e.id}
                data-selected={isSelected ? "true" : "false"}
                data-eligible={verdict.eligible ? "true" : "false"}
              >
                {/*
                  ONE control for the whole row. A <label> wrapping the real
                  checkbox gives every pixel of the row to it, with no nested
                  interactive element and exactly one tab stop.
                */}
                <label className="case-copilot__row-control">
                  <input
                    type="checkbox"
                    className="app-checkbox"
                    checked={isSelected}
                    disabled={disabled}
                    aria-disabled={disabled || undefined}
                    onChange={() => toggle(e.id)}
                    data-case-copilot-checkbox={e.id}
                    aria-label={`Select ${e.title}`}
                  />
                  <span className="case-copilot__row-body">
                    <span
                      className="case-copilot__row-title"
                      title={e.title}
                      data-case-copilot-row-title
                    >
                      {e.title}
                    </span>
                    <span className="case-copilot__row-meta">
                      <span className="case-copilot__kind" data-case-copilot-kind={e.type}>
                        <KindIcon type={e.type} />
                        {e.type}
                      </span>{" "}
                      <AppStatusBadge
                        tone={statusTone(e.status)}
                        data-case-copilot-status={e.status}
                      >
                        {statusLabel(e.status)}
                      </AppStatusBadge>
                    </span>
                    {disabled ? (
                      <span
                        className="case-copilot__row-reason"
                        data-case-copilot-reason={verdict.eligible ? undefined : verdict.reason}
                      >
                        {verdict.eligible ? null : copilotIneligibilityReason(verdict.reason)}
                      </span>
                    ) : null}
                  </span>
                </label>
                {/*
                  The version is CONTRACT data an operator can act on only when
                  a package exists. `v0` said "no package yet" in a form nobody
                  could read, so it is stated in words and kept in full for a
                  screen reader rather than deleted.
                */}
                <span className="case-copilot__row-version" data-case-copilot-version={e.version}>
                  {e.version > 0 ? `Package v${e.version}` : "No package yet"}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {/* ---- Pre-run summary --------------------------------------------- */}
      {selectedCount > 0 ? (
        <div className="case-copilot__prerun" data-case-copilot-prerun>
          <h4 className="case-copilot__section-title">Before you run</h4>
          <dl className="case-copilot__facts">
            <Fact label="Records">
              {selectedCount} selected
              <SelectedNames names={selectedList.map((e) => e.title)} />
            </Fact>
            <Fact label="Data shared">Metadata only</Fact>
            <Fact label="Raw content">Not sent</Fact>
            <Fact label="Processing">External AI provider</Fact>
            <Fact label="Estimated usage">1 AI operation</Fact>
            <Fact label="Training">Never used to train models</Fact>
            <Fact label="Retention">Bounded advisory record, per workspace policy</Fact>
          </dl>
        </div>
      ) : null}

      {/* ---- Action ------------------------------------------------------- */}
      <div className="case-copilot__actions">
        <button
          type="button"
          className="app-primary-action app-primary-action--block"
          onClick={() => void run()}
          disabled={selectedCount === 0 || overLimit || state.kind === "loading"}
          aria-busy={state.kind === "loading"}
          aria-describedby={disabledReason ? "case-copilot-run-hint" : undefined}
          data-case-copilot-run
        >
          {state.kind === "loading"
            ? "Analyzing…"
            : state.kind === "result"
              ? "Re-run Case Copilot"
              : "Run Case Copilot"}
        </button>
        {disabledReason ? (
          <p className="case-copilot__hint" id="case-copilot-run-hint">
            {disabledReason}
          </p>
        ) : null}
        {state.kind === "loading" ? (
          <p className="case-copilot__hint" aria-live="polite">
            Advisory only — this does not change any record.
          </p>
        ) : null}
      </div>

      {state.kind === "error" ? (
        <div
          className="app-alert app-alert--warn case-copilot__error"
          role="alert"
          data-case-copilot-error
        >
          <AlertCircle size={15} strokeWidth={2} aria-hidden="true" />
          <span>{state.message}</span>
          {state.retryable ? (
            <button
              type="button"
              className="app-secondary-action"
              onClick={() => void run()}
              data-case-copilot-retry
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {state.kind === "result" ? <ResultView result={state.result} /> : null}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="case-copilot__fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * The selected filenames, bounded.
 *
 * At the maximum selection an inline list would be fifty filenames inside a
 * right rail. Three are named and the rest are counted, with the full list
 * available on demand.
 */
function SelectedNames({ names }: { names: string[] }) {
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  return (
    <span className="case-copilot__names" data-case-copilot-names>
      {shown.join(", ")}
      {rest > 0 ? (
        <>
          {" "}
          <details className="case-copilot__names-more">
            <summary>and {rest} more</summary>
            <ul>
              {names.slice(3).map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </details>
        </>
      ) : null}
    </span>
  );
}

function CopilotHeader() {
  return (
    <header className="case-copilot__header">
      <h3 className="case-copilot__title">Evidence Operations Copilot</h3>
      <p className="case-copilot__purpose">
        Compare selected evidence metadata to surface cross-record patterns and
        review gaps.
      </p>
      {/*
        BOUNDARIES, not decoration. Each is a separate list item so a screen
        reader announces three statements rather than one run-together name,
        and the treatment is restrained so they cannot outweigh the title.
      */}
      <ul className="case-copilot__disclosures" aria-label="AI disclosures">
        {/*
          The `{" "}` nodes are deliberate. A whitespace-only text node is
          ignored for flex layout but keeps the labels apart in `textContent`
          and in the accessible name — as bare siblings these serialised as
          "AI-generatedAdvisory onlyMetadata only" for a reader and a scraper.
          The visible separator is a CSS dot, which never reaches either.
        */}
        <li>AI-generated</li>{" "}
        <li>Advisory only</li>{" "}
        <li>Metadata only</li>
      </ul>
    </header>
  );
}

function ResultView({ result }: { result: RunResult }) {
  if (result.status === "provider_unavailable") {
    return (
      <div className="app-alert case-copilot__error" role="status">
        AI is currently unavailable. Case workflows are unaffected.
      </div>
    );
  }
  if (result.status === "policy_denied") {
    return (
      <div className="app-alert case-copilot__error" role="status">
        Case Copilot is disabled for this workspace.
      </div>
    );
  }
  if (result.status === "no_selection") {
    return (
      <div className="app-alert case-copilot__error" role="status">
        Select at least one evidence record to analyze.
      </div>
    );
  }
  if (result.status === "schema_error") {
    return (
      <div className="app-alert app-alert--warn case-copilot__error" role="alert">
        The AI response could not be validated and was discarded. Nothing from it
        is shown. Try again.
      </div>
    );
  }
  const data = result.data;
  if (result.status === "blocked_prohibited_claim" || !data) {
    return (
      <div className="app-alert app-alert--warn case-copilot__error" role="alert">
        The AI output contained language PROOVRA cannot present and was blocked.
        AI cannot determine truth, authenticity, or admissibility.
      </div>
    );
  }
  return (
    <div className="case-copilot__result" data-case-copilot-result>
      <h4 className="case-copilot__section-title">Advisory summary</h4>
      <p className="case-copilot__summary">{data.caseSummary}</p>

      {SECTIONS.map(({ key, label }) => {
        const items = data[key] as string[];
        if (!Array.isArray(items) || items.length === 0) return null;
        return (
          <section key={key} className="case-copilot__result-section">
            <h5>{label}</h5>
            <ul>
              {items.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </section>
        );
      })}

      <section className="case-copilot__result-section">
        <h5>Validated sources</h5>
        <div className="app-copilot-sources">
          <CopilotCitationList citations={data.citations} />
        </div>
        {result.droppedCitations ? (
          <p className="case-copilot__hint">
            {result.droppedCitations} unverifiable citation(s) were removed.
          </p>
        ) : null}
      </section>

      <p className="case-copilot__boundary">{data.advisoryBoundary}</p>

      <details className="case-copilot__technical">
        <summary>Technical details</summary>
        <p>
          Output schema v{result.versionMeta?.outputSchemaVersion ?? "1"} ·
          analyzed {result.versionMeta?.contextObjectVersions?.length ?? 0} object
          version(s)
        </p>
      </details>
    </div>
  );
}

/**
 * What to tell the operator, and whether retrying can help.
 *
 * Every branch is a DIFFERENT product situation: a provider outage, a contract
 * rejection, a policy restriction and an out-of-date selection are not the same
 * problem and must not read as one. None of them exposes a status code, a
 * server code or tenant membership — the panel used to print `(INVALID_INPUT)`
 * beside the sentence, which told the user nothing and told an attacker the
 * shape of the validator.
 */
function describeFailure(
  err: unknown,
  onRefreshEvidence?: () => void,
): { message: string; retryable: boolean } {
  if (!(err instanceof ApiError)) {
    return {
      message:
        "Could not reach the AI service. Evidence workflows are unaffected.",
      retryable: true,
    };
  }
  switch (err.statusCode) {
    case 422:
      // The server ran the SAME eligibility authority and disagreed with the
      // list this panel rendered, which means the list is stale.
      onRefreshEvidence?.();
      return { message: COPILOT_SELECTION_REFRESH_MESSAGE, retryable: false };
    case 409:
      onRefreshEvidence?.();
      return {
        message:
          "A selected record changed while you were choosing. The list has been refreshed — review the selection and try again.",
        retryable: false,
      };
    case 400:
      return {
        message:
          "That selection could not be sent. Clear the selection and choose the records again.",
        retryable: false,
      };
    case 401:
      return { message: "Please sign in again.", retryable: false };
    case 403:
      return {
        message:
          "You do not have permission to run AI analysis on this case, or it is disabled by workspace policy.",
        retryable: false,
      };
    case 404:
      return {
        message: "The case or a selected record is no longer accessible.",
        retryable: false,
      };
    case 429:
      return {
        message:
          "The workspace AI limit has been reached, or requests are arriving too quickly. Try again shortly.",
        retryable: true,
      };
    case 502:
    case 503:
      return {
        message:
          "AI is temporarily unavailable. Case workflows are unaffected.",
        retryable: true,
      };
    default:
      return {
        message:
          "The AI request could not be completed. Case workflows are unaffected.",
        retryable: true,
      };
  }
}
