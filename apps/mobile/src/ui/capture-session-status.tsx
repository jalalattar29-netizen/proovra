/**
 * CAPTURE SESSION STATUS (T-14 CaptureSessionPanel) — the web rail's session
 * status, command-center metrics, session metadata and integrity preparation.
 * Every value is read from `buildSessionReadiness` or from state the capture
 * screen holds; this computes nothing.
 */
import React from "react";
import { View } from "react-native";

import {
  SESSION_STATUS_COPY,
  formatCaptureFileSize,
  type CapturePlanMode,
  type CollectionPlanTemplate,
  type SessionReadiness,
  type SessionReadinessIssue,
} from "../product/capture-plan";
import { theme } from "../theme/theme";
import { ProovraBadge, ProovraCard, ProovraText } from "./index";
import { ProovraKpiGrid } from "./patterns";

/** The web rail's cap; beyond it the count carries the remainder. */
const VISIBLE_LIMIT = 4;

function IssueGroup({ title, issues, color }: { title: "Blockers" | "Warnings"; issues: ReadonlyArray<SessionReadinessIssue>; color: string }) {
  const visible = issues.slice(0, VISIBLE_LIMIT);
  const overflow = issues.length - visible.length;
  return (
    <View style={{ gap: 4 }} testID={`capture-signals-${title.toLowerCase()}`}>
      <ProovraText variant="label" weight="semibold" color={color}>{`${title} ${issues.length}`}</ProovraText>
      {visible.map((issue, i) => (
        <View key={`${issue.code}-${issue.itemId ?? i}`}>
          <ProovraText variant="bodySm" weight="semibold">{issue.label}</ProovraText>
          {issue.detail ? <ProovraText variant="label" color={theme.color.ink.secondary}>{issue.detail}</ProovraText> : null}
        </View>
      ))}
      {overflow > 0 ? <ProovraText variant="label" color={theme.color.ink.muted}>{`+${overflow} more ${title.toLowerCase()}`}</ProovraText> : null}
    </View>
  );
}

/** The web CaptureReadinessSignals: both groups, or one all-clear row said in words. */
export function CaptureReadinessSignals({ readiness }: { readiness: SessionReadiness }) {
  if (readiness.blockers.length === 0 && readiness.warnings.length === 0) {
    return (
      <View style={{ flexDirection: "row", gap: theme.space.s3 }} testID="capture-signals-clear">
        <ProovraText variant="label" color={theme.color.status.verified.fg}>✓ No blockers</ProovraText>
        <ProovraText variant="label" color={theme.color.status.verified.fg}>✓ No warnings</ProovraText>
      </View>
    );
  }
  return (
    <View style={{ gap: theme.space.s2 }}>
      {readiness.blockers.length > 0 ? <IssueGroup title="Blockers" issues={readiness.blockers} color={theme.color.status.risk.fg} /> : null}
      {readiness.warnings.length > 0 ? <IssueGroup title="Warnings" issues={readiness.warnings} color={theme.color.status.pending.fg} /> : null}
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.space.s2 }}>
      <ProovraText variant="label" color={theme.color.ink.secondary}>{label}</ProovraText>
      <ProovraText variant="label" weight="semibold">{value}</ProovraText>
    </View>
  );
}

