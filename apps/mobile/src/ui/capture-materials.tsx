/**
 * CAPTURE MATERIALS + FINAL READINESS — the web's material-management board
 * (capture/page.tsx:1005-1371), `CaptureOperationalSummary`,
 * `CaptureFinalReadiness` and the `CaptureBottomBar` heading.
 *
 * Touch adaptation: the web's eight-column table is a card per material with
 * the same cells (index, preview, file, type, size, role & requirement,
 * status, actions); the role dropdown is a bottom sheet. Every verdict is read
 * from `buildSessionReadiness` / `itemQualityStatus`; nothing is decided here.
 */
import React, { useEffect, useState } from "react";
import { Image, Pressable, View } from "react-native";

import { theme } from "../theme/theme";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraFormField, ProovraInput, ProovraListRow, ProovraSheet, ProovraText } from "./index";
import {
  captureKindLabel,
  finalReadinessCopy,
  formatCaptureFileSize,
  itemQualityStatus,
  roleForStep,
  roleFromChecklistStep,
  roleRequirementLabel,
  type CapturePlanMode,
  type CollectionPlanTemplate,
  type SessionReadiness,
} from "../product/capture-plan";

export interface CaptureMaterial {
  id: string;
  uri: string;
  mimeType: string;
  originalFilename?: string;
  sizeBytes?: number;
  uploading: boolean;
  uploaded: boolean;
  error?: string | null;
  checklistStepId?: string | null;
  role?: string | null;
  privateNote?: string | null;
  /** The operator's "Source (optional)" words — EvidencePart.sourceLabel. */
  sourceNote?: string | null;
}

export type DraftSaveState = "idle" | "saving" | "saved" | "error";

/** Web deriveSessionItemTypeLabel (file-utils.ts:88). */
export function materialTypeLabel(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "Image";
  if (mimeType.startsWith("video/")) return "Video";
  if (mimeType.startsWith("audio/")) return "Audio";
  if (mimeType === "application/pdf") return "PDF";
  if (mimeType.startsWith("text/") || mimeType === "application/json" || mimeType === "application/xml") return "Document";
  return "File";
}

/** The web draft pill (capture/page.tsx:1037-1045). */
export function draftPillLabel(state: DraftSaveState, hasDraft: boolean): string {
  if (state === "saving") return "Saving draft…";
  if (state === "error") return "Draft save failed";
  return hasDraft ? "Draft saved" : "Draft staging";
}

const STATUS_TONE = { success: "verified", warning: "pending", danger: "risk" } as const;

