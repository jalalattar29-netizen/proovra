/**
 * EVIDENCE RECORD SECTIONS — the touch port of the web Evidence Detail
 * presentation that sits around and inside its tabs: the integrity banner,
 * the shared record rail, the Overview preview/summary, the Integrity
 * matrix, the grouped Custody timelines, the Artifacts lifecycle panel and
 * public-verification facts, and the Review hero / lifecycle card.
 *
 * Presentation only. Every value arrives already projected by
 * src/product/evidence-record.ts; nothing here decides a verdict.
 */
import React, { useState } from "react";
import { Image, Linking, Pressable, StyleSheet, View } from "react-native";

import { formatUserDateTime } from "../lib/date";
import type { RiskSignal } from "../product/evidence-detail";
import {
  ARCHIVE_AS_ALTERNATIVE_COPY,
  CUSTODY_TIMELINE_COPY,
  DESTROYED_COPY,
  INTEGRITY_FAILED_COPY,
  INTEGRITY_STATE_PRESENTATION,
  PREVIEW_COPY,
  REVIEWER_STATUS_DISCLAIMER,
  WORKSPACE_UNRESOLVED_NOTE,
  describePublicVerificationState,
  formatReviewerStatusLabel,
  groupCustodyByDay,
  outputPanelCopy,
  outputPanelShowsAction,
  priorityTone,
  publicVerificationCounter,
  publicVerificationTone,
  retentionPosture,
  trashUnavailableMessage,
  workflowStatusTone,
  type CaptureTemplateView,
  type CustodyTimelineEvent,
  type LifecycleProjection,
  type MatrixRow,
  type OutputView,
  type PreviewItem,
  type PublicVerificationView,
  type RecordView,
  type SnapshotTiming,
} from "../product/evidence-record";
import { theme } from "../theme/theme";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraSection, ProovraText } from "./index";

/* --------------------------------------------------------------- primitives */

/** A label/value grid — the web `evidence-detail-facts-grid`. */
export function FactsGrid({ items, testID }: { items: ReadonlyArray<{ label: string; value: string }>; testID?: string }) {
  return (
    <View style={styles.grid} testID={testID}>
      {items.map((it) => (
        <View key={it.label} style={styles.fact}>
          <ProovraText variant="label" color={theme.color.ink.muted}>{it.label}</ProovraText>
          <ProovraText variant="bodySm" weight="semibold">{it.value}</ProovraText>
        </View>
      ))}
    </View>
  );
}

/** The web BoundaryNote / BoundaryCallout — a titled, tinted note. */
export function BoundaryNote({ title, body, tone = "neutral", testID }: { title: string; body: string; tone?: "neutral" | "warn" | "danger"; testID?: string }) {
  const palette = tone === "danger" ? theme.color.status.risk : tone === "warn" ? theme.color.status.pending : theme.color.status.neutral;
  return (
    <View testID={testID} style={[styles.note, { backgroundColor: palette.bg, borderColor: palette.border }]}>
      <ProovraText variant="label" weight="semibold" color={palette.fg}>{title}</ProovraText>
      <ProovraText variant="label" color={theme.color.ink.secondary}>{body}</ProovraText>
    </View>
  );
}

/** A native <details>: the header toggles, the body renders only when open. */
export function Disclosure({ title, children, testID, initiallyOpen = false }: { title: string; children: React.ReactNode; testID?: string; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <View testID={testID} style={styles.disclosure}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: open }}
        style={styles.disclosureHead}
      >
        <ProovraText variant="bodySm" weight="semibold" style={{ flex: 1 }}>{title}</ProovraText>
        <ProovraText variant="bodySm" color={theme.color.ink.muted}>{open ? "−" : "+"}</ProovraText>
      </Pressable>
      {open ? <View style={styles.disclosureBody}>{children}</View> : null}
    </View>
  );
}

