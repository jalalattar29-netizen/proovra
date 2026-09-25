/**
 * CAPTURE SETUP — the web's "Collection setup · Intake structure" strip
 * (capture/page.tsx:817-885) and `components/capture-v2/CaptureRequirements`.
 *
 * Every number here is read from `buildSessionReadiness`; nothing is decided
 * in this file. Like the web, the plan and the mode are chosen BEFORE material
 * is staged and locked once it is (`disabled={busy || hasSessionItems}`),
 * because the staged items are mapped against the plan's steps.
 */
import React, { useState } from "react";
import { Pressable, Switch, View } from "react-native";

import { theme } from "../theme/theme";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraListRow, ProovraSheet, ProovraText } from "./index";
import {
  captureKindLabel,
  type CapturePlanMode,
  type CollectionPlanTemplate,
  type SessionReadiness,
} from "../product/capture-plan";

const UPPER = { textTransform: "uppercase" as const, letterSpacing: 0.4 };

function SectionLabel({ children }: { children: string }) {
  return (
    <ProovraText variant="label" weight="bold" color={theme.color.ink.muted} style={UPPER}>
      {children}
    </ProovraText>
  );
}

function ModeOption({
  title,
  sub,
  active,
  disabled,
  onPress,
}: {
  title: string;
  sub: string;
  active: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${sub}`}
      accessibilityState={{ selected: active, disabled }}
      style={{
        flex: 1,
        minWidth: 130,
        borderWidth: 1,
        borderRadius: theme.radius.md,
        padding: theme.space.s3,
        gap: 2,
        borderColor: active ? theme.color.accent.a500 : theme.color.border.default,
        backgroundColor: active ? theme.color.accent.a050 : theme.color.surface.card,
        opacity: disabled && !active ? 0.6 : 1,
      }}
    >
      <ProovraText variant="bodySm" weight="semibold" color={active ? theme.color.accent.a600 : theme.color.ink.primary}>
        {title}
      </ProovraText>
      <ProovraText variant="label" color={theme.color.ink.secondary}>{sub}</ProovraText>
    </Pressable>
  );
}

/** "Collection setup · Intake structure": Guided / Flexible / Location. */
export function CaptureIntakeStructure({
  planMode,
  onPlanMode,
  useLocation,
  onUseLocation,
  busy,
  hasSessionItems,
}: {
  planMode: CapturePlanMode;
  onPlanMode: (m: CapturePlanMode) => void;
  useLocation: boolean;
  onUseLocation: (v: boolean) => void;
  busy: boolean;
  hasSessionItems: boolean;
}) {
  const locked = busy || hasSessionItems;
  return (
    <ProovraCard testID="capture-intake-structure" style={{ gap: theme.space.s2 }}>
      <SectionLabel>Collection setup</SectionLabel>
      <ProovraText variant="h3" weight="semibold">Intake structure</ProovraText>
      <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
        Choose whether this session follows a required checklist, flexible intake, or location-enabled collection.
      </ProovraText>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
        <ModeOption title="Guided" sub="Checklist required" active={planMode === "CHECKLIST_REQUIRED"} disabled={locked} onPress={() => onPlanMode("CHECKLIST_REQUIRED")} />
        <ModeOption title="Flexible" sub="General intake" active={planMode === "FLEXIBLE"} disabled={locked} onPress={() => onPlanMode("FLEXIBLE")} />
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          borderWidth: 1,
          borderRadius: theme.radius.md,
          padding: theme.space.s3,
          borderColor: useLocation ? theme.color.accent.a500 : theme.color.border.default,
          backgroundColor: useLocation ? theme.color.accent.a050 : theme.color.surface.card,
        }}
      >
        <View style={{ gap: 2 }}>
          <ProovraText variant="bodySm" weight="semibold">Location</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>{useLocation ? "Included" : "Not included"}</ProovraText>
        </View>
        <Switch value={useLocation} onValueChange={onUseLocation} disabled={busy} accessibilityLabel="Include location metadata" />
      </View>
    </ProovraCard>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "risk" | "pending" | "verified" }) {
  const t = tone ? theme.color.status[tone] : null;
  return (
    <View
      style={{
        flex: 1,
        minWidth: 90,
        borderWidth: 1,
        borderRadius: theme.radius.sm,
        padding: theme.space.s2,
        borderColor: t ? t.border : theme.color.border.default,
        backgroundColor: t ? t.bg : theme.color.surface.card,
      }}
    >
      <ProovraText variant="label" color={theme.color.ink.secondary}>{label}</ProovraText>
      <ProovraText variant="h3" weight="bold" color={t ? t.fg : theme.color.ink.primary}>{value}</ProovraText>
    </View>
  );
}

/** Web CaptureRequirements: plan picker, summary strip, finish gate, requirement rows. */
export function CaptureRequirements({
  templates,
  plan,
  onSelectPlan,
  readiness,
  stepItemCounts,
  busy,
  hasSessionItems,
}: {
  templates: CollectionPlanTemplate[] | null;
  plan: CollectionPlanTemplate | null;
  onSelectPlan: (t: CollectionPlanTemplate | null) => void;
  readiness: SessionReadiness;
  /** How many staged items map to each step id. */
  stepItemCounts: Record<string, number>;
  busy: boolean;
  hasSessionItems: boolean;
}) {
  const [picker, setPicker] = useState(false);
  const locked = busy || hasSessionItems;
  const missingRequired = readiness.missingRequiredSteps.length;
  const optionalSteps = plan?.steps.filter((s) => !s.required) ?? [];
  const optionalMapped = optionalSteps.filter((s) => (stepItemCounts[s.id] ?? 0) > 0).length;
  const progress = readiness.requiredTotal > 0 ? Math.round((readiness.requiredCompleted / readiness.requiredTotal) * 100) : 100;

  return (
    <ProovraCard testID="capture-requirements" style={{ gap: theme.space.s3 }}>
      <View style={{ gap: 2 }}>
        <SectionLabel>Requirements</SectionLabel>
        <ProovraText variant="h3" weight="semibold">{plan?.name ?? "Evidence intake"}</ProovraText>
        {plan?.description ? <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{plan.description}</ProovraText> : null}
      </View>

      {templates === null ? (
        <ProovraText variant="label" color={theme.color.ink.muted}>
          Collection plans could not be loaded. You can capture without one.
        </ProovraText>
      ) : (
        <ProovraListRow
          title={plan ? plan.name : "No plan selected"}
          subtitle={locked ? "The plan is fixed once material is staged." : "Collection plan"}
          onPress={locked ? undefined : () => setPicker(true)}
        />
      )}

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
        <Metric label="Required mapped" value={`${readiness.requiredCompleted}/${readiness.requiredTotal}`} tone={missingRequired > 0 ? "risk" : "verified"} />
        <Metric label="Optional mapped" value={`${optionalMapped}/${optionalSteps.length}`} />
        <Metric label="Unmapped materials" value={String(readiness.unmappedCount)} tone={readiness.unmappedCount > 0 ? "pending" : "verified"} />
      </View>

      <View style={{ gap: 6 }} accessibilityLabel="Required mapping progress" testID="capture-finish-gate">
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.space.s2 }}>
          <ProovraText variant="label" color={theme.color.ink.secondary}>Finish gate</ProovraText>
          <ProovraText variant="label" weight="semibold">
            {missingRequired > 0 ? `${missingRequired} required unmapped` : "All required mapped"}
          </ProovraText>
        </View>
        <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.color.surface.muted, overflow: "hidden" }}>
          <View style={{ width: `${progress}%`, height: 6, backgroundColor: theme.color.accent.a500 }} />
        </View>
      </View>

      {plan
        ? plan.steps.map((step, index) => {
            const count = stepItemCounts[step.id] ?? 0;
            const mapped = count > 0;
            const requiredMissing = step.required && !mapped;
            const accepts = step.acceptedKinds.map(captureKindLabel).join(", ");
            const mappingLabel = mapped
              ? `${count} material${count === 1 ? "" : "s"} mapped`
              : step.required
                ? "Required unmapped"
                : "Optional unmapped";
            return (
              <View
                key={step.id}
                testID={`capture-requirement-${step.id}`}
                style={{
                  flexDirection: "row",
                  gap: theme.space.s2,
                  borderTopWidth: 1,
                  borderTopColor: theme.color.border.subtle,
                  paddingTop: theme.space.s2,
                }}
              >
                <ProovraText variant="label" weight="bold" color={theme.color.ink.muted}>{String(index + 1)}</ProovraText>
                <View style={{ flex: 1, gap: 4 }}>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s2 }}>
                    <ProovraText variant="bodySm" weight="semibold">{step.title}</ProovraText>
                    <ProovraBadge label={step.required ? "Required to finish" : "Optional context"} tone={step.required ? "governance" : "neutral"} />
                  </View>
                  {step.description ? <ProovraText variant="label" color={theme.color.ink.secondary}>{step.description}</ProovraText> : null}
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
                    <ProovraBadge label={mappingLabel} tone={mapped ? "verified" : requiredMissing ? "risk" : "neutral"} />
                    {accepts ? <ProovraText variant="label" color={theme.color.ink.muted}>{`Accepts ${accepts}`}</ProovraText> : null}
                  </View>
                </View>
                <View style={{ alignItems: "flex-end", maxWidth: 120 }}>
                  <ProovraText
                    variant="label"
                    weight="semibold"
                    color={mapped ? theme.color.status.verified.fg : requiredMissing ? theme.color.status.risk.fg : theme.color.ink.secondary}
                  >
                    {mapped ? "Mapped" : step.required ? "Unmapped" : "Optional"}
                  </ProovraText>
                  <ProovraText variant="label" color={theme.color.ink.muted}>
                    {mapped
                      ? `${count} linked item${count === 1 ? "" : "s"}`
                      : step.required
                        ? "Blocks Review & Sign"
                        : "Does not block finish"}
                  </ProovraText>
                </View>
              </View>
            );
          })
        : null}

      <ProovraSheet visible={picker} title="Collection plan" onClose={() => setPicker(false)}>
        <ProovraListRow
          title="No plan"
          subtitle="Capture without a checklist."
          onPress={() => {
            onSelectPlan(null);
            setPicker(false);
          }}
        />
        {(templates ?? []).map((t) => (
          <ProovraListRow
            key={t.id}
            title={t.name}
            subtitle={t.description}
            onPress={() => {
              onSelectPlan(t);
              setPicker(false);
            }}
            trailing={plan?.id === t.id ? <ProovraBadge label="Selected" tone="verified" /> : undefined}
          />
        ))}
        <ProovraButton label="Close" variant="ghost" onPress={() => setPicker(false)} />
      </ProovraSheet>
    </ProovraCard>
  );
}
