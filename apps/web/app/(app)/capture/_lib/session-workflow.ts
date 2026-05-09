import type { CollectionPlanTemplate, SessionItem, SessionTimelineEvent } from "./types";
import type { CapturePlanMode, SessionReadiness } from "./session-readiness";

export type PersistentSidebarMessageTone = "info" | "warning" | "danger" | "success";

export type PersistentSidebarMessage = {
  id: string;
  title: string;
  detail: string;
  tone: PersistentSidebarMessageTone;
  meta?: string;
};

export type CaptureAiSummary = {
  totalItems: number;
  totalSizeBytes: number;
  requiredStepsCompleted: number;
  requiredStepsTotal: number;
  planMode: CapturePlanMode;
  useLocation: boolean;
  locationRequirement: CollectionPlanTemplate["locationRequirement"];
};

export type SessionWorkflowSnapshot = {
  sessionCountLabel: string;
  checklistStepItemMap: Map<string, SessionItem[]>;
  finishReason: string | undefined;
  missingStepTitles: string[];
  finishDisabled: boolean;
  totalStagedBytes: number;
  activeWorkflowStep: number;
  completedRequiredCount: number;
  requiredProgressPercent: number;
  captureAiSummary: CaptureAiSummary;
  persistentSidebarMessages: PersistentSidebarMessage[];
  currentSessionId: string;
};

type BuildPersistentSidebarMessagesParams = {
  busy: boolean;
  error: string | null;
  locationPermissionDenied: boolean;
  progress: number;
  sessionItemCount: number;
  sessionReadiness: SessionReadiness;
  sessionStatus: string | null;
  sessionTimeline: SessionTimelineEvent[];
};

type BuildSessionWorkflowSnapshotParams = {
  busy: boolean;
  error: string | null;
  locationPermissionDenied: boolean;
  planMode: CapturePlanMode;
  progress: number;
  selectedPlan: CollectionPlanTemplate | undefined;
  sessionItems: SessionItem[];
  sessionReadiness: SessionReadiness;
  sessionStartedAt: Date;
  sessionStatus: string | null;
  sessionTimeline: SessionTimelineEvent[];
  useLocation: boolean;
};

export function buildChecklistStepItemMap(items: SessionItem[]): Map<string, SessionItem[]> {
  const map = new Map<string, SessionItem[]>();

  items.forEach((item) => {
    if (!item.checklistStepId) return;

    const existing = map.get(item.checklistStepId) ?? [];
    map.set(item.checklistStepId, [...existing, item]);
  });

  return map;
}

export function formatCaptureSessionId(sessionStartedAt: Date): string {
  const y = sessionStartedAt.getFullYear();
  const m = String(sessionStartedAt.getMonth() + 1).padStart(2, "0");
  const d = String(sessionStartedAt.getDate()).padStart(2, "0");

  return `CAP-${y}-${m}-${d}`;
}

export function buildPersistentSidebarMessages({
  busy,
  error,
  locationPermissionDenied,
  progress,
  sessionItemCount,
  sessionReadiness,
  sessionStatus,
  sessionTimeline,
}: BuildPersistentSidebarMessagesParams): PersistentSidebarMessage[] {
  const statusTone: PersistentSidebarMessageTone = busy
    ? "info"
    : sessionReadiness.summary.blockerCount > 0 || sessionReadiness.status === "empty"
      ? "danger"
      : sessionReadiness.summary.warningCount > 0
        ? "warning"
        : "success";

  const statusTitle = busy
    ? sessionStatus ?? "Finalization running"
    : sessionReadiness.canFinalize
      ? "Ready for Review & Sign"
      : sessionReadiness.status === "empty"
        ? "Add source material"
        : "Resolve session blockers";

  const statusDetail = busy
    ? "Uploads, checksums, custody preparation, and verification artifacts are being prepared. Keep this tab open."
    : sessionReadiness.canFinalize
      ? "The persistent session state is ready for the bottom Review & Sign action."
      : sessionReadiness.blockers[0]?.detail ??
        "Persistent guidance will remain here until the required intake conditions are satisfied.";

  const systemMessages: PersistentSidebarMessage[] = [
    {
      id: `workflow-status-${sessionReadiness.status}-${sessionReadiness.summary.blockerCount}-${sessionReadiness.summary.warningCount}-${progress}`,
      title: statusTitle,
      detail: statusDetail,
      tone: statusTone,
      meta: busy ? `${progress}%` : `${sessionItemCount} staged`,
    },
  ];

  if (error) {
    systemMessages.push({
      id: `workflow-error-${error}`,
      title: "Action needs attention",
      detail: error,
      tone: "danger",
      meta: "Persistent alert",
    });
  }

  if (locationPermissionDenied) {
    systemMessages.push({
      id: "workflow-location-denied",
      title: "Location unavailable",
      detail:
        "Browser location was denied or unavailable. Continue only if the selected plan does not require GPS metadata.",
      tone: "warning",
      meta: "Metadata",
    });
  }

  const timelineMessages: PersistentSidebarMessage[] = sessionTimeline.map((event) => ({
    id: event.id,
    title: event.title,
    detail: event.detail,
    tone: event.tone,
    meta: new Intl.DateTimeFormat("en", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(event.atUtc)),
  }));

  return [...systemMessages, ...timelineMessages].slice(0, 7);
}

export function buildSessionWorkflowSnapshot({
  busy,
  error,
  locationPermissionDenied,
  planMode,
  progress,
  selectedPlan,
  sessionItems,
  sessionReadiness,
  sessionStartedAt,
  sessionStatus,
  sessionTimeline,
  useLocation,
}: BuildSessionWorkflowSnapshotParams): SessionWorkflowSnapshot {
  const sessionCountLabel = `${sessionItems.length} item${sessionItems.length === 1 ? "" : "s"} added`;
  const checklistStepItemMap = buildChecklistStepItemMap(sessionItems);
  const finishReason = sessionReadiness.blockers[0]?.label;
  const missingStepTitles = sessionReadiness.missingRequiredSteps.map((step) => step.title);
  const finishDisabled = busy || !sessionReadiness.canFinalize;
  const totalStagedBytes = sessionItems.reduce((sum, item) => sum + item.file.size, 0);
  const activeWorkflowStep = busy ? 4 : sessionItems.length > 0 ? 3 : 1;
  const completedRequiredCount = sessionReadiness.summary.requiredCompleted;
  const requiredProgressPercent =
    sessionReadiness.summary.requiredTotal > 0
      ? Math.round((completedRequiredCount / sessionReadiness.summary.requiredTotal) * 100)
      : 100;

  return {
    sessionCountLabel,
    checklistStepItemMap,
    finishReason,
    missingStepTitles,
    finishDisabled,
    totalStagedBytes,
    activeWorkflowStep,
    completedRequiredCount,
    requiredProgressPercent,
    captureAiSummary: {
      totalItems: sessionItems.length,
      totalSizeBytes: totalStagedBytes,
      requiredStepsCompleted: completedRequiredCount,
      requiredStepsTotal: sessionReadiness.summary.requiredTotal,
      planMode,
      useLocation,
      locationRequirement: selectedPlan?.locationRequirement ?? "optional",
    },
    persistentSidebarMessages: buildPersistentSidebarMessages({
      busy,
      error,
      locationPermissionDenied,
      progress,
      sessionItemCount: sessionItems.length,
      sessionReadiness,
      sessionStatus,
      sessionTimeline,
    }),
    currentSessionId: formatCaptureSessionId(sessionStartedAt),
  };
}