function Alert({ title, body, tone, children, testID }: { title: string; body: string; tone: "warn" | "info" | "danger"; children?: React.ReactNode; testID?: string }) {
  const palette = tone === "danger" ? theme.color.status.risk : tone === "warn" ? theme.color.status.pending : theme.color.status.info;
  return (
    <View testID={testID} style={[styles.alert, { backgroundColor: palette.bg, borderColor: palette.border }]}>
      <ProovraText variant="bodySm" weight="semibold" color={palette.fg}>{title}</ProovraText>
      <ProovraText variant="label" color={theme.color.ink.secondary}>{body}</ProovraText>
      {children}
    </View>
  );
}

/* ----------------------------------------------------------- integrity banner */

export function IntegrityFailedBanner() {
  return <Alert testID="evidence-integrity-failed" tone="danger" title={INTEGRITY_FAILED_COPY.title} body={INTEGRITY_FAILED_COPY.body} />;
}

/* ------------------------------------------------------------------- rail */

/**
 * EvidenceRecordRail.tsx — ONE rail for every tab: Risk Signals (top four),
 * Review Workflow, Attributes, Public Verification. On a phone it sits below
 * the tab body rather than beside it.
 */
export function EvidenceRecordRail({
  signals,
  record,
  publicVerification,
  shareUrl,
}: {
  signals: RiskSignal[];
  record: RecordView;
  publicVerification: PublicVerificationView | null;
  shareUrl: string | null;
}) {
  const pv = describePublicVerificationState(publicVerification);
  const status = record.workflow.status;
  return (
    <ProovraCard testID="evidence-record-rail">
      <View style={styles.stack}>
        <View style={styles.stackTight}>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>RISK SIGNALS</ProovraText>
          {signals.length === 0 ? (
            <ProovraText variant="label" color={theme.color.ink.muted}>No advisory risk signals in the current response.</ProovraText>
          ) : (
            signals.slice(0, 4).map((sig) => (
              <View
                key={`${sig.title}-${sig.detail}`}
                style={[
                  styles.signal,
                  { borderColor: (sig.severity === "danger" ? theme.color.status.risk : sig.severity === "warning" ? theme.color.status.pending : theme.color.status.neutral).border },
                ]}
              >
                <ProovraText variant="label" weight="semibold">{sig.title}</ProovraText>
                {sig.detail ? <ProovraText variant="label" color={theme.color.ink.secondary}>{sig.detail}</ProovraText> : null}
              </View>
            ))
          )}
        </View>
        <View style={styles.stackTight}>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>REVIEW WORKFLOW</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.muted}>Operational summary</ProovraText>
          <View style={styles.row}>
            <ProovraBadge tone={workflowStatusTone(status)} label={status ? status.replace(/_/g, " ") : "Not started"} />
          </View>
          <View style={styles.railField}>
            <ProovraText variant="label" color={theme.color.ink.muted}>Priority</ProovraText>
            <ProovraBadge tone={priorityTone(record.workflow.priority)} label={record.workflow.priority || "Not configured"} />
          </View>
        </View>
        <View style={styles.stackTight}>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>ATTRIBUTES</ProovraText>
          <View style={styles.railField}>
            <ProovraText variant="label" color={theme.color.ink.muted}>Case</ProovraText>
            <ProovraText variant="label" weight="semibold">{record.caseName || "Unassigned"}</ProovraText>
          </View>
          <View style={styles.railField}>
            <ProovraText variant="label" color={theme.color.ink.muted}>Due date</ProovraText>
            <ProovraText variant="label" weight="semibold">{record.workflow.dueAt ? formatUserDateTime(record.workflow.dueAt) : "Not available"}</ProovraText>
          </View>
        </View>
        <View style={styles.stackTight}>
          <View style={styles.railField}>
            <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>PUBLIC VERIFICATION</ProovraText>
            <ProovraBadge tone={publicVerificationTone(publicVerification?.state ?? null)} label={pv.label} />
          </View>
          {shareUrl ? (
            <ProovraButton label="Open verification surface" variant="ghost" fullWidth={false} onPress={() => void Linking.openURL(shareUrl)} />
          ) : (
            <ProovraText variant="label" color={theme.color.ink.muted}>{publicVerification ? pv.detail : "No publication detail available."}</ProovraText>
          )}
        </View>
      </View>
    </ProovraCard>
  );
}

