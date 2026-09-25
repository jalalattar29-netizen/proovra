/**
 * EVIDENCE LIBRARY INSPECTOR — the web's QueueSelectionPreview
 * (apps/web/app/(app)/evidence/components/QueueSelectionPreview.tsx).
 *
 * ONE implementation, TWO hosts, as on the web: `rail` beside the queue on a
 * tablet, `modal` (a bottom sheet) on a phone. Same anatomy in both — Open
 * Evidence, the four key cards, the preview, the three artifact rows, then the
 * download / verification-link actions with their disabled reasons stated as
 * text.
 *
 * Every state is read from projected record data. The reviewer-assignment and
 * due-date lines are an Enterprise surface on the web (`canSeeReviewerOps`,
 * page.tsx:1230) and are deliberately absent here.
 */
import React, { useEffect, useState } from "react";
import { Image, Modal, ScrollView, StyleSheet, View } from "react-native";

import { theme, statusTone } from "../theme/theme";
import { formatUserDateTime } from "../lib/date";
import type { SafeError } from "../errors/safe-error";
import {
  ProovraBadge,
  ProovraButton,
  ProovraCard,
  ProovraEmptyState,
  ProovraLoadingState,
  ProovraText,
} from "./index";
import { CopyButton } from "./copy-button";
import { evidenceStatusDisplay, evidenceTypeLabel, evidenceLifecycleDisplay } from "../product/domain-display";
import {
  ARTIFACT_STATE_LABEL,
  ARTIFACT_STATE_TONE,
  buildInspectorArtifactRows,
  inspectorActionReasons,
  recordStatusLabel,
  resolveInspectorPreview,
  shortId,
  verificationStatusLabel,
  type InspectorArtifactFacts,
  type InspectorArtifactState,
  type InspectorCapabilities,
  type InspectorEvidence,
} from "../product/evidence-library";

export const INSPECTOR_TITLE = "Queue selection";
export const INSPECTOR_SUPPORT =
  "An operational preview of the selected record. The full review workspace opens from the Evidence record.";

export type InspectorLoadState = "idle" | "loading" | "ready" | "error";

/** The list-row facts the Inspector reads (mapEvidenceListItem). */
export interface InspectorRow {
  id: string;
  title: string;
  type: string;
  status: string;
  verificationStatus?: string | null;
  itemCount?: number | null;
  createdAt: string;
  reportReady?: boolean | null;
}

function datePart(iso: string | null | undefined): { date: string; time: string | null } {
  if (!iso) return { date: "Not recorded", time: null };
  const text = formatUserDateTime(iso);
  const i = text.lastIndexOf(", ");
  return i === -1 ? { date: text, time: null } : { date: text.slice(0, i), time: text.slice(i + 2) };
}

function KeyCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.keyCard}>
      <ProovraText variant="label" weight="semibold" color={theme.color.ink.muted}>
        {label}
      </ProovraText>
      {children}
    </View>
  );
}

function PreviewNotice({ title, message, warn }: { title: string; message: string; warn?: boolean }) {
  return (
    <View style={[styles.notice, warn ? styles.noticeWarn : null]}>
      <ProovraText variant="bodySm" weight="semibold">
        {title}
      </ProovraText>
      <ProovraText variant="label" color={theme.color.ink.secondary}>
        {message}
      </ProovraText>
    </View>
  );
}

function PreviewMedia({
  evidence,
  fallbackName,
  onOpenPreview,
}: {
  evidence: InspectorEvidence;
  fallbackName: string;
  onOpenPreview: (url: string) => void;
}) {
  const resolution = resolveInspectorPreview(evidence);
  const url = resolution.kind === "image" || resolution.kind === "external" ? resolution.url : null;
  const [failed, setFailed] = useState(false);
  // A newly selected record never inherits the previous record's load state.
  useEffect(() => setFailed(false), [url]);

  const name =
    (resolution.kind === "image" || resolution.kind === "external" || resolution.kind === "unsupported"
      ? resolution.item.originalFileName || resolution.item.label
      : null) || fallbackName;

  if (resolution.kind === "restricted") {
    return (
      <PreviewNotice
        warn
        title="Preview restricted"
        message="The content-access policy on this record does not grant preserved-content preview here. Metadata and integrity state remain available."
      />
    );
  }
  if (resolution.kind === "unavailable") {
    return (
      <PreviewNotice
        title="No preview available"
        message="No previewable preserved content is projected for this record in queue view."
      />
    );
  }
  if (resolution.kind === "unsupported") {
    return (
      <PreviewNotice
        title="Preview not supported"
        message={`${name} cannot be previewed in queue view. Open the evidence record for full preserved-content review.`}
      />
    );
  }
  if (failed) {
    return (
      <PreviewNotice
        warn
        title="Preview could not be loaded"
        message={`${name} did not load. Open the evidence record to review the preserved content directly.`}
      />
    );
  }
  if (resolution.kind === "image") {
    return (
      <Image
        source={{ uri: resolution.url }}
        resizeMode="contain"
        style={styles.image}
        accessibilityLabel={name}
        onError={() => setFailed(true)}
      />
    );
  }
  // Video, audio and documents play in the device viewer on a phone.
  return (
    <View style={styles.notice}>
      <ProovraText variant="bodySm" weight="semibold">
        {name}
      </ProovraText>
      <ProovraText variant="label" color={theme.color.ink.secondary}>
        This media type opens with the device viewer.
      </ProovraText>
      <ProovraButton label="Open Preview" variant="secondary" fullWidth={false} onPress={() => onOpenPreview(resolution.url)} />
    </View>
  );
}

