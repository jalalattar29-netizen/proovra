"use client";
/**
 * Phase 31.18 — Reviewer Intelligence Console.
 *
 * Operator-facing workstation surface that surfaces the workspace's
 * review-workflow status, current escalations, and active external-
 * review grants in one place.
 *
 * Consumes `/v1/investigation/reviewers` (Phase 31.18).
 *
 * Hard rules:
 *   * Tone is operational only. No forbidden vocabulary
 *     (tampered/forged/fake/authentic/admissible/proves/confirms/
 *     manipulated/doctored).
 *   * No reviewer-private data: NEVER displays reviewer email,
 *     reviewer display name, escalation_reason, rejection_reason,
 *     paused_reason, resolution_note, suppression_reason, safe_note,
 *     or token_hash.
 *   * No storage internals, no signed URLs.
 *   * Bounded polling — 60s, paused when the tab is hidden.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../../../lib/api";
import { useCan, useTeamId } from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { OperationalEmptyState } from "../../../../components/operational/OperationalEmptyState";
import { classifyInvestigationEmptyState } from "../../../../lib/empty-state/classifier";
import { formatUserDateTime } from "../../../../lib/date";
type WorkflowTotals = {
  notStarted: number;
  inProgress: number;
  escalated: number;
  paused: number;
  completed: number;
  rejected: number;
  total: number;
};

type EscalationTotals = {
  open: number;
  acknowledged: number;
  reassigned: number;
  resolved: number;
  suppressed: number;
  total: number;
};

type ExternalReviewTotals = {
  invited: number;
  active: number;
  expired: number;
  revoked: number;
  total: number;
};

type RecentEscalation = {
  id: string;
  workflowId: string;
  evidenceId: string | null;
  reason: string;
  severity: string;
  status: string;
  safeSummary: string;
  createdAtUtc: string;
};

type RecentGrant = {
  id: string;
  scopeKind: string;
  state: string;
  evidenceId: string | null;
  caseId: string | null;
  packageId: string | null;
  expiresAtUtc: string;
  createdAtUtc: string;
  accessCount: number;
};

type PendingSignal = {
  id: string;
  evidenceId: string;
  signalType: string;
  severity: string;
  confidence: string;
  safeSummary: string;
  createdAtUtc: string;
};

type ProducerModeSummary = {
  ocr: string;
  transcript: string;
  producesNewContent: boolean;
};

// Phase Repair — canonical 8-field per-kind producer status the
// reviewer console renders verbatim. Mirrors ProducerModeStatus in
// packages/shared-runtime/src/media-intelligence/producer-mode.ts.
type ProducerKind =
  | "ocr"
  | "transcript"
  | "perceptual_similarity"
  | "derivative_detection"
  | "semantic_search";

type ProducerModeStatus = {
  kind: ProducerKind;
  mode: string;
  enabled: boolean;
  configured: boolean;
  automatic: boolean;
  indexExistingOnly: boolean;
  provider: "local" | "azure" | "deepgram" | "openai" | "internal" | "none";
  reason: string;
  lastRunAt?: string;
  lastError?: string;
};

type IndexingTotals = {
  ocrAvailable: number;
  ocrIndexed: number;
  transcriptAvailable: number;
  transcriptIndexed: number;
};

// Phase Repair — local-extractor tile is now SECONDARY (the cloud
// provider chip above is the authoritative producer status). `role`
// and `summary` are new fields the route emits so the UI can render
// honest copy verbatim.
type LocalExtractorCapability = {
  role?: "secondary";
  summary?: string;
  tesseract: { ok: false; reason: string } | { ok: true };
  whisper: { ok: false; reason: string } | { ok: true };
};

// Phase Repair — bounded read-path quality marker. Empty
// `degradedBlocks` on the happy path. The page renders a single
// "data is incomplete" banner when state === "degraded".
type DataQuality = {
  state: "ok" | "degraded";
  degradedBlocks: string[];
};

type ConsoleResponse = {
  workflowTotals: WorkflowTotals;
  escalationTotals: EscalationTotals;
  externalReviewTotals: ExternalReviewTotals;
  recentEscalations: RecentEscalation[];
  recentGrants: RecentGrant[];
  pendingSignals: PendingSignal[];
  producerModes?: ProducerModeSummary;
  producerModeStatuses?: ProducerModeStatus[];
  indexingTotals?: IndexingTotals;
  localExtractorCapability?: LocalExtractorCapability;
  dataQuality?: DataQuality;
};

// Phase 38.13 — wrap in canonical PageRouteGate.
export default function ReviewerIntelligenceConsolePage() {
  return (
    <PageRouteGate routeId="investigation.reviewers">
      <ReviewerIntelligenceConsolePageInner />
    </PageRouteGate>
  );
}

function ReviewerIntelligenceConsolePageInner() {
  const teamId = useTeamId();
  // Wave 2 Phase 4 — diagnostics + admin-action gate.
  const canDiagnostics = useCan("OBSERVABILITY_VIEW");
  const [data, setData] = useState<ConsoleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Wave 2 Phase 4 — capture the underlying fetch error so the classifier
  // can resolve API_ERROR with a bounded reason.
  const [fetchError, setFetchError] = useState<Error | null>(null);
  const [lastFetchAt, setLastFetchAt] = useState<number | null>(null);
  // Phase 31.19 — bounded action state. `pendingAction` tracks the
  // signal currently being acknowledged/dismissed so the buttons
  // can render a "working…" state without a spinner. `lastAction`
  // surfaces success/failure under the row.
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<
    | { signalId: string; outcome: "ok" | "denied" | "error"; action: string }
    | null
  >(null);

  const performSignalAction = async (
    signalId: string,
    action: "ACKNOWLEDGED" | "DISMISSED",
  ) => {
    if (!teamId) return;
    setPendingAction(signalId);
    setLastAction(null);
    try {
      const res = await apiFetch(
        `/v1/media-intelligence/signals/${encodeURIComponent(signalId)}/action`,
        {
          method: "POST",
          body: JSON.stringify({ teamId, action }),
          headers: { "Content-Type": "application/json" },
        },
      );
      // The route returns { signalId, status }. Treat any non-error
      // response as success — the page will reload data on the next
      // poll tick.
      void res;
      setLastAction({ signalId, outcome: "ok", action });
      // Optimistically remove the row.
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          pendingSignals: prev.pendingSignals.filter((s) => s.id !== signalId),
        };
      });
    } catch (err: unknown) {
      // apiFetch throws on non-2xx; map 403/404 to "denied" wording
      // (anti-enumeration: both look the same to the operator).
      const msg = err instanceof Error ? err.message : "";
      const denied = /403|404|forbidden|not_found/i.test(msg);
      setLastAction({
        signalId,
        outcome: denied ? "denied" : "error",
        action,
      });
    } finally {
      setPendingAction(null);
    }
  };

  
useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const load = async () => {
      try {
        const res = (await apiFetch(
          `/v1/investigation/reviewers?teamId=${encodeURIComponent(teamId)}`,
          { method: "GET" },
        )) as ConsoleResponse;
        if (cancelled) return;
        setData(res);
        setLastFetchAt(Date.now());
        setError(null);
        setFetchError(null);
      } catch (err) {
        if (!cancelled) {
          setError("reviewer_console_unavailable");
          setFetchError(
            err instanceof Error
              ? err
              : new Error("reviewer_console_unavailable"),
          );
        }
      }
    };

    void load();
    timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void load();
    }, 60_000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [teamId]);

  const ageSeconds = useMemo(() => {
    if (!lastFetchAt) return null;
    return Math.floor((Date.now() - lastFetchAt) / 1000);
  }, [lastFetchAt]);

  return (
    <div style={pageStyle}>
      <header style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Reviewer intelligence console</h1>
          <p style={subtitleStyle}>
            Workspace-scoped reviewer activity overview. Surfaces in-flight
            review workflows, open escalations, and active external-reviewer
            grants. All projections are operator-safe; reviewer-private
            text is intentionally excluded from this surface.
          </p>
        </div>
        <div style={headerRightStyle}>
          <span style={freshnessPillStyle(error, ageSeconds, teamId)}>
            {error
              ? "Reviewer activity unavailable — retrying"
              : !teamId
                ? "loading workspace…"
                : ageSeconds == null
                  ? "loading…"
                  : `updated ${ageSeconds}s ago`}
          </span>
          <Link href="/investigation" style={pivotLinkStyle}>
            ← Investigation overview
          </Link>
        </div>
      </header>

      <section style={tilesRowStyle}>
        <TotalsTile
          title="Review workflows"
          total={data?.workflowTotals?.total ?? null}
          breakdown={
            data?.workflowTotals
              ? [
                  { label: "Not started", value: data.workflowTotals.notStarted },
                  { label: "In progress", value: data.workflowTotals.inProgress },
                  { label: "Escalated", value: data.workflowTotals.escalated },
                  { label: "Paused", value: data.workflowTotals.paused },
                  { label: "Completed", value: data.workflowTotals.completed },
                  { label: "Rejected", value: data.workflowTotals.rejected },
                ]
              : null
          }
        />
        <TotalsTile
          title="Escalations"
          total={data?.escalationTotals?.total ?? null}
          breakdown={
            data?.escalationTotals
              ? [
                  { label: "Open", value: data.escalationTotals.open },
                  { label: "Acknowledged", value: data.escalationTotals.acknowledged },
                  { label: "Reassigned", value: data.escalationTotals.reassigned },
                  { label: "Resolved", value: data.escalationTotals.resolved },
                  { label: "Suppressed", value: data.escalationTotals.suppressed },
                ]
              : null
          }
        />
        <TotalsTile
          title="External-reviewer grants"
          total={data?.externalReviewTotals?.total ?? null}
          breakdown={
            data?.externalReviewTotals
              ? [
                  { label: "Invited", value: data.externalReviewTotals.invited },
                  { label: "Active", value: data.externalReviewTotals.active },
                  { label: "Expired", value: data.externalReviewTotals.expired },
                  { label: "Revoked", value: data.externalReviewTotals.revoked },
                ]
              : null
          }
        />
      </section>

      {data?.dataQuality?.state === "degraded" ? (
        <div style={dataQualityBannerStyle}>
          Some reviewer console counters could not be loaded for this request.
          The remaining tiles still reflect real workspace state. Details:{" "}
          {data.dataQuality.degradedBlocks.join(", ")}.
        </div>
      ) : null}

      {data?.producerModeStatuses && data.producerModeStatuses.length > 0 ? (
        <section style={producerModesRowStyle}>
          {(["ocr", "transcript"] as const).map((kind) => {
            const status = data.producerModeStatuses?.find(
              (s) => s.kind === kind,
            );
            const label = kind === "ocr" ? "OCR" : "Transcript";
            return (
              <ProbeAwareProducerModeChip
                key={kind}
                label={label}
                status={status}
              />
            );
          })}
          {data.producerModeStatuses
            .filter((s) => s.kind === "ocr" || s.kind === "transcript")
            .some((s) => !s.automatic) ? (
            <span style={producerModesHintStyle}>
              Automatic extraction is not currently active for one or more
              kinds. Pre-existing content remains searchable. The chip caption
              describes the exact reason — contact your workspace administrator
              if vendor cloud is selected but the chip reports a
              credentials-not-ready state.
            </span>
          ) : null}
        </section>
      ) : data?.producerModes ? (
        <section style={producerModesRowStyle}>
          <ProducerModeChip
            label="OCR"
            mode={data.producerModes.ocr}
          />
          <ProducerModeChip
            label="Transcript"
            mode={data.producerModes.transcript}
          />
          {!data.producerModes.producesNewContent ? (
            <span style={producerModesHintStyle}>
              Automatic extraction is off — pre-existing OCR and transcript
              content is still searchable. Configuration required — contact
              your workspace administrator to enable automatic extraction.
            </span>
          ) : null}
        </section>
      ) : null}

      {data?.indexingTotals ? (
        <section style={tilesRowStyle}>
          <IndexingTile
            label="OCR records available"
            indexed={data.indexingTotals.ocrIndexed}
            available={data.indexingTotals.ocrAvailable}
          />
          <IndexingTile
            label="Transcript records available"
            indexed={data.indexingTotals.transcriptIndexed}
            available={data.indexingTotals.transcriptAvailable}
          />
          {data.localExtractorCapability ? (
            <LocalExtractorCapabilityTile
              cap={data.localExtractorCapability}
            />
          ) : null}
        </section>
      ) : null}

      <section style={sectionStyle}>
        <div style={sectionHeaderStyle}>
          <h2 style={sectionTitleStyle}>Pending media signals</h2>
          <span style={sectionCountStyle}>
            {data?.pendingSignals?.length ?? 0} pending
          </span>
        </div>
        <div style={sectionBodyStyle}>
          {data == null ? (
            <p style={emptyStyle}>Loading…</p>
          ) : data.pendingSignals.length === 0 ? (
            // Wave 2 Phase 4 — classifier-driven empty state.
            (() => {
              const { classification, reason } =
                classifyInvestigationEmptyState(
                  {
                    data: data.pendingSignals,
                    fetchError,
                    permission: "allowed",
                  },
                  "reviewers",
                );
              return (
                <div style={{ padding: 14 }}>
                  <OperationalEmptyState
                    classification={classification}
                    reason={reason}
                    nextAction={{
                      label: "Open reviewer ops",
                      href: "/reviewer-ops",
                    }}
                    adminAction={{
                      label: "Open SLA policy",
                      href: "/reviewer-ops/policy",
                    }}
                    diagnosticsLink="/operations/observability"
                    isAdmin={canDiagnostics}
                  />
                </div>
              );
            })()
          ) : (
            <ul style={listStyle}>
              {data.pendingSignals.map((sig) => (
                <PendingSignalRow
                  key={sig.id}
                  signal={sig}
                  pending={pendingAction === sig.id}
                  lastAction={
                    lastAction?.signalId === sig.id ? lastAction : null
                  }
                  onAck={() => void performSignalAction(sig.id, "ACKNOWLEDGED")}
                  onDismiss={() => void performSignalAction(sig.id, "DISMISSED")}
                />
              ))}
            </ul>
          )}
        </div>
      </section>

      <section style={twoColumnStyle}>
        <ListSection title="Open escalations">
          {data == null ? (
            <p style={emptyStyle}>Loading…</p>
          ) : data.recentEscalations.length === 0 ? (
            // Wave 2 Phase 4 — classifier-driven empty state.
            (() => {
              const { classification, reason } =
                classifyInvestigationEmptyState(
                  {
                    data: data.recentEscalations,
                    fetchError,
                    permission: "allowed",
                  },
                  "reviewers",
                );
              return (
                <div style={{ padding: 14 }}>
                  <OperationalEmptyState
                    classification={classification}
                    reason={reason}
                    nextAction={{
                      label: "Open reviewer ops",
                      href: "/reviewer-ops",
                    }}
                    adminAction={{
                      label: "Open SLA policy",
                      href: "/reviewer-ops/policy",
                    }}
                    diagnosticsLink="/operations/observability"
                    isAdmin={canDiagnostics}
                  />
                </div>
              );
            })()
          ) : (
            <ul style={listStyle}>
              {data.recentEscalations.map((esc) => (
                <EscalationRow key={esc.id} esc={esc} />
              ))}
            </ul>
          )}
        </ListSection>
        <ListSection title="Active external-reviewer grants">
          {data == null ? (
            <p style={emptyStyle}>Loading…</p>
          ) : data.recentGrants.length === 0 ? (
            // Wave 2 Phase 4 — classifier-driven empty state.
            (() => {
              const { classification, reason } =
                classifyInvestigationEmptyState(
                  {
                    data: data.recentGrants,
                    fetchError,
                    permission: "allowed",
                  },
                  "reviewers",
                );
              return (
                <div style={{ padding: 14 }}>
                  <OperationalEmptyState
                    classification={classification}
                    reason={reason}
                    nextAction={{
                      label: "Invite external reviewer",
                      href: "/review/external",
                    }}
                    adminAction={{
                      label: "Open external review settings",
                      href: "/review/external",
                    }}
                    diagnosticsLink="/operations/observability"
                    isAdmin={canDiagnostics}
                  />
                </div>
              );
            })()
          ) : (
            <ul style={listStyle}>
              {data.recentGrants.map((g) => (
                <GrantRow key={g.id} grant={g} />
              ))}
            </ul>
          )}
        </ListSection>
      </section>
    </div>
  );
}

function TotalsTile({
  title,
  total,
  breakdown,
}: {
  title: string;
  total: number | null;
  breakdown: Array<{ label: string; value: number }> | null;
}) {
  return (
    <div style={tileStyle}>
      <div style={tileTitleStyle}>{title}</div>
      <div style={tileTotalStyle}>{total == null ? "—" : total}</div>
      {breakdown ? (
        <ul style={tileBreakdownStyle}>
          {breakdown.map((b) => (
            <li key={b.label} style={tileBreakdownRowStyle}>
              <span style={tileBreakdownLabelStyle}>{b.label}</span>
              <span style={tileBreakdownValueStyle}>{b.value}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ListSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section style={sectionStyle}>
      <div style={sectionHeaderStyle}>
        <h2 style={sectionTitleStyle}>{title}</h2>
      </div>
      <div style={sectionBodyStyle}>{children}</div>
    </section>
  );
}

function IndexingTile({
  label,
  indexed,
  available,
}: {
  label: string;
  indexed: number;
  available: number;
}) {
  // Phase Repair — `allIndexed` MUST require at least one available
  // row. The previous expression `available === 0 || indexed ===
  // available` rendered the green "all indexed" pill on an empty
  // workspace, which conflated "nothing has been extracted" with
  // "everything that exists is indexed". Now empty workspaces render
  // a neutral "No records yet" pill and the green state only fires
  // when there is real content AND every row is indexed.
  const empty = available === 0;
  const allIndexed = available > 0 && indexed === available;
  return (
    <div style={tileStyle}>
      <div style={tileTitleStyle}>{label}</div>
      <div style={tileTotalStyle}>{available}</div>
      <div style={indexingProgressRowStyle}>
        <span style={mutedSmallStyle}>{indexed} indexed</span>
        <span style={statusPillStyle(allIndexed && !empty)}>
          {empty
            ? "No records yet"
            : allIndexed
              ? "all indexed"
              : "indexing pending"}
        </span>
      </div>
    </div>
  );
}

function LocalExtractorCapabilityTile({
  cap,
}: {
  cap: LocalExtractorCapability;
}) {
  // Phase Repair — local runtimes are SECONDARY. The cloud provider
  // chip above is the authoritative producer status; this tile only
  // surfaces whether local binaries are present (they are not, by
  // policy). Demoted visually + an explicit summary string. The
  // summary string is rendered verbatim from the route — UI never
  // invents its own disclaimer copy.
  const tesseractEnabled = cap.tesseract.ok;
  const whisperEnabled = cap.whisper.ok;
  const summary =
    cap.summary ??
    "Local OCR/transcript runtime is not enabled. Cloud provider is the active path.";
  return (
    <div style={secondaryTileStyle}>
      <div style={secondaryTileBadgeStyle}>Secondary</div>
      <div style={tileTitleStyle}>Local extractor runtimes</div>
      <p style={secondaryTileSummaryStyle}>{summary}</p>
      <ul style={tileBreakdownStyle}>
        <li style={tileBreakdownRowStyle}>
          <span style={tileBreakdownLabelStyle}>Local OCR (Tesseract)</span>
          <span style={statusPillStyle(tesseractEnabled)}>
            {tesseractEnabled ? "enabled" : "not enabled"}
          </span>
        </li>
        <li style={tileBreakdownRowStyle}>
          <span style={tileBreakdownLabelStyle}>Local transcript (Whisper)</span>
          <span style={statusPillStyle(whisperEnabled)}>
            {whisperEnabled ? "enabled" : "not enabled"}
          </span>
        </li>
      </ul>
    </div>
  );
}

function ProducerModeChip({ label, mode }: { label: string; mode: string }) {
  const isConfigured =
    mode !== "NOT_CONFIGURED" && mode !== "INDEX_EXISTING_ONLY";
  return (
    <span style={producerModeChipStyle(isConfigured)}>
      {label}: {formatModeLabel(mode)}
    </span>
  );
}

// Phase Repair — probe-aware OCR / Transcript chip. Renders the
// route's canonical `ProducerModeStatus` verbatim (label + bounded
// mode caption + honest reason text). Hard rules:
//   * The chip's ACTIVE styling fires ONLY when `automatic === true`.
//     `VENDOR_CLOUD` mode with `automatic === false` (the
//     credentials-not-ready / producer-deferred state) renders the
//     muted / warning style, NOT the green active style — this is
//     the audit requirement: VENDOR_CLOUD must not look active when
//     credentials/probe fail.
//   * The chip body always shows the bounded `mode` token plus the
//     reason copy the route emits.
function ProbeAwareProducerModeChip({
  label,
  status,
}: {
  label: string;
  status: ProducerModeStatus | undefined;
}) {
  if (!status) {
    return (
      <span style={producerModeChipStyle(false)}>
        {label}: status unavailable
      </span>
    );
  }
  const active = status.automatic === true;
  const caption =
    status.mode === "VENDOR_CLOUD" && !active
      ? `${formatModeLabel(status.mode)} (credentials not ready)`
      : formatModeLabel(status.mode);
  return (
    <span
      style={producerModeChipStyle(active)}
      title={status.reason}
      data-kind={status.kind}
      data-mode={status.mode}
      data-automatic={active ? "true" : "false"}
      data-provider={status.provider}
    >
      {label}: {caption}
    </span>
  );
}

function formatModeLabel(mode: string): string {
  switch (mode) {
    case "NOT_CONFIGURED":
      return "automatic extraction off";
    case "INDEX_EXISTING_ONLY":
      return "existing content searchable";
    case "LOCAL_TESSERACT":
      return "local Tesseract";
    case "LOCAL_WHISPER":
      return "local Whisper";
    case "VENDOR_CLOUD":
      return "vendor cloud";
    default:
      return mode.toLowerCase();
  }
}

function PendingSignalRow({
  signal,
  pending,
  lastAction,
  onAck,
  onDismiss,
}: {
  signal: PendingSignal;
  pending: boolean;
  lastAction:
    | { signalId: string; outcome: "ok" | "denied" | "error"; action: string }
    | null;
  onAck: () => void;
  onDismiss: () => void;
}) {
  return (
    <li style={rowStyle}>
      <div style={rowHeaderStyle}>
        <span style={severityBadgeStyle(signal.severity)}>
          {signal.severity.toLowerCase()}
        </span>
        <span style={reasonChipStyle}>{signal.signalType}</span>
        <span style={statusBadgeStyle(signal.confidence)}>
          {signal.confidence.toLowerCase()} confidence
        </span>
        <span style={timestampStyle}>{formatDateTime(signal.createdAtUtc)}</span>
      </div>
      <div style={summaryStyle}>{signal.safeSummary}</div>
      <div style={pivotsRowStyle}>
        <Link
          href={`/evidence/${signal.evidenceId}`}
          style={pivotLinkSmallStyle}
        >
          Open evidence
        </Link>
        <button
          type="button"
          onClick={onAck}
          disabled={pending}
          style={actionButtonStyle(pending, "ack")}
        >
          {pending ? "Working…" : "Acknowledge"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={pending}
          style={actionButtonStyle(pending, "dismiss")}
        >
          {pending ? "Working…" : "Dismiss"}
        </button>
      </div>
      {lastAction ? (
        <div style={actionResultStyle(lastAction.outcome)}>
          {lastAction.outcome === "ok"
            ? `Recorded ${lastAction.action.toLowerCase()}.`
            : lastAction.outcome === "denied"
              ? "Action not permitted for this signal."
              : "Action could not be recorded — try again."}
        </div>
      ) : null}
    </li>
  );
}

function EscalationRow({ esc }: { esc: RecentEscalation }) {
  return (
    <li style={rowStyle}>
      <div style={rowHeaderStyle}>
        <span style={severityBadgeStyle(esc.severity)}>
          {esc.severity.toLowerCase()}
        </span>
        <span style={statusBadgeStyle(esc.status)}>{esc.status.toLowerCase()}</span>
        <span style={reasonChipStyle}>{esc.reason}</span>
        <span style={timestampStyle}>{formatDateTime(esc.createdAtUtc)}</span>
      </div>
      <div style={summaryStyle}>{esc.safeSummary}</div>
      <div style={pivotsRowStyle}>
        {esc.evidenceId ? (
          <Link href={`/evidence/${esc.evidenceId}`} style={pivotLinkSmallStyle}>
            Open evidence
          </Link>
        ) : null}
        <Link
          href={`/investigation/relationships?nodeId=${encodeURIComponent(esc.id)}`}
          style={pivotLinkSmallStyle}
        >
          Inspect graph
        </Link>
      </div>
    </li>
  );
}

function GrantRow({ grant }: { grant: RecentGrant }) {
  return (
    <li style={rowStyle}>
      <div style={rowHeaderStyle}>
        <span style={scopeBadgeStyle(grant.scopeKind)}>
          {grant.scopeKind.toLowerCase()}
        </span>
        <span style={statusBadgeStyle(grant.state)}>{grant.state.toLowerCase()}</span>
        <span style={timestampStyle}>
          expires {formatDateTime(grant.expiresAtUtc)}
        </span>
      </div>
      <div style={summaryStyle}>
        Created {formatDateTime(grant.createdAtUtc)} ·{" "}
        {grant.accessCount === 0
          ? "not yet accessed"
          : `${grant.accessCount} access${grant.accessCount === 1 ? "" : "es"}`}
      </div>
      <div style={pivotsRowStyle}>
        {grant.evidenceId ? (
          <Link
            href={`/evidence/${grant.evidenceId}`}
            style={pivotLinkSmallStyle}
          >
            Open evidence
          </Link>
        ) : null}
        {grant.caseId ? (
          <Link
            href={`/investigation/cases/${grant.caseId}/graph`}
            style={pivotLinkSmallStyle}
          >
            Open case graph
          </Link>
        ) : null}
      </div>
    </li>
  );
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return formatUserDateTime(iso);
  } catch {
    return iso;
  }
}

const pageStyle: React.CSSProperties = {
  padding: 24,
  maxWidth: 1280,
  margin: "0 auto",
  fontFamily:
    "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  color: "#0f172a",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 16,
  marginBottom: 20,
};

const headerRightStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  gap: 6,
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 22,
  fontWeight: 700,
};

const subtitleStyle: React.CSSProperties = {
  margin: "4px 0 0 0",
  fontSize: 13,
  color: "#64748b",
  maxWidth: 760,
  lineHeight: 1.5,
};

const pivotLinkStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#1e40af",
  textDecoration: "none",
};

const pivotLinkSmallStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#1e40af",
  textDecoration: "none",
  background: "#eff6ff",
  border: "1px solid #bfdbfe",
  borderRadius: 6,
  padding: "3px 10px",
  whiteSpace: "nowrap",
};

function freshnessPillStyle(
  err: string | null,
  ageSeconds: number | null,
  teamId: string | null,
): React.CSSProperties {
  let bg = "#eff6ff";
  let border = "#bfdbfe";
  let color = "#1e40af";
  if (err) {
    bg = "#fef2f2";
    border = "#fca5a5";
    color = "#991b1b";
  } else if (!teamId || ageSeconds == null) {
    bg = "#f1f5f9";
    border = "#cbd5e1";
    color = "#334155";
  } else if (ageSeconds > 180) {
    bg = "#fffbeb";
    border = "#fcd34d";
    color = "#92400e";
  }
  return {
    padding: "4px 12px",
    fontSize: 11,
    fontWeight: 600,
    background: bg,
    border: `1px solid ${border}`,
    color,
    borderRadius: 999,
    whiteSpace: "nowrap",
  };
}

const tilesRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: 12,
  marginBottom: 20,
};

const tileStyle: React.CSSProperties = {
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: 14,
};

const tileTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#475569",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const tileTotalStyle: React.CSSProperties = {
  fontSize: 28,
  fontWeight: 700,
  color: "#0f172a",
  marginTop: 4,
  marginBottom: 10,
};

const tileBreakdownStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const tileBreakdownRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  fontSize: 12,
};

const tileBreakdownLabelStyle: React.CSSProperties = {
  color: "#64748b",
};

const tileBreakdownValueStyle: React.CSSProperties = {
  color: "#0f172a",
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
};

const twoColumnStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 16,
};

const sectionStyle: React.CSSProperties = {
  background: "#ffffff",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  overflow: "hidden",
};

const sectionHeaderStyle: React.CSSProperties = {
  padding: "10px 14px",
  background: "#f1f5f9",
  borderBottom: "1px solid #e2e8f0",
};

const sectionTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontWeight: 700,
  color: "#0f172a",
};

const sectionCountStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#64748b",
  fontWeight: 500,
};

const sectionBodyStyle: React.CSSProperties = {
  padding: 0,
};

const emptyStyle: React.CSSProperties = {
  margin: 0,
  padding: 14,
  fontSize: 12,
  color: "#64748b",
  lineHeight: 1.5,
  fontStyle: "italic",
};

const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
};

const rowStyle: React.CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid #f1f5f9",
};

const rowHeaderStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  flexWrap: "wrap",
  marginBottom: 6,
};

function severityBadgeStyle(severity: string): React.CSSProperties {
  const norm = severity.toUpperCase();
  let bg = "#f1f5f9";
  let border = "#cbd5e1";
  let color = "#475569";
  if (norm === "CRITICAL") {
    bg = "#fef2f2";
    border = "#fca5a5";
    color = "#991b1b";
  } else if (norm === "HIGH") {
    bg = "#fffbeb";
    border = "#fcd34d";
    color = "#92400e";
  } else if (norm === "WARNING") {
    bg = "#fffbeb";
    border = "#fde68a";
    color = "#92400e";
  }
  return {
    padding: "2px 8px",
    fontSize: 11,
    fontWeight: 700,
    background: bg,
    border: `1px solid ${border}`,
    color,
    borderRadius: 999,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  };
}

function statusBadgeStyle(_status: string): React.CSSProperties {
  return {
    padding: "2px 8px",
    fontSize: 11,
    fontWeight: 600,
    background: "#f1f5f9",
    border: "1px solid #cbd5e1",
    color: "#475569",
    borderRadius: 999,
    textTransform: "lowercase",
  };
}

function scopeBadgeStyle(scope: string): React.CSSProperties {
  const norm = scope.toUpperCase();
  const palette: Record<string, [string, string, string]> = {
    EVIDENCE: ["#ecfdf5", "#bbf7d0", "#166534"],
    CASE: ["#eff6ff", "#bfdbfe", "#1e40af"],
    PACKAGE: ["#f5f3ff", "#ddd6fe", "#5b21b6"],
  };
  const [bg, border, color] = palette[norm] ?? [
    "#f1f5f9",
    "#cbd5e1",
    "#475569",
  ];
  return {
    padding: "2px 8px",
    fontSize: 11,
    fontWeight: 700,
    background: bg,
    border: `1px solid ${border}`,
    color,
    borderRadius: 999,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  };
}

const reasonChipStyle: React.CSSProperties = {
  padding: "2px 8px",
  fontSize: 11,
  fontWeight: 600,
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  color: "#475569",
  borderRadius: 6,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

const timestampStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#64748b",
  marginLeft: "auto",
};

const summaryStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#475569",
  lineHeight: 1.5,
  marginBottom: 6,
};

const pivotsRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
  alignItems: "center",
};

const indexingProgressRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  marginTop: 8,
};

const mutedSmallStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#64748b",
};

function statusPillStyle(positive: boolean): React.CSSProperties {
  return {
    padding: "2px 8px",
    fontSize: 11,
    fontWeight: 600,
    background: positive ? "#ecfdf5" : "#f1f5f9",
    border: `1px solid ${positive ? "#bbf7d0" : "#cbd5e1"}`,
    color: positive ? "#166534" : "#475569",
    borderRadius: 999,
  };
}

const producerModesRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flexWrap: "wrap",
  marginBottom: 18,
  padding: 12,
  background: "#fffbeb",
  border: "1px solid #fcd34d",
  borderRadius: 8,
};

const producerModesHintStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#92400e",
  lineHeight: 1.5,
};

// Phase Repair — visually demoted tile for the SECONDARY local
// extractor capability surface. Muted background + smaller padding +
// "Secondary" badge tells the operator at a glance the cloud chip
// above is the authoritative producer status.
const secondaryTileStyle: React.CSSProperties = {
  background: "#f8fafc",
  border: "1px dashed #cbd5e1",
  borderRadius: 8,
  padding: 12,
  opacity: 0.92,
};

const secondaryTileBadgeStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "1px 8px",
  fontSize: 10,
  fontWeight: 700,
  background: "#e2e8f0",
  border: "1px solid #cbd5e1",
  color: "#475569",
  borderRadius: 999,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  marginBottom: 6,
};

const secondaryTileSummaryStyle: React.CSSProperties = {
  margin: "4px 0 8px 0",
  fontSize: 11,
  color: "#64748b",
  lineHeight: 1.5,
};

// Phase Repair — bounded data-quality banner. Surfaces the route's
// `degradedBlocks` list when any read sub-query failed. Block tags
// are bounded enum strings (workflow_totals / escalation_totals /
// external_review_totals / recent_escalations / recent_grants /
// indexing_totals / producer_modes). No SQL details / table names.
const dataQualityBannerStyle: React.CSSProperties = {
  marginBottom: 12,
  padding: "8px 12px",
  background: "#fffbeb",
  border: "1px solid #fcd34d",
  color: "#92400e",
  borderRadius: 6,
  fontSize: 12,
  lineHeight: 1.5,
};

function producerModeChipStyle(configured: boolean): React.CSSProperties {
  return {
    padding: "3px 10px",
    fontSize: 11,
    fontWeight: 700,
    background: configured ? "#ecfdf5" : "#fef3c7",
    border: `1px solid ${configured ? "#bbf7d0" : "#fcd34d"}`,
    color: configured ? "#166534" : "#92400e",
    borderRadius: 999,
    textTransform: "uppercase",
    letterSpacing: "0.03em",
  };
}

function actionButtonStyle(
  pending: boolean,
  variant: "ack" | "dismiss",
): React.CSSProperties {
  const base: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    border: "1px solid",
    borderRadius: 6,
    padding: "3px 10px",
    cursor: pending ? "not-allowed" : "pointer",
    whiteSpace: "nowrap",
    opacity: pending ? 0.6 : 1,
  };
  if (variant === "ack") {
    return {
      ...base,
      color: "#166534",
      background: "#ecfdf5",
      borderColor: "#bbf7d0",
    };
  }
  return {
    ...base,
    color: "#475569",
    background: "#f8fafc",
    borderColor: "#cbd5e1",
  };
}

function actionResultStyle(
  outcome: "ok" | "denied" | "error",
): React.CSSProperties {
  let bg = "#ecfdf5";
  let border = "#bbf7d0";
  let color = "#166534";
  if (outcome === "denied") {
    bg = "#fffbeb";
    border = "#fcd34d";
    color = "#92400e";
  } else if (outcome === "error") {
    bg = "#fef2f2";
    border = "#fca5a5";
    color = "#991b1b";
  }
  return {
    marginTop: 6,
    padding: "4px 10px",
    fontSize: 11,
    fontWeight: 600,
    background: bg,
    border: `1px solid ${border}`,
    color,
    borderRadius: 6,
    display: "inline-block",
  };
}
