/**
 * EVIDENCE LIBRARY SAVED VIEWS — the web's SavedViewsMenu
 * (apps/web/app/(app)/evidence/components/SavedViewsMenu.tsx).
 *
 * "Saved Views" lists every view with its description, scope, sort, whose
 * view it is and whether it is the default, and offers Load / Rename / Make
 * Default / Delete. "Save Current View" names the current filters, with a
 * description, a Personal or Team scope, and "Make this my default view".
 */
import React, { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { theme } from "../theme/theme";
import { ProovraButton, ProovraFormField, ProovraInput, ProovraText } from "./index";
import { ProovraFilterChips, ProovraSheet } from "./patterns";
import { savedViewMetaLine, type SavedViewItem } from "../product/evidence-library";

export interface SavedViewDraft {
  name: string;
  description: string;
  isDefault: boolean;
  teamId: string | null;
}

export function EvidenceLibrarySavedViews({
  views,
  teamOptions,
  sourceNotSaved,
  onApply,
  onCreate,
  onUpdate,
  onDelete,
  onSetDefault,
}: {
  views: SavedViewItem[];
  teamOptions: ReadonlyArray<{ id: string; name: string }>;
  /** A Source filter is applied, which SavedViewFiltersSchema cannot carry. */
  sourceNotSaved: boolean;
  onApply: (view: SavedViewItem) => void;
  /** Each resolves true when the server accepted the change. */
  onCreate: (draft: SavedViewDraft) => Promise<boolean>;
  onUpdate: (id: string, draft: Omit<SavedViewDraft, "teamId">) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onSetDefault: (id: string) => Promise<boolean>;
}) {
  const [listOpen, setListOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [teamId, setTeamId] = useState("");
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setEditOpen(false);
    setEditId(null);
    setName("");
    setDescription("");
    setIsDefault(false);
    setTeamId("");
  };

  const editing = editId ? views.find((v) => v.id === editId) ?? null : null;

  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      const ok = editId
        ? await onUpdate(editId, { name, description, isDefault })
        : await onCreate({ name, description, isDefault, teamId: teamId || null });
      if (ok) reset();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <View style={styles.triggers}>
        <ProovraButton label="Saved Views" variant="secondary" fullWidth={false} onPress={() => setListOpen(true)} />
        <ProovraButton label="Save Current View" variant="ghost" fullWidth={false} onPress={() => setEditOpen(true)} />
      </View>

      <ProovraSheet visible={listOpen} title="Saved Views" onClose={() => setListOpen(false)}>
        {views.length === 0 ? (
          <ProovraText variant="bodySm" color={theme.color.ink.muted}>
            No saved views yet.
          </ProovraText>
        ) : (
          <View style={styles.list}>
            {views.map((view) => (
              <View key={view.id} style={styles.card} testID={`saved-view-${view.id}`}>
                <ProovraText variant="body" weight="bold">
                  {view.name}
                </ProovraText>
                <ProovraText variant="bodySm">{view.description || "Saved evidence library filter set."}</ProovraText>
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  {savedViewMetaLine(view)}
                </ProovraText>
                <View style={styles.actions}>
                  <ProovraButton
                    label="Load View"
                    accessibilityLabel={`Load View ${view.name}`}
                    variant="secondary"
                    fullWidth={false}
                    onPress={() => {
                      setListOpen(false);
                      onApply(view);
                    }}
                  />
                  <ProovraButton
                    label="Rename"
                    accessibilityLabel={`Rename ${view.name}`}
                    variant="secondary"
                    fullWidth={false}
                    onPress={() => {
                      setEditId(view.id);
                      setName(view.name);
                      setDescription(view.description ?? "");
                      setIsDefault(view.isDefault);
                      setListOpen(false);
                      setEditOpen(true);
                    }}
                  />
                  <ProovraButton
                    label={view.isDefault ? "Default View" : "Make Default"}
                    accessibilityLabel={view.isDefault ? `Default View ${view.name}` : `Make Default ${view.name}`}
                    variant="secondary"
                    fullWidth={false}
                    disabled={view.isDefault}
                    onPress={() => void onSetDefault(view.id)}
                  />
                  <ProovraButton
                    label="Delete"
                    accessibilityLabel={`Delete ${view.name}`}
                    variant="danger"
                    fullWidth={false}
                    onPress={() => void onDelete(view.id)}
                  />
                </View>
              </View>
            ))}
          </View>
        )}
      </ProovraSheet>

      <ProovraSheet visible={editOpen} title={editing ? "Update Saved View" : "Save Current View"} onClose={reset}>
        <ProovraFormField label="View name">
          <ProovraInput value={name} onChangeText={setName} autoCapitalize="sentences" />
        </ProovraFormField>
        <ProovraFormField label="Description">
          <ProovraInput value={description} onChangeText={setDescription} autoCapitalize="sentences" />
        </ProovraFormField>
        {!editing ? (
          <ProovraFilterChips
            label="View scope"
            value={teamId}
            options={[{ value: "", label: "Personal view" }, ...teamOptions.map((t) => ({ value: t.id, label: `Team view: ${t.name}` }))]}
            onChange={setTeamId}
          />
        ) : null}
        <Pressable
          onPress={() => setIsDefault((v) => !v)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: isDefault }}
          accessibilityLabel="Make this my default view"
          style={styles.check}
        >
          <View style={[styles.box, isDefault ? styles.boxOn : null]}>
            {isDefault ? (
              <ProovraText variant="label" weight="bold" color={theme.color.ink.inverse}>
                ✓
              </ProovraText>
            ) : null}
          </View>
          <ProovraText variant="bodySm">Make this my default view</ProovraText>
        </Pressable>
        <ProovraText variant="label" color={theme.color.ink.muted}>
          This view will restore search, scope, status, type, review, export, case, retention, and sort.
        </ProovraText>
        {sourceNotSaved && !editing ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>
            The Source filter is not part of the saved-view contract and will not be restored.
          </ProovraText>
        ) : null}
        <View style={styles.actions}>
          <ProovraButton label="Cancel" variant="secondary" fullWidth={false} onPress={reset} />
          <ProovraButton
            label={saving ? "Saving..." : editing ? "Update View" : "Save View"}
            fullWidth={false}
            disabled={!name.trim() || saving}
            onPress={() => void submit()}
          />
        </View>
      </ProovraSheet>
    </>
  );
}

const styles = StyleSheet.create({
  triggers: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 },
  list: { gap: theme.space.s3 },
  card: {
    gap: theme.space.s1,
    padding: theme.space.s3,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border.default,
    backgroundColor: theme.color.surface.card,
  },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginTop: theme.space.s2 },
  check: { flexDirection: "row", alignItems: "center", gap: theme.space.s2, minHeight: 44 },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: theme.color.border.strong,
    alignItems: "center",
    justifyContent: "center",
  },
  boxOn: { backgroundColor: theme.color.accent.a500, borderColor: theme.color.accent.a500 },
});