/* --------------------------------------------------------------- overview */

export function CaptureNoteCard({ note }: { note: string }) {
  return (
    <ProovraSection title="Capture note (private)">
      <ProovraCard testID="evidence-capture-note">
        <ProovraText variant="bodySm">{note}</ProovraText>
        <ProovraText variant="label" color={theme.color.ink.muted}>
          Visible only inside the signed-in app. Excluded from public verification, the fixed PDF report, and the verification package.
        </ProovraText>
      </ProovraCard>
    </ProovraSection>
  );
}

export function CaptureTemplateCard({ template }: { template: CaptureTemplateView }) {
  return (
    <ProovraCard testID="evidence-capture-template">
      <FactsGrid items={template.items.map((i) => ({ label: i.label, value: i.ok ? `${i.value} ✓` : i.value }))} />
      {template.missing.length > 0 ? (
        <Alert
          tone="warn"
          title={`Unmapped required step${template.missing.length === 1 ? "" : "s"}:`}
          body={template.missing.join(" · ")}
        />
      ) : null}
    </ProovraCard>
  );
}

/**
 * `_lib.tsx:780` PreviewWorkspace — the selected item's preview, the original
 * access action, and a card per file that switches the preview. Image items
 * render inline; every other kind points to the original, as the web's
 * placeholder does when it has no player.
 */
