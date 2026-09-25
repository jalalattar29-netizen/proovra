/**
 * UNFINISHED CAPTURE DRAFTS — the web resume banner + Drafts modal
 * (capture/page.tsx:630-736) and `CaptureDraftReattachNotice`.
 *
 * A draft on `/v1/capture/sessions` holds the session's METADATA — plan, mode,
 * location choice, and each staged item's name, type and mapping — never the
 * file bytes. So Resume restores the metadata and this surface says, in the
 * web's words, which files still have to be added again. A listed file is not
 * a staged material and is counted as one nowhere.
 */
import React from "react";
import { View } from "react-native";

import { theme } from "../theme/theme";
import { ProovraButton, ProovraCard, ProovraSheet, ProovraText } from "./index";
import { formatUserDateTime } from "../lib/date";
import type { CaptureDraftDetail } from "../capture/capture-draft";
import type { CollectionPlanTemplate } from "../product/capture-plan";

export function CaptureDraftsBanner({
  drafts,
  open,
  onOpen,
  onClose,
  onResume,
  onDelete,
  busyId,
}: {
  drafts: CaptureDraftDetail[];
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onResume: (draft: CaptureDraftDetail) => void;
  onDelete: (draft: CaptureDraftDetail) => void;
  busyId: string | null;
}) {
  if (drafts.length === 0) return null;
  const n = drafts.length;
  return (
    <ProovraCard testID="capture-drafts-banner" style={{ gap: theme.space.s2, marginBottom: theme.space.s3, borderColor: theme.color.accent.a500 }}>
      <ProovraText variant="bodySm" weight="semibold">
        {`You have ${n} unfinished capture session${n === 1 ? "" : "s"}.`}
      </ProovraText>
      <ProovraText variant="label" color={theme.color.ink.secondary}>
        Resume restores template, mappings, notes, and item metadata. For privacy and device-security reasons, the original file binaries cannot be restored automatically — you must re-attach the actual files before finalization.
      </ProovraText>
      <ProovraButton label={`Drafts (${n})`} variant="secondary" fullWidth={false} onPress={onOpen} />

      <ProovraSheet visible={open} title="Unfinished capture drafts" onClose={onClose}>
        <ProovraText variant="label" color={theme.color.ink.secondary}>
          Resume draft metadata, then re-attach files before Review & Sign.
        </ProovraText>
        {drafts.map((d) => {
          const count = d.items.length;
          const meta = [
            `${count} staged item${count === 1 ? "" : "s"}`,
            d.planMode ?? null,
            d.expiresAtUtc ? `Expires ${formatUserDateTime(d.expiresAtUtc)}` : null,
          ]
            .filter(Boolean)
            .join(" • ");
          return (
            <View
              key={d.id}
              testID={`capture-draft-${d.id}`}
              style={{ gap: theme.space.s2, borderTopWidth: 1, borderTopColor: theme.color.border.subtle, paddingTop: theme.space.s2 }}
            >
              <ProovraText variant="bodySm" weight="semibold">{d.templateName ?? "Untitled draft"}</ProovraText>
              <ProovraText variant="label" color={theme.color.ink.secondary}>{meta}</ProovraText>
              <View style={{ flexDirection: "row", gap: theme.space.s2 }}>
                <ProovraButton
                  label="Resume"
                  accessibilityLabel={`Resume ${d.templateName ?? "Untitled draft"}`}
                  fullWidth={false}
                  loading={busyId === d.id}
                  disabled={busyId !== null}
                  onPress={() => onResume(d)}
                />
                <ProovraButton
                  label="Delete"
                  accessibilityLabel={`Delete ${d.templateName ?? "Untitled draft"}`}
                  variant="danger"
                  fullWidth={false}
                  disabled={busyId !== null}
                  onPress={() => onDelete(d)}
                />
              </View>
            </View>
          );
        })}
        <ProovraButton label="Close" variant="ghost" onPress={onClose} />
      </ProovraSheet>
    </ProovraCard>
  );
}

/** Web CaptureDraftReattachNotice: what the resumed draft kept, and what to add again. */
export function CaptureDraftReattachNotice({
  detail,
  plan,
  onDismiss,
}: {
  detail: CaptureDraftDetail;
  plan: CollectionPlanTemplate | null;
  onDismiss: () => void;
}) {
  const items = detail.items;
  if (items.length === 0) return null;
  const stepTitle = (id: string | null) => (id ? plan?.steps.find((s) => s.id === id)?.title ?? null : null);
  return (
    <ProovraCard testID="capture-reattach" style={{ gap: theme.space.s2, marginBottom: theme.space.s3 }}>
      <ProovraText variant="bodySm" weight="semibold">
        {`${items.length} material${items.length === 1 ? "" : "s"} to re-attach`}
      </ProovraText>
      <ProovraText variant="label" color={theme.color.ink.secondary}>
        This draft kept each file&apos;s name, type and requirement mapping. File contents are never stored before Review &amp; Sign, so the files themselves have to be added again — mappings below are for reference.
      </ProovraText>
      {items.map((item, i) => (
        <View key={item.clientItemId ?? `${item.fileName}-${i}`} style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.space.s2 }}>
          <ProovraText variant="label" weight="semibold" numberOfLines={1} style={{ flex: 1 }}>
            {item.fileName ?? "Untitled material"}
          </ProovraText>
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {stepTitle(item.checklistStepId) ?? "Not mapped to a requirement"}
          </ProovraText>
        </View>
      ))}
      <ProovraButton label="Dismiss" variant="ghost" fullWidth={false} onPress={onDismiss} />
    </ProovraCard>
  );
}
