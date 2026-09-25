/**
 * CAPTURE PLAN — the intake rail, readiness panel and suggestions panel.
 *
 * Ports `CaptureIntakeRail`, `CaptureReadinessPanel` and
 * `CaptureSuggestionsPanel` from `apps/web/app/(app)/capture/_lib/`. The
 * template selector lives with the requirements (src/ui/capture-requirements.tsx),
 * where the web's `CaptureRequirements` puts it.
 *
 * NONE OF THIS BLOCKS ANYTHING
 * The web states it twice — "the rail NEVER blocks" and "Suggestions are NEVER
 * blocking. The operator can finalize regardless" — and it carries over.
 *
 * NOR DOES ANY OF IT CLAIM ANYTHING ABOUT THE EVIDENCE
 * Readiness is operational completeness, not admissibility or authenticity,
 * and the footnote says so on screen rather than only in a comment.
 */
import { useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { apiFetch } from "../api";
import { theme } from "../theme/theme";
import { ProovraCard, ProovraText } from "./index";
import {
  INTAKE_TEMPLATES_PATH,
  READINESS_PANEL_LEVEL_LABEL,
  computeCaptureSuggestions,
  computeIntakeStages,
  orderCaptureTemplates,
  parseIntakeTemplates,
  type CaptureReadiness,
  type CollectionPlanTemplate,
  type PlannedItem,
} from "../product/capture-plan";

/** Loads the SERVER catalogue, the default plan first. There is no on-device seed list. */
export function useIntakeTemplates() {
  const [templates, setTemplates] = useState<CollectionPlanTemplate[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch(INTAKE_TEMPLATES_PATH)
      .then((d) => {
        if (!cancelled) setTemplates(orderCaptureTemplates(parseIntakeTemplates(d)));
      })
      .catch(() => {
        // A template is guidance, not a gate. When the catalogue cannot be
        // read, capture proceeds without one and the surface says so.
        if (!cancelled) setTemplates(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return templates;
}

/** The web's localStorage dismissals (`capture-readiness-dismissed:` / `capture-suggestions-dismissed:`). */
function useDismissed(key: string): [boolean, () => void] {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(key)
      .then((v) => {
        if (alive && v === "true") setDismissed(true);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [key]);
  const dismiss = useCallback(() => {
    setDismissed(true);
    AsyncStorage.setItem(key, "true").catch(() => undefined);
  }, [key]);
  return [dismissed, dismiss];
}

/** The web renders these section labels uppercase through CSS; the words stay as written. */
const UPPER = { textTransform: "uppercase" as const, letterSpacing: 0.4 };

const LEVEL_TONE = {
  draft: theme.color.status.neutral,
  developing: theme.color.status.pending,
  ready: theme.color.status.verified,
} as const;

function HideButton({ label, onPress, color }: { label: string; onPress: () => void; color: string }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      style={{ borderWidth: 1, borderColor: theme.color.border.default, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 2 }}
    >
      <ProovraText variant="label" color={color}>Hide</ProovraText>
    </Pressable>
  );
}

/** Web CaptureIntakeRail — "Intake plan" and the five numbered stages. Always shown. */
export function CaptureIntakeRail({
  items,
  templateSelected,
  readiness,
}: {
  items: PlannedItem[];
  templateSelected: boolean;
  readiness: CaptureReadiness;
}) {
  const stages = computeIntakeStages({ items, templateSelected, readiness });
  return (
    <ProovraCard testID="capture-intake-rail" accessibilityLabel="Capture intake progression">
      <ProovraText variant="label" weight="bold" color={theme.color.ink.muted} style={UPPER}>Intake plan</ProovraText>
      <View style={{ gap: theme.space.s2, marginTop: theme.space.s2 }}>
        {stages.map((s, idx) => {
          const tone =
            s.status === "complete" ? theme.color.status.verified : s.status === "active" ? theme.color.status.governance : theme.color.status.neutral;
          return (
            <View
              key={s.id}
              style={{ flexDirection: "row", alignItems: "center", gap: theme.space.s2 }}
              accessibilityState={s.status === "active" ? { selected: true } : undefined}
              testID={`capture-intake-stage-${s.id}-${s.status}`}
            >
              <View
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 12,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: s.status === "pending" ? theme.color.surface.card : tone.solid,
                  borderWidth: 1,
                  borderColor: s.status === "pending" ? theme.color.border.default : tone.solid,
                }}
              >
                <ProovraText variant="label" weight="bold" color={s.status === "pending" ? theme.color.ink.muted : "#FFFFFF"}>
                  {s.status === "complete" ? "✓" : String(idx + 1)}
                </ProovraText>
              </View>
              <ProovraText
                variant="bodySm"
                weight={s.status === "active" ? "semibold" : "regular"}
                color={s.status === "pending" ? theme.color.ink.muted : theme.color.ink.primary}
              >
                {s.label}
              </ProovraText>
            </View>
          );
        })}
      </View>
    </ProovraCard>
  );
}

/** Web CaptureReadinessPanel — hidden with no items, and once dismissed. */
export function CaptureReadinessPanel({ readiness, itemCount }: { readiness: CaptureReadiness; itemCount: number }) {
  const [dismissed, dismiss] = useDismissed("capture-readiness-dismissed:");
  if (itemCount === 0 || dismissed) return null;
  const tone = LEVEL_TONE[readiness.level];
  const levelLabel = READINESS_PANEL_LEVEL_LABEL[readiness.level];
  return (
    <ProovraCard
      testID="capture-readiness-panel"
      accessibilityLabel={`Capture readiness: ${levelLabel}`}
      style={{ backgroundColor: tone.bg, borderColor: tone.border, gap: theme.space.s2 }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: theme.space.s2 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <ProovraText variant="label" weight="bold" color={tone.fg} style={UPPER}>{`Capture readiness · ${levelLabel}`}</ProovraText>
          <ProovraText variant="label" color={tone.fg}>
            {`${readiness.score.satisfied} of ${readiness.score.total} workflow criteria satisfied`}
          </ProovraText>
        </View>
        <HideButton label="Dismiss capture readiness panel" onPress={dismiss} color={tone.fg} />
      </View>
      {readiness.criteria.map((c) => (
        <View key={c.id} style={{ flexDirection: "row", gap: 6 }}>
          <ProovraText variant="label" weight="bold" color={c.satisfied ? theme.color.status.verified.fg : theme.color.ink.muted}>
            {c.satisfied ? "✓" : "•"}
          </ProovraText>
          <View style={{ flex: 1 }}>
            <ProovraText variant="label" weight="semibold" color={tone.fg}>{c.label}</ProovraText>
            <ProovraText variant="label" color={tone.fg}>{c.description}</ProovraText>
          </View>
        </View>
      ))}
      <ProovraText variant="label" color={tone.fg}>
        Operational readiness only. The capture pipeline (hashing, custody, finalization) is governed by the upload flow itself — this panel never blocks finalization.
      </ProovraText>
    </ProovraCard>
  );
}

/** Web CaptureSuggestionsPanel — "Suggested next steps · N", dismissible. */
export function CaptureSuggestionsPanel({ readiness }: { readiness: CaptureReadiness }) {
  const [dismissed, dismiss] = useDismissed("capture-suggestions-dismissed:");
  const suggestions = computeCaptureSuggestions(readiness);
  if (dismissed || suggestions.length === 0) return null;
  return (
    <ProovraCard testID="capture-suggestions" accessibilityLabel="Capture suggestions" style={{ gap: theme.space.s2 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: theme.space.s2 }}>
        <ProovraText variant="label" weight="bold" color={theme.color.ink.secondary} style={UPPER}>
          {`Suggested next steps · ${suggestions.length}`}
        </ProovraText>
        <HideButton label="Dismiss capture suggestions panel" onPress={dismiss} color={theme.color.ink.secondary} />
      </View>
      {suggestions.map((s) => {
        const tone = s.tone === "warning" ? theme.color.status.pending : theme.color.status.neutral;
        return (
          <View
            key={s.id}
            style={{ borderWidth: 1, borderColor: tone.border, backgroundColor: tone.bg, borderRadius: 6, padding: theme.space.s2, gap: 2 }}
          >
            <ProovraText variant="label" weight="bold" color={tone.fg}>{s.title}</ProovraText>
            <ProovraText variant="label" color={tone.fg}>{s.body}</ProovraText>
          </View>
        );
      })}
    </ProovraCard>
  );
}