export function CaptureSessionStatus({
  readiness,
  busy,
  itemCount,
  sessionId,
  plan,
  totalBytes,
  useLocation,
  planMode = "FLEXIBLE",
  locationPermissionDenied = false,
}: {
  readiness: SessionReadiness;
  busy: boolean;
  itemCount: number;
  sessionId: string;
  plan: CollectionPlanTemplate | null;
  totalBytes: number;
  useLocation: boolean;
  planMode?: CapturePlanMode;
  /** The device refused location for this session (web locationPermissionDenied). */
  locationPermissionDenied?: boolean;
}) {
  const copy = SESSION_STATUS_COPY[readiness.status];
  // Web CaptureSessionPanel statusChecks — four facts, each already decided.
  const checks = [
    {
      label: `${readiness.requiredCompleted}/${readiness.requiredTotal} required mapped`,
      done: readiness.requiredTotal > 0 && readiness.requiredCompleted === readiness.requiredTotal,
    },
    { label: `${itemCount} material${itemCount === 1 ? "" : "s"} added`, done: itemCount > 0 },
    { label: readiness.blockers.length === 0 ? "No blockers" : "Blockers to clear", done: readiness.blockers.length === 0 },
    { label: readiness.canFinalize ? "Ready for Review & Sign" : "Review & Sign not available", done: readiness.canFinalize },
  ];
  return (
    <ProovraCard testID="capture-session-status">
      <View style={{ gap: theme.space.s2 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: theme.space.s2 }}>
          <View style={{ flex: 1 }}>
            <ProovraText variant="label" color={theme.color.ink.muted}>Session status</ProovraText>
            <ProovraText variant="h3" weight="semibold">{busy ? "Finalizing" : copy.label}</ProovraText>
          </View>
          <ProovraBadge label={busy ? "In progress" : "Draft"} tone={busy ? "pending" : "neutral"} />
        </View>
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
          {busy ? "Uploads and verification preparation are running. Keep this screen open." : copy.detail}
        </ProovraText>
        <ProovraText variant="label" color={theme.color.ink.secondary}>{`${readiness.requiredProgressPercent}% of required items mapped`}</ProovraText>
        <View style={{ gap: 2 }} testID="capture-status-checks">
          {checks.map((c) => (
            <ProovraText key={c.label} variant="label" color={c.done ? theme.color.status.verified.fg : theme.color.ink.secondary}>
              {`${c.done ? "✓" : "○"} ${c.label}`}
            </ProovraText>
          ))}
        </View>

        <ProovraText variant="label" weight="bold" color={theme.color.ink.muted} style={{ textTransform: "uppercase", letterSpacing: 0.4 }}>Operations command center</ProovraText>
        <ProovraText variant="bodySm" weight="semibold">{`${itemCount} item${itemCount === 1 ? "" : "s"} added`}</ProovraText>

        <ProovraKpiGrid
          items={[
            { key: "required", label: "Required", value: `${readiness.requiredCompleted}/${readiness.requiredTotal}` },
            { key: "mapped", label: "Mapped", value: String(readiness.mappedCount) },
            { key: "blockers", label: "Blockers", value: String(readiness.blockers.length), tone: readiness.blockers.length > 0 ? "risk" : undefined },
            { key: "warnings", label: "Warnings", value: String(readiness.warnings.length), tone: readiness.warnings.length > 0 ? "pending" : undefined },
          ]}
        />
        <CaptureReadinessSignals readiness={readiness} />

        <ProovraText variant="label" weight="semibold">Session metadata</ProovraText>
        <Row label="Session ID" value={sessionId} />
        <Row label="Template" value={plan?.name ?? "General"} />
        <Row label="Mode" value={planMode === "CHECKLIST_REQUIRED" ? "Checklist required" : "Flexible"} />
        <Row label="Total size" value={formatCaptureFileSize(totalBytes)} />

        <ProovraText variant="label" weight="semibold">Integrity preparation</ProovraText>
        <Row label="Fingerprint" value={itemCount > 0 ? "Queued" : "Waiting"} />
        <Row label="Custody" value={itemCount > 0 ? "Ready after sign" : "Not started"} />
        <Row label="Package" value="After finalization" />
        <Row label="Location" value={useLocation ? "Included" : "Not included"} />
        {locationPermissionDenied ? (
          <ProovraText variant="label" color={theme.color.status.pending.fg} testID="capture-location-denied">
            Location was not granted. The current session will continue without GPS metadata unless the selected plan requires it.
          </ProovraText>
        ) : null}
      </View>
    </ProovraCard>
  );
}
