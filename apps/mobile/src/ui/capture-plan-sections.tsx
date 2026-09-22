/**
 * CAPTURE PLAN — the template, the stage rail, readiness and suggestions.
 *
 * Ports `CaptureIntakeRail`, `CaptureReadinessPanel`, `CaptureSuggestionsPanel`
 * and the template selector from `apps/web/app/(app)/capture/_lib/`.
 *
 * NONE OF THIS BLOCKS ANYTHING
 * The web states it twice — "the rail NEVER blocks" and "Suggestions are NEVER
 * blocking. The operator can finalize regardless" — and it carries over. The
 * operator finishes through the capture controls, and nothing here can stop
 * them or claim they should not.
 *
 * NOR DOES ANY OF IT CLAIM ANYTHING ABOUT THE EVIDENCE
 * Readiness is operational completeness. "Ready to finish" means the intake
 * has what an intake usually needs; it is not an assertion about
 * admissibility or authenticity, and the boundary sentence says so on screen
 * rather than only in a comment.
 */
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { theme } from "../theme/theme";
import {
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraListRow,
  ProovraSheet,
} from "./index";
import {
  INTAKE_TEMPLATES_PATH,
  READINESS_BOUNDARY,
  STAGE_RAIL_BOUNDARY,
  computeCaptureReadiness,
  computeCaptureSuggestions,
  computeIntakeStages,
  parseIntakeTemplates,
  readinessLabel,
  type CollectionPlanTemplate,
  type PlannedItem,
} from "../product/capture-plan";

/** Loads the SERVER catalogue. There is no on-device seed list. */
export function useIntakeTemplates() {
  const [templates, setTemplates] = useState<CollectionPlanTemplate[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch(INTAKE_TEMPLATES_PATH)
      .then((d) => {
        if (!cancelled) setTemplates(parseIntakeTemplates(d));
      })
      .catch(() => {
        // A template is guidance, not a gate. When the catalogue cannot be
        // read, capture proceeds without one and the surface says so — which
        // is honest, where showing a stale copy as current would not be.
        if (!cancelled) setTemplates(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return templates;
}

export function CapturePlanSections({
  items,
  templates,
  template,
  onSelectTemplate,
}: {
  items: PlannedItem[];
  templates: CollectionPlanTemplate[] | null;
  template: CollectionPlanTemplate | null;
  onSelectTemplate: (t: CollectionPlanTemplate | null) => void;
}) {
  const [picker, setPicker] = useState(false);

  const readiness = computeCaptureReadiness(items);
  const suggestions = computeCaptureSuggestions(readiness);
  const stages = computeIntakeStages({
    items,
    templateSelected: template !== null,
    readiness,
  });

  const pick = useCallback(
    (t: CollectionPlanTemplate | null) => {
      onSelectTemplate(t);
      setPicker(false);
    },
    [onSelectTemplate],
  );

  return (
    <>
      {/* ------------------------------------------------------- the template */}
      <ProovraCard>
        <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
          Collection plan
        </ProovraText>
        {templates === null ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>
            Collection plans could not be loaded. You can capture without one.
          </ProovraText>
        ) : (
          <>
            <ProovraListRow
              title={template ? template.name : "No plan selected"}
              subtitle={template ? template.description : "Optional — a plan lists what to collect."}
              onPress={() => setPicker(true)}
            />
            {template && template.steps.length > 0 ? (
              <View style={{ gap: 2 }}>
                {template.steps.map((s) => (
                  <ProovraText key={s.id} variant="label" color={theme.color.ink.muted}>
                    {`${s.required ? "Required" : "Optional"} · ${s.title}`}
                  </ProovraText>
                ))}
              </View>
            ) : null}
          </>
        )}
      </ProovraCard>

      {/* ------------------------------------------------------ the stage rail */}
      <ProovraCard>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
          {stages.map((s) => (
            <ProovraBadge
              key={s.id}
              label={s.label}
              tone={s.status === "complete" ? "verified" : s.status === "active" ? "pending" : "neutral"}
            />
          ))}
        </View>
        {/* The rail never blocks. Saying so is part of the rail. */}
        <ProovraText variant="label" color={theme.color.ink.muted}>
          {STAGE_RAIL_BOUNDARY}
        </ProovraText>
      </ProovraCard>

      {/* -------------------------------------------------------- readiness */}
      <ProovraCard>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: theme.space.s2,
          }}
        >
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
            {readinessLabel(readiness.level)}
          </ProovraText>
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {`${readiness.score.satisfied} of ${readiness.score.total}`}
          </ProovraText>
        </View>

        {readiness.criteria.map((c) => (
          <ProovraText
            key={c.id}
            variant="label"
            color={c.satisfied ? theme.color.ink.secondary : theme.color.ink.muted}
          >
            {`${c.satisfied ? "✓" : "·"} ${c.label}`}
          </ProovraText>
        ))}

        {/*
          On screen, not only in a comment: "ready" is about how complete this
          intake is, never about admissibility or authenticity.
        */}
        <ProovraText variant="label" color={theme.color.ink.muted}>
          {READINESS_BOUNDARY}
        </ProovraText>
      </ProovraCard>

      {/* ------------------------------------------------------ suggestions */}
      {suggestions.length > 0 ? (
        <ProovraCard>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
            Worth doing before you finish
          </ProovraText>
          {suggestions.map((s) => (
            <View key={s.id} style={{ gap: 2 }}>
              <ProovraText variant="bodySm" weight="semibold">
                {s.title}
              </ProovraText>
              <ProovraText variant="label" color={theme.color.ink.muted}>
                {s.body}
              </ProovraText>
            </View>
          ))}
          {/* Never blocking. The operator finishes whenever they choose. */}
          <ProovraText variant="label" color={theme.color.ink.muted}>
            None of these stops you finishing.
          </ProovraText>
        </ProovraCard>
      ) : null}

      <ProovraSheet visible={picker} title="Collection plan" onClose={() => setPicker(false)}>
        <ProovraListRow
          title="No plan"
          subtitle="Capture without a checklist."
          onPress={() => pick(null)}
        />
        {(templates ?? []).map((t) => (
          <ProovraListRow
            key={t.id}
            title={t.name}
            subtitle={t.description}
            onPress={() => pick(t)}
            trailing={
              template?.id === t.id ? <ProovraBadge label="Selected" tone="verified" /> : undefined
            }
          />
        ))}
        <ProovraButton label="Close" variant="ghost" onPress={() => setPicker(false)} />
      </ProovraSheet>
    </>
  );
}