export function CaptureMaterialsBoard({
  items,
  plan,
  planMode,
  readiness,
  busy,
  locked,
  draftSaveState,
  hasDraft,
  onClearMappings,
  onRemovePending,
  onRemove,
  onMap,
  onUpdate,
  assignRequestId,
  onAssignRequestHandled,
}: {
  /** Opens this item's assignment sheet (a requirement's "Assign a file"). */
  assignRequestId?: string | null;
  onAssignRequestHandled?: () => void;
  items: CaptureMaterial[];
  plan: CollectionPlanTemplate | null;
  planMode: CapturePlanMode;
  readiness: SessionReadiness;
  /** Finalization running — the web `busy`. */
  busy: boolean;
  /** Recording in progress: nothing may change under it. */
  locked: boolean;
  draftSaveState: DraftSaveState;
  hasDraft: boolean;
  onClearMappings: () => void;
  onRemovePending: () => void;
  onRemove: (id: string) => void;
  onMap: (id: string, patch: { checklistStepId: string | null; role: string }) => void;
  onUpdate: (id: string, patch: { privateNote?: string | null; sourceNote?: string | null }) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [mapping, setMapping] = useState<CaptureMaterial | null>(null);
  useEffect(() => {
    if (!assignRequestId) return;
    const target = items.find((i) => i.id === assignRequestId) ?? null;
    if (target) setMapping(target);
    onAssignRequestHandled?.();
  }, [assignRequestId, items, onAssignRequestHandled]);
  const totalBytes = items.reduce((sum, i) => sum + (i.sizeBytes ?? 0), 0);
  const count = items.length;
  const disabled = busy || locked;

  return (
    <ProovraCard testID="capture-materials" style={{ gap: theme.space.s3, marginBottom: theme.space.s3 }}>
      <View style={{ gap: 2 }}>
        <ProovraText variant="h3" weight="semibold">Staged evidence</ProovraText>
        <ProovraText variant="label" color={theme.color.ink.secondary}>{`${count} item${count === 1 ? "" : "s"} added`}</ProovraText>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s2 }}>
        <ProovraText variant="label" color={theme.color.ink.secondary}>{formatCaptureFileSize(totalBytes)}</ProovraText>
        <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>{`${readiness.unmappedCount} not assigned`}</ProovraText>
        <View testID="capture-draft-pill">
          <ProovraBadge label={draftPillLabel(draftSaveState, hasDraft)} tone={draftSaveState === "error" ? "risk" : draftSaveState === "saving" ? "pending" : "neutral"} />
        </View>
      </View>

      {!busy ? (
        <View style={{ flexDirection: "row", gap: theme.space.s2, flexWrap: "wrap" }} accessibilityLabel="Bulk actions" testID="capture-bulk-actions">
          <ProovraButton
            label="Clear all assignments"
            variant="ghost"
            fullWidth={false}
            disabled={items.every((i) => !i.checklistStepId) || locked}
            onPress={onClearMappings}
          />
          <ProovraButton
            label="Remove items not yet uploaded"
            variant="ghost"
            fullWidth={false}
            disabled={items.every((i) => i.uploaded || i.uploading) || locked}
            onPress={onRemovePending}
          />
        </View>
      ) : null}

      {items.map((item, index) => {
        const step = plan?.steps.find((s) => s.id === item.checklistStepId) ?? null;
        const quality = itemQualityStatus(item, step);
        const isExpanded = expanded === item.id;
        const name = item.originalFilename || `Item ${index + 1}`;
        const isImage = item.mimeType.startsWith("image/") && !!item.uri;
        const helper = step
          ? `${step.title} • ${step.purposeLabel}`
          : planMode === "CHECKLIST_REQUIRED"
            ? "Choose a required collection step before Review & Sign."
            : "Optional context can be linked to a collection step.";
        const statusLabel = item.error ? "Retry needed" : item.uploading ? "Uploading…" : quality.label;
        const statusTone = item.error ? "risk" : STATUS_TONE[quality.tone];
        return (
          <View
            key={item.id}
            testID={`capture-material-${index + 1}`}
            style={{ borderTopWidth: 1, borderTopColor: theme.color.border.subtle, paddingTop: theme.space.s2, gap: theme.space.s2 }}
          >
            <View style={{ flexDirection: "row", gap: theme.space.s2, alignItems: "center" }}>
              <ProovraText variant="label" weight="bold" color={theme.color.ink.muted}>{String(index + 1)}</ProovraText>
              <View style={{ width: 48, height: 48, borderRadius: theme.radius.sm, overflow: "hidden", backgroundColor: theme.color.surface.muted, alignItems: "center", justifyContent: "center" }}>
                {isImage ? (
                  <Image source={{ uri: item.uri }} style={{ width: 48, height: 48 }} />
                ) : (
                  <ProovraText variant="label" weight="bold" color={theme.color.ink.secondary}>
                    {materialTypeLabel(item.mimeType).toUpperCase().slice(0, 5)}
                  </ProovraText>
                )}
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <ProovraText variant="bodySm" weight="semibold" numberOfLines={1}>{name}</ProovraText>
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  {`${materialTypeLabel(item.mimeType)} · ${formatCaptureFileSize(item.sizeBytes ?? 0)}`}
                </ProovraText>
              </View>
              <ProovraBadge label={statusLabel} tone={statusTone} />
            </View>

            <Pressable
              onPress={() => setMapping(item)}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel={`Role & requirement: ${roleRequirementLabel(item.role, step)}`}
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
                borderWidth: 1,
                borderColor: theme.color.border.default,
                borderRadius: theme.radius.md,
                paddingHorizontal: theme.space.s3,
                paddingVertical: theme.space.s2,
              }}
            >
              <ProovraText variant="label" weight="semibold">{roleRequirementLabel(item.role, step)}</ProovraText>
              <ProovraText variant="label" color={theme.color.ink.muted}>⌄</ProovraText>
            </Pressable>

            <View style={{ flexDirection: "row", gap: theme.space.s2 }}>
              <ProovraButton
                label={isExpanded ? "Close" : "Notes"}
                accessibilityLabel={`${isExpanded ? "Close notes" : "Notes"} for ${name}`}
                variant="secondary"
                fullWidth={false}
                onPress={() => setExpanded((cur) => (cur === item.id ? null : item.id))}
              />
              {!busy ? (
                <ProovraButton
                  label="Remove"
                  accessibilityLabel={`Remove ${name}`}
                  variant="ghost"
                  fullWidth={false}
                  disabled={locked}
                  onPress={() => onRemove(item.id)}
                />
              ) : null}
            </View>

            {isExpanded ? (
              <View style={{ gap: theme.space.s2 }} testID={`capture-material-notes-${index + 1}`}>
                <ProovraText variant="bodySm" weight="semibold">Your notes</ProovraText>
                <ProovraText variant="label" color={theme.color.ink.secondary}>{helper}</ProovraText>
                <ProovraInput
                  value={item.privateNote ?? ""}
                  onChangeText={(v) => onUpdate(item.id, { privateNote: v.slice(0, 1000) })}
                  placeholder="Add a note about this material (private to you)."
                  accessibilityLabel="Your notes"
                  autoCapitalize="sentences"
                  editable={!disabled}
                  multiline
                />
                <ProovraFormField label="Source (optional)">
                  <ProovraInput
                    value={item.sourceNote ?? ""}
                    onChangeText={(v) => onUpdate(item.id, { sourceNote: v.slice(0, 120) })}
                    placeholder="e.g. Phone camera, on-site"
                    accessibilityLabel="Source (optional)"
                    autoCapitalize="sentences"
                    editable={!disabled}
                  />
                </ProovraFormField>
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  Shown on the evidence record as the item&apos;s source context. Not included in the public verification page or report.
                </ProovraText>
              </View>
            ) : null}
          </View>
        );
      })}

      <ProovraSheet visible={mapping !== null} title={mapping?.originalFilename ?? "Role & requirement"} onClose={() => setMapping(null)}>
        <ProovraListRow
          title="Context · Unmapped"
          subtitle="Leave unmapped or supplemental"
          onPress={() => {
            if (mapping) onMap(mapping.id, { checklistStepId: null, role: "Context / supplemental" });
            setMapping(null);
          }}
          trailing={mapping && !mapping.checklistStepId ? <ProovraBadge label="Selected" tone="verified" /> : undefined}
        />
        {(plan?.steps ?? []).map((step) => (
          <ProovraListRow
            key={step.id}
            title={`${roleFromChecklistStep(step)} · ${step.title}`}
            subtitle={`${step.required ? "Required" : "Optional"} · ${step.acceptedKinds.map(captureKindLabel).join(", ") || "Any supported material"}`}
            onPress={() => {
              if (mapping) onMap(mapping.id, { checklistStepId: step.id, role: roleForStep(step) });
              setMapping(null);
            }}
            trailing={mapping?.checklistStepId === step.id ? <ProovraBadge label="Selected" tone="verified" /> : undefined}
          />
        ))}
        {!plan ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>Choose a collection plan to map items to its requirements.</ProovraText>
        ) : null}
        <ProovraButton label="Close" variant="ghost" onPress={() => setMapping(null)} />
      </ProovraSheet>
    </ProovraCard>
  );
}