export function EvidenceLibraryInspector({
  row,
  caseName,
  evidence,
  outputs,
  facts,
  capabilities,
  state,
  error,
  presentation,
  actionBusy,
  verifyUrl,
  onClose,
  onRetry,
  onOpenRecord,
  onOpenPreview,
  onDownloadReport,
  onDownloadPackage,
  onShareVerification,
}: {
  row: InspectorRow | null;
  caseName: string | null;
  evidence: InspectorEvidence | null;
  outputs: InspectorArtifactState | null;
  facts: InspectorArtifactFacts | null;
  capabilities: InspectorCapabilities | null;
  state: InspectorLoadState;
  error: SafeError | null;
  presentation: "modal" | "rail";
  actionBusy: string | null;
  /** The public /verify/:id link, or null when this build has no web origin. */
  verifyUrl: string | null;
  onClose: () => void;
  onRetry: () => void;
  onOpenRecord: () => void;
  onOpenPreview: (url: string) => void;
  onDownloadReport: () => void;
  onDownloadPackage: () => void;
  onShareVerification: () => void;
}) {
  let body: React.ReactNode;
  let footer: React.ReactNode = null;

  if (!row) {
    body = (
      <ProovraEmptyState
        title="No record selected"
        message="Choose a record in the evidence queue to preview its status, integrity state and export readiness here."
      />
    );
  } else if (state === "loading" || state === "idle") {
    body = <ProovraLoadingState label="Loading selected record" />;
  } else if (state === "error" || !evidence) {
    body = (
      <View style={styles.errorBlock}>
        <ProovraText variant="body" weight="semibold">
          Queue preview unavailable
        </ProovraText>
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
          {error?.message || "The selected queue record could not be previewed."}
        </ProovraText>
        <ProovraButton label="Try again" variant="secondary" fullWidth={false} onPress={onRetry} />
      </View>
    );
  } else {
    const input = {
      rowReportReady: row.reportReady === true,
      outputs,
      facts,
      capabilities,
      anchor: evidence.anchor,
      formatDate: (iso: string) => formatUserDateTime(iso),
    };
    const rows = buildInspectorArtifactRows(input);
    const reasons = inspectorActionReasons(input);
    const linkReason = reasons.link ?? (verifyUrl ? null : "This build has no public web address configured.");
    const created = datePart(row.createdAt);
    const status = evidenceStatusDisplay(row.status);
    const count = typeof row.itemCount === "number" && row.itemCount > 1 ? ` · ${row.itemCount} items` : "";

    body = (
      <>
        <ProovraButton label="Open Evidence" variant="secondary" onPress={onOpenRecord} />

        <View style={styles.keyGrid}>
          <KeyCard label="Record">
            <ProovraText variant="bodySm" weight="bold" numberOfLines={2}>
              {row.title}
            </ProovraText>
            <ProovraText variant="label" mono color={theme.color.ink.muted}>
              {shortId(row.id)}
            </ProovraText>
          </KeyCard>
          <KeyCard label="Status">
            <ProovraText variant="bodySm" weight="bold" color={statusTone(status.tone).fg}>
              {recordStatusLabel(row.status)}
            </ProovraText>
            <ProovraText variant="label">{verificationStatusLabel(evidence.verificationStatus ?? row.verificationStatus)}</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.muted}>
              {`${evidenceTypeLabel(row.type)}${count}`}
            </ProovraText>
          </KeyCard>
          <KeyCard label="Case">
            <ProovraText variant="bodySm" weight="bold">
              {caseName ?? "Not assigned"}
            </ProovraText>
          </KeyCard>
          <KeyCard label="Created">
            <ProovraText variant="bodySm" weight="bold" mono>
              {created.date}
            </ProovraText>
            {created.time ? (
              <ProovraText variant="label" mono color={theme.color.ink.muted}>
                {created.time}
              </ProovraText>
            ) : null}
          </KeyCard>
        </View>

        {evidence.lifecycleState && evidence.lifecycleState !== "ACTIVE" ? (
          // LOCKED coexists with ACTIVE, and "this cannot be changed" is not a
          // detail to leave the operator to discover by trying.
          <View style={styles.badgeRow}>
            <ProovraBadge
              tone={evidenceLifecycleDisplay(evidence.lifecycleState).tone}
              label={evidenceLifecycleDisplay(evidence.lifecycleState).label}
            />
          </View>
        ) : null}

        <ProovraText variant="label" weight="bold" color={theme.color.ink.secondary}>
          Evidence Preview
        </ProovraText>
        <PreviewMedia evidence={evidence} fallbackName={row.title} onOpenPreview={onOpenPreview} />

        <View style={styles.artifacts}>
          {rows.map((r) => {
            const tone = statusTone(ARTIFACT_STATE_TONE[r.state]);
            return (
              <View
                key={r.key}
                style={[styles.artifact, { borderColor: tone.border }]}
                accessible
                accessibilityLabel={`${r.title}: ${ARTIFACT_STATE_LABEL[r.state]}`}
                testID={`inspector-artifact-${r.key}`}
              >
                <View style={[styles.artifactDot, { backgroundColor: tone.solid }]} />
                <View style={styles.flex1}>
                  <ProovraText variant="bodySm" weight="semibold">
                    {r.title}
                  </ProovraText>
                  <ProovraText variant="label" color={theme.color.ink.secondary}>
                    {r.detail}
                  </ProovraText>
                </View>
                <ProovraBadge tone={ARTIFACT_STATE_TONE[r.state]} label={ARTIFACT_STATE_LABEL[r.state]} />
              </View>
            );
          })}
        </View>
      </>
    );

    footer = (
      <View style={styles.footer}>
        <ProovraButton
          label="Download Report"
          loading={actionBusy === "report"}
          disabled={Boolean(reasons.report)}
          onPress={onDownloadReport}
        />
        <ProovraButton
          label="Download Verification Package"
          variant="secondary"
          loading={actionBusy === "package"}
          disabled={Boolean(reasons.package)}
          onPress={onDownloadPackage}
        />
        <View style={styles.linkRow}>
          {linkReason || !verifyUrl ? (
            <ProovraButton label="Copy Verification Link" variant="secondary" fullWidth={false} disabled onPress={() => undefined} />
          ) : (
            <CopyButton value={verifyUrl} label="Copy Verification Link" variant="secondary" />
          )}
          <ProovraButton
            label="Share"
            accessibilityLabel="Share verification link"
            variant="ghost"
            fullWidth={false}
            disabled={Boolean(linkReason)}
            onPress={onShareVerification}
          />
        </View>
        {/* A disabled action states WHY as text, not only as a greyed control. */}
        {reasons.report ? (
          <ProovraText variant="label" color={theme.color.ink.muted} testID="inspector-reason-report">
            {reasons.report}
          </ProovraText>
        ) : null}
        {reasons.package ? (
          <ProovraText variant="label" color={theme.color.ink.muted} testID="inspector-reason-package">
            {reasons.package}
          </ProovraText>
        ) : null}
        {linkReason ? (
          <ProovraText variant="label" color={theme.color.ink.muted} testID="inspector-reason-link">
            {linkReason}
          </ProovraText>
        ) : null}
      </View>
    );
  }

  const content = (
    <View style={styles.inspector}>
      <View style={styles.head}>
        <View style={styles.flex1}>
          <ProovraText variant="h3" weight="bold" accessibilityRole="header">
            {INSPECTOR_TITLE}
          </ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            {INSPECTOR_SUPPORT}
          </ProovraText>
        </View>
        <ProovraButton label="Close" accessibilityLabel="Close queue selection" variant="ghost" fullWidth={false} onPress={onClose} />
      </View>
      {body}
      {footer}
    </View>
  );

  if (presentation === "rail") {
    return (
      <ProovraCard style={styles.rail}>
        <ScrollView showsVerticalScrollIndicator={false}>{content}</ScrollView>
      </ProovraCard>
    );
  }
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <ScrollView contentContainerStyle={styles.sheetScroll} showsVerticalScrollIndicator={false}>
            {content}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  inspector: { gap: theme.space.s3 },
  head: { flexDirection: "row", alignItems: "flex-start", gap: theme.space.s3 },
  keyGrid: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 },
  keyCard: {
    flexGrow: 1,
    flexBasis: "46%",
    gap: 2,
    padding: theme.space.s3,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border.default,
    backgroundColor: theme.color.surface.card,
  },
  badgeRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 },
  notice: {
    gap: theme.space.s2,
    padding: theme.space.s3,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border.default,
    backgroundColor: theme.color.surface.muted,
  },
  noticeWarn: { borderColor: theme.color.status.pending.border, backgroundColor: theme.color.status.pending.bg },
  image: { width: "100%", height: 260, borderRadius: theme.radius.md, backgroundColor: theme.color.surface.muted },
  artifacts: { gap: theme.space.s2 },
  artifact: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.s3,
    padding: theme.space.s3,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    backgroundColor: theme.color.surface.card,
  },
  artifactDot: { width: 10, height: 10, borderRadius: 5 },
  footer: { gap: theme.space.s2, paddingTop: theme.space.s2 },
  linkRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 },
  errorBlock: { gap: theme.space.s2, paddingVertical: theme.space.s3 },
  rail: { marginTop: theme.space.s4, maxHeight: 760 },
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.34)" },
  sheet: {
    maxHeight: "90%",
    backgroundColor: theme.color.surface.app,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    overflow: "hidden",
  },
  sheetScroll: { padding: theme.space.s4 },
});