export function EvidencePreview({
  items,
  defaultId,
  onOpenOriginal,
  originalBusy,
  originalRefusal,
}: {
  items: PreviewItem[];
  defaultId: string | null;
  onOpenOriginal: () => void;
  originalBusy: boolean;
  originalRefusal: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(defaultId);
  const selected = items.find((i) => i.id === selectedId) ?? items.find((i) => i.id === defaultId) ?? null;
  return (
    <ProovraSection title={PREVIEW_COPY.title}>
      <ProovraCard testID="evidence-preview">
        {!selected || !selected.viewUrl ? (
          <View style={styles.placeholder}>
            <ProovraText variant="bodySm" weight="semibold">{PREVIEW_COPY.noPreviewTitle}</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.muted}>{PREVIEW_COPY.noPreviewBody}</ProovraText>
          </View>
        ) : selected.kind === "image" ? (
          <Image source={{ uri: selected.viewUrl }} style={styles.previewImage} resizeMode="contain" accessibilityLabel={selected.label} />
        ) : (
          <View style={styles.placeholder} testID="evidence-preview-unsupported">
            <ProovraText variant="bodySm" weight="semibold">{PREVIEW_COPY.unsupportedTitle}</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.secondary}>
              {`${selected.originalFileName || selected.label} — ${selected.kind}${selected.sizeLabel !== "Not recorded" ? ` · ${selected.sizeLabel}` : ""}`}
            </ProovraText>
            <ProovraText variant="label" color={theme.color.ink.muted}>{PREVIEW_COPY.unsupportedBody}</ProovraText>
          </View>
        )}
        {originalRefusal ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>{originalRefusal}</ProovraText>
        ) : (
          <ProovraButton label="Open original" accessibilityLabel="Open original file" variant="secondary" fullWidth={false} loading={originalBusy} onPress={onOpenOriginal} />
        )}
      </ProovraCard>
      {items.length > 0 ? (
        <View style={styles.stackTight} accessibilityLabel="Evidence files">
          {items.map((it) => {
            const isSelected = it.id === selected?.id;
            return (
              <Pressable
                key={it.id}
                onPress={() => setSelectedId(it.id)}
                accessibilityRole="button"
                accessibilityLabel={`Preview ${it.label}`}
                accessibilityState={{ selected: isSelected }}
                style={[
                  styles.itemCard,
                  { borderColor: isSelected ? theme.color.accent.a500 : theme.color.border.default, backgroundColor: isSelected ? theme.color.accent.a050 : theme.color.surface.card },
                ]}
              >
                <View style={styles.railField}>
                  <ProovraText variant="bodySm" weight="semibold" style={{ flex: 1 }}>{it.label}</ProovraText>
                  <ProovraBadge tone={it.kind === "image" ? "governance" : it.kind === "pdf" ? "info" : it.kind === "video" ? "pending" : "neutral"} label={it.kind} />
                </View>
                <ProovraText variant="label" color={theme.color.ink.muted}>{it.originalFileName || "Original filename not recorded"}</ProovraText>
                <InlineFact label="Size" value={it.sizeLabel} />
                <InlineFact label="Role" value={it.role} />
                {it.privateRole ? <InlineFact label="Capture role (private)" value={it.privateRole} /> : null}
                {it.sourceLabel ? <InlineFact label="Source" value={it.sourceLabel} /> : null}
                {it.privateNote ? <InlineFact label="Private item note" value={it.privateNote} /> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </ProovraSection>
  );
}

function InlineFact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.railField}>
      <ProovraText variant="label" color={theme.color.ink.muted}>{label}</ProovraText>
      <ProovraText variant="label" weight="semibold" style={styles.inlineValue}>{value}</ProovraText>
    </View>
  );
}

export function RecordSummaryCard({ items }: { items: Array<{ label: string; value: string }> }) {
  return (
    <ProovraSection title="Record Summary">
      <ProovraCard testID="evidence-record-summary">
        <FactsGrid items={items} />
      </ProovraCard>
    </ProovraSection>
  );
}

export function NextActionsCard({ actions }: { actions: string[] }) {
  return (
    <ProovraCard testID="evidence-next-actions" style={{ borderColor: theme.color.accent.a500 }}>
      <ProovraText variant="bodySm" weight="semibold" color={theme.color.accent.a600}>Recommended next actions</ProovraText>
      {actions.map((a) => (
        <ProovraText key={a} variant="label" color={theme.color.ink.secondary}>{`• ${a}`}</ProovraText>
      ))}
    </ProovraCard>
  );
}

/* --------------------------------------------------------------- integrity */

export function IntegritySection({ title, description, action, children, testID }: { title: string; description: string; action?: React.ReactNode; children: React.ReactNode; testID?: string }) {
  return (
    <ProovraCard testID={testID}>
      <View style={styles.stackTight}>
        <ProovraText variant="h3" weight="semibold">{title}</ProovraText>
        <ProovraText variant="label" color={theme.color.ink.muted}>{description}</ProovraText>
        {action}
      </View>
      <View style={styles.stack}>{children}</View>
    </ProovraCard>
  );
}

/** EvidenceIntegrityTab.tsx MatrixGrid — the state word as a tone badge beside each value. */
export function PreservationMatrix({ rows }: { rows: MatrixRow[] }) {
  return (
    <View testID="evidence-preservation-matrix">
      {rows.map((r) => {
        const pres = r.state ? INTEGRITY_STATE_PRESENTATION[r.state] : null;
        return (
          <View key={r.label} style={styles.matrixRow}>
            <View style={styles.railField}>
              <ProovraText variant="label" color={theme.color.ink.muted} style={{ flex: 1 }}>{r.label}</ProovraText>
              {pres ? <ProovraBadge tone={pres.tone} label={pres.label} /> : null}
            </View>
            <ProovraText variant="bodySm">{r.value}</ProovraText>
          </View>
        );
      })}
    </View>
  );
}

export function SnapshotTimingSection({ timing }: { timing: SnapshotTiming }) {
  return (
    <IntegritySection
      testID="evidence-snapshot-timing"
      title="Snapshot timing"
      description="When the fixed materials were generated, and whether the custody chain recorded since then is continuous."
    >
      <FactsGrid items={timing.facts} />
      {timing.fixedArtifactNote ? <BoundaryNote title="Record boundary noted" body={timing.fixedArtifactNote} /> : null}
      {timing.divergence ? (
        <BoundaryNote
          testID="evidence-snapshot-divergence"
          title="Boundary updated"
          body={timing.divergence.body}
          tone={timing.divergence.tone === "danger" ? "danger" : timing.divergence.tone === "warn" ? "warn" : "neutral"}
        />
      ) : null}
    </IntegritySection>
  );
}

/* ----------------------------------------------------------------- custody */

function dayTitle(day: string): string {
  if (day === "Undated") return "Undated";
  return formatUserDateTime(`${day}T00:00:00Z`)?.split(",")[0] ?? day;
}
function eventTime(atUtc: string | null): string {
  const full = atUtc ? formatUserDateTime(atUtc) : null;
  if (!full) return "Time not recorded";
  const parts = full.split(", ");
  return parts.length > 1 ? parts.slice(1).join(", ") : full;
}

/** EvidenceCustodyTab.tsx EventTimelineCard — grouped by day, raw list on demand. */
export function CustodyTimelineCard({ kind, events }: { kind: "forensic" | "access"; events: CustodyTimelineEvent[] }) {
  const copy = CUSTODY_TIMELINE_COPY[kind];
  const [raw, setRaw] = useState(false);
  const groups = groupCustodyByDay(events);
  const rail = kind === "forensic" ? theme.color.accent.a500 : theme.color.border.strong;
  return (
    <ProovraCard testID={`custody-timeline-${kind}`}>
      <ProovraText variant="h3" weight="semibold">{copy.title}</ProovraText>
      <ProovraText variant="label" color={theme.color.ink.muted}>{copy.description}</ProovraText>
      {events.length === 0 ? (
        <ProovraText variant="label" color={theme.color.ink.muted}>{copy.empty}</ProovraText>
      ) : (
        <View style={styles.stack}>
          {groups.map((g) => (
            <View key={g.day} style={[styles.dayGroup, { borderLeftColor: rail }]}>
              <View style={styles.railField}>
                <ProovraText variant="bodySm" weight="semibold">{dayTitle(g.day)}</ProovraText>
                <ProovraText variant="label" color={theme.color.ink.muted}>{`${g.total} ${g.total === 1 ? "event" : "events"}`}</ProovraText>
              </View>
              {g.rows.map((row) => (
                <View key={row.type} style={styles.railField}>
                  <ProovraText variant="label" style={{ flex: 1 }}>{`${row.type.replace(/_/g, " ")} × ${row.count}`}</ProovraText>
                  <ProovraText variant="label" color={theme.color.ink.muted}>{eventTime(row.lastAtUtc || null)}</ProovraText>
                </View>
              ))}
            </View>
          ))}
          <ProovraButton
            label={raw ? "Hide raw events" : "Show raw events"}
            accessibilityLabel={`${raw ? "Hide" : "Show"} raw ${kind} events`}
            variant="ghost"
            fullWidth={false}
            onPress={() => setRaw((v) => !v)}
          />
          {raw
            ? events.map((ev) => (
                <View key={`${ev.sequence}-${ev.eventType}`} style={styles.matrixRow}>
                  <View style={styles.railField}>
                    <ProovraText variant="label" weight="semibold" style={{ flex: 1 }}>{ev.eventType.replace(/_/g, " ")}</ProovraText>
                    <ProovraText variant="label" color={theme.color.ink.muted}>{(ev.atUtc && formatUserDateTime(ev.atUtc)) || "Time not recorded"}</ProovraText>
                  </View>
                  <ProovraText variant="label" color={theme.color.ink.secondary}>{ev.payloadSummary || "No event summary recorded."}</ProovraText>
                </View>
              ))
            : null}
        </View>
      )}
    </ProovraCard>
  );
}

/* --------------------------------------------------------------- artifacts */

/**
 * EvidenceArtifactsTab.tsx ArtifactLifecyclePanel — TOTAL over the canonical
 * state. The verb comes from the server's `action`; when the server withdrew
 * it (`WORKSPACE_UNRESOLVED`) the reason is said instead of a silent gap.
 */
export function ArtifactLifecyclePanel({ output, actionNode }: { output: OutputView; actionNode: React.ReactNode }) {
  const action =
    output.actionUnavailableReason === "WORKSPACE_UNRESOLVED" ? (
      <ProovraText variant="label" color={theme.color.ink.secondary} testID="artifact-action-unavailable">{WORKSPACE_UNRESOLVED_NOTE}</ProovraText>
    ) : (
      actionNode
    );
  const copy = outputPanelCopy(output);
  const showAction = outputPanelShowsAction(output.state);
  if (!copy) {
    if (output.state === "READY" && (output.action !== "NONE" || output.actionUnavailableReason !== null)) {
      return <View testID="artifact-lifecycle-ready">{action}</View>;
    }
    return null;
  }
  return (
    <Alert testID={`artifact-lifecycle-${(output.state ?? "unknown").toLowerCase()}`} tone={copy.tone} title={copy.title} body={copy.body}>
      {showAction ? action : null}
    </Alert>
  );
}

export function LatestVerificationLinkCard({ shareUrl, publicVerification }: { shareUrl: string | null; publicVerification: PublicVerificationView | null }) {
  const pv = describePublicVerificationState(publicVerification);
  return (
    <ProovraCard testID="latest-verification-link">
      <ProovraText variant="h3" weight="semibold">Latest verification link</ProovraText>
      {shareUrl ? (
        <ProovraButton label="Open verification surface" variant="secondary" fullWidth={false} onPress={() => void Linking.openURL(shareUrl)} />
      ) : (
        <>
          <ProovraText variant="bodySm" weight="semibold" color={theme.color.ink.secondary}>{publicVerification ? pv.label : "Not available"}</ProovraText>
          {publicVerification ? <ProovraText variant="label" color={theme.color.ink.muted}>{pv.detail}</ProovraText> : null}
        </>
      )}
    </ProovraCard>
  );
}

export function PublicVerificationSharing({ publicVerification, shareUrl }: { publicVerification: PublicVerificationView; shareUrl: string | null }) {
  const pv = describePublicVerificationState(publicVerification);
  const counter = (v: number) => publicVerificationCounter(publicVerification, v);
  return (
    <ProovraCard testID="public-verification-sharing">
      <ProovraText variant="h3" weight="semibold">Public verification & sharing</ProovraText>
      <ProovraText variant="label" color={theme.color.ink.muted}>External verification and export activity</ProovraText>
      <FactsGrid
        items={[
          { label: "Verification status", value: pv.label },
          { label: "Verification link", value: shareUrl ? "Available" : "Not available" },
          { label: "Publication detail", value: pv.detail },
          { label: "Public views", value: counter(publicVerification.publicViewCount) },
          { label: "Report downloads", value: counter(publicVerification.reportDownloadCount) },
          { label: "Package downloads", value: counter(publicVerification.verificationPackageDownloadCount) },
          { label: "Last public view", value: publicVerification.lastPublicViewAt ? (formatUserDateTime(publicVerification.lastPublicViewAt) ?? "Not recorded") : "Not recorded" },
        ]}
      />
    </ProovraCard>
  );
}

/* ------------------------------------------------------------------ review */

/** EvidenceReviewTab.tsx:164-234 — the review hero. Identical layout for every status. */
export function ReviewHero({
  status,
  canSeeReviewerOps,
  reportAvailable,
  reportPending,
  onAttachToCase,
  onAssignReviewer,
  onOpenReport,
}: {
  status: string | null;
  canSeeReviewerOps: boolean;
  reportAvailable: boolean;
  reportPending: boolean;
  onAttachToCase: (() => void) | null;
  onAssignReviewer: () => void;
  onOpenReport: () => void;
}) {
  const st = status ?? "NOT_STARTED";
  return (
    <ProovraCard testID="review-hero">
      <View style={styles.railField}>
        <ProovraText variant="h3" weight="semibold" style={{ flex: 1 }}>{formatReviewerStatusLabel(st)}</ProovraText>
        <ProovraBadge tone={workflowStatusTone(st)} label={st.replace(/_/g, " ")} />
      </View>
      <ProovraText variant="label" color={theme.color.ink.muted}>{REVIEWER_STATUS_DISCLAIMER}</ProovraText>
      <View style={styles.actionsRow}>
        {onAttachToCase ? <ProovraButton label="Attach to case" fullWidth={false} onPress={onAttachToCase} /> : null}
        {canSeeReviewerOps ? <ProovraButton label="Assign reviewer" variant="secondary" fullWidth={false} onPress={onAssignReviewer} /> : null}
        <ProovraButton label="Open report" variant="secondary" fullWidth={false} disabled={!reportAvailable} onPress={onOpenReport} />
      </View>
      {!reportAvailable ? (
        <ProovraText variant="label" color={theme.color.ink.muted}>
          {reportPending ? "The report is still being generated." : "No report has been generated for this record yet."}
        </ProovraText>
      ) : null}
    </ProovraCard>
  );
}

/** EvidenceReviewTab.tsx:280-341 — the private-notes head, boundary and notes. */
export function PrivateNotesHead({ record, canSeeReviewerOps }: { record: RecordView; canSeeReviewerOps: boolean }) {
  return (
    <ProovraCard testID="private-notes-section">
      <ProovraText variant="h3" weight="semibold">Private notes & annotations</ProovraText>
      <BoundaryNote title="Boundary" body="Private review notes are not included in public verification or external packages unless explicitly exported." />
      {record.governanceLabels && canSeeReviewerOps ? (
        <BoundaryNote
          title="Governance"
          body={`${record.governanceLabels.reviewerComments}, ${record.governanceLabels.legalNotes}, and ${record.governanceLabels.annotations} are internal workspace materials. They are not included in public verification, the fixed PDF report, or the verification package.`}
        />
      ) : null}
      {record.internalNotes ? <BoundaryNote title="Private session note" body={record.internalNotes} /> : null}
    </ProovraCard>
  );
}

/**
 * EvidenceReviewTab.tsx:369-560 — Lifecycle management. Facts, retention as a
 * FACT, and actions the lifecycle projection offers; a disabled trash states
 * the server's reason rather than opening a dialog that 409s.
 */
export function LifecycleManagementCard({
  lifecycle,
  facts,
  busy,
  onRestoreArchive,
  onArchive,
  onRestoreTrash,
  onTrash,
}: {
  lifecycle: LifecycleProjection | null;
  facts: Array<{ label: string; value: string }>;
  busy: boolean;
  onRestoreArchive: () => void;
  onArchive: () => void;
  onRestoreTrash: () => void;
  onTrash: () => void;
}) {
  const productState = lifecycle?.productState ?? "ACTIVE";
  const retention = retentionPosture(lifecycle);
  const trashDisabled = !lifecycle?.canTrash;
  return (
    <ProovraCard testID="lifecycle-management">
      <ProovraText variant="h3" weight="semibold">Lifecycle management</ProovraText>
      <FactsGrid items={facts} />
      {retention.retainedUntilLabel || retention.objectLockLabel || retention.legalHold ? (
        <View testID="retention-posture" style={styles.stackTight}>
          {retention.retainedUntilLabel ? <ProovraText variant="label">{retention.retainedUntilLabel}</ProovraText> : null}
          {retention.objectLockLabel ? <ProovraText variant="label">{retention.objectLockLabel}</ProovraText> : null}
          {retention.legalHold ? <ProovraText variant="label">Legal hold: active</ProovraText> : null}
          {retention.destructionNote ? <ProovraText variant="label" color={theme.color.ink.muted}>{retention.destructionNote}</ProovraText> : null}
        </View>
      ) : null}
      {productState === "DESTROYED" ? (
        <Alert testID="evidence-tombstone" tone="info" title={DESTROYED_COPY.title} body={DESTROYED_COPY.body} />
      ) : (
        <>
          <View style={styles.actionsRow}>
            {lifecycle?.canUnarchive ? <ProovraButton label="Restore to active" variant="secondary" fullWidth={false} disabled={busy} onPress={onRestoreArchive} /> : null}
            {lifecycle?.canArchive ? <ProovraButton label="Archive evidence" accessibilityLabel="Archive evidence (lifecycle)" variant="secondary" fullWidth={false} disabled={busy} onPress={onArchive} /> : null}
            {lifecycle?.canRestoreFromTrash ? (
              <ProovraButton label="Restore from trash" accessibilityLabel="Restore from trash (lifecycle)" variant="secondary" fullWidth={false} disabled={busy} onPress={onRestoreTrash} />
            ) : productState !== "TRASHED" ? (
              <ProovraButton label="Move to trash" accessibilityLabel="Move to trash (lifecycle)" variant="danger" fullWidth={false} disabled={trashDisabled || busy} onPress={onTrash} />
            ) : null}
          </View>
          {trashDisabled && productState !== "TRASHED" ? (
            <Alert
              testID="lifecycle-trash-helper"
              tone="warn"
              title={lifecycle?.trashBlockReason === "LEGAL_HOLD_ACTIVE" ? "Lifecycle changes are unavailable" : "Move to trash is unavailable"}
              body={lifecycle ? trashUnavailableMessage(lifecycle.trashBlockReason) : "Record state is loading. Try again in a moment."}
            >
              {lifecycle?.canArchive ? <ProovraText variant="label" color={theme.color.ink.secondary}>{ARCHIVE_AS_ALTERNATIVE_COPY}</ProovraText> : null}
            </Alert>
          ) : null}
        </>
      )}
    </ProovraCard>
  );
}

/* ------------------------------------------------------------ hero identity */

export function HeroIdentityLine({ record, statusLabel, statusTone }: { record: RecordView; statusLabel: string; statusTone: "verified" | "pending" | "risk" | "neutral" | "governance" | "info" }) {
  return (
    <View style={styles.identity} testID="evidence-identity">
      <ProovraBadge tone={statusTone} label={statusLabel} />
      {record.typeLabel ? <ProovraText variant="label" color={theme.color.ink.secondary}>{record.typeLabel}</ProovraText> : null}
      {record.id ? <ProovraText variant="label" mono color={theme.color.ink.secondary}>{`• Record ${record.id.slice(0, 8)}`}</ProovraText> : null}
      <ProovraText variant="label" color={theme.color.ink.secondary}>{`• ${record.multipart ? `${record.itemCount} items` : "Single item"}`}</ProovraText>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 },
  fact: {
    flexGrow: 1,
    flexBasis: "45%",
    padding: theme.space.s2,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border.subtle,
    backgroundColor: theme.color.surface.muted,
    gap: 2,
  },
  note: { padding: theme.space.s3, borderRadius: theme.radius.md, borderWidth: 1, gap: theme.space.s1 },
  alert: { padding: theme.space.s3, borderRadius: theme.radius.lg, borderWidth: 1, gap: theme.space.s2, marginBottom: theme.space.s3 },
  disclosure: { borderWidth: 1, borderColor: theme.color.border.default, borderRadius: theme.radius.lg, marginTop: theme.space.s2 },
  disclosureHead: { flexDirection: "row", alignItems: "center", padding: theme.space.s3, minHeight: 44 },
  disclosureBody: { paddingHorizontal: theme.space.s3, paddingBottom: theme.space.s3, gap: theme.space.s2 },
  stack: { gap: theme.space.s3, marginTop: theme.space.s2 },
  stackTight: { gap: theme.space.s1 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 },
  railField: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space.s2 },
  signal: { borderLeftWidth: 3, paddingLeft: theme.space.s2, paddingVertical: theme.space.s1, gap: 2 },
  placeholder: { padding: theme.space.s4, borderRadius: theme.radius.md, backgroundColor: theme.color.surface.muted, gap: theme.space.s1, marginBottom: theme.space.s2 },
  previewImage: { width: "100%", height: 240, borderRadius: theme.radius.md, backgroundColor: theme.color.surface.muted, marginBottom: theme.space.s2 },
  itemCard: { borderWidth: 1, borderRadius: theme.radius.lg, padding: theme.space.s3, gap: theme.space.s1, marginTop: theme.space.s2 },
  inlineValue: { flexShrink: 1, textAlign: "right" },
  matrixRow: { paddingVertical: theme.space.s2, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.border.subtle, gap: 2 },
  dayGroup: { borderLeftWidth: 3, paddingLeft: theme.space.s3, gap: theme.space.s1 },
  actionsRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginTop: theme.space.s2 },
  identity: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s2, marginTop: theme.space.s2 },
});