/** Web CaptureFinalReadiness — the sentence the Finish gate means, from the same values. */
export function CaptureFinalReadiness({
  readiness,
  busy,
  compact = false,
}: {
  readiness: SessionReadiness;
  busy: boolean;
  /** The footer form: the verdict and its reason in one short block. */
  compact?: boolean;
}) {
  const copy = finalReadinessCopy(readiness, busy);
  const tone = busy ? theme.color.status.neutral : copy.ready ? theme.color.status.verified : theme.color.status.pending;
  return (
    <View
      testID={`capture-final-readiness-${copy.ready ? "ready" : "not_ready"}`}
      accessibilityLiveRegion="polite"
      style={{ borderWidth: 1, borderColor: tone.border, backgroundColor: tone.bg, borderRadius: theme.radius.md, padding: compact ? theme.space.s2 : theme.space.s3, gap: compact ? 2 : 4, marginBottom: compact ? 0 : theme.space.s2 }}
    >
      <ProovraText variant="bodySm" weight="semibold" color={tone.fg}>{copy.title}</ProovraText>
      <ProovraText variant="label" color={tone.fg} numberOfLines={compact ? 2 : undefined}>{copy.detail}</ProovraText>
      {!copy.ready && copy.missing.length > 0 ? (
        <ProovraText variant="label" color={tone.fg}>{`Still unmapped: ${copy.missing.join(", ")}`}</ProovraText>
      ) : null}
    </View>
  );
}
