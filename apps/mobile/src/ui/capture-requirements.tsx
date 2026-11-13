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
      accessibilityLabel={title}
      accessibilityHint={sub}
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

const LOCATION_REQUIREMENT_LABEL = {
  optional: "Optional for this template",
  recommended: "Recommended by this template",
  required: "Required by this template",
} as const;

/**
 * SETUP: collection mode, then capture context.
 *
 * Verified in `buildSessionReadiness`: Guided (CHECKLIST_REQUIRED) blocks
 * Finish & Sign until every required step is assigned; Flexible reports them
 * but does not block. Location is NOT a third mode — it is a separate switch
 * that coexists with either, and the template's `locationRequirement` decides
 * whether leaving it off is a warning or a blocker. It is shown apart for that
 * reason.
 */
export function CaptureIntakeStructure({
  planMode,
  onPlanMode,
  useLocation,
  onUseLocation,
  busy,
  hasSessionItems,
  locationStatus,
  locationLocked,
  locationRequirement,
}: {
  /** The template's rule for location, stated beside the switch. */
  locationRequirement?: "optional" | "recommended" | "required";
  planMode: CapturePlanMode;
  onPlanMode: (m: CapturePlanMode) => void;
  useLocation: boolean;
  onUseLocation: (v: boolean) => void;
  busy: boolean;
  hasSessionItems: boolean;
  /** What the device answered, or what a recording carries — stated, never silent. */
  locationStatus?: string | null;
  /**
   * A recording's location was decided when it STARTED: the switch still
   * answers a tap (with why it cannot change), but the value is read-only.
   */
  locationLocked?: boolean;
}) {
  const locked = busy || hasSessionItems;
  return (
    <View testID="capture-intake-structure" style={{ gap: theme.space.s2 }}>
      <SectionLabel>Collection mode</SectionLabel>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
        <ModeOption title="Guided" sub="Required items must be assigned before Finish & Sign" active={planMode === "CHECKLIST_REQUIRED"} disabled={locked} onPress={() => onPlanMode("CHECKLIST_REQUIRED")} />
        <ModeOption title="Flexible" sub="Start right away; required items are recommended" active={planMode === "FLEXIBLE"} disabled={locked} onPress={() => onPlanMode("FLEXIBLE")} />
      </View>
      {hasSessionItems ? (
        <ProovraText variant="label" color={theme.color.ink.muted} testID="capture-setup-locked">
          Template and mode are fixed once evidence is staged. Clear the session to change them.
        </ProovraText>
      ) : null}
      <SectionLabel>Capture context</SectionLabel>
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
        <View style={{ gap: 2, flex: 1 }}>
          <ProovraText variant="bodySm" weight="semibold">Include device location</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            {`${LOCATION_REQUIREMENT_LABEL[locationRequirement ?? "optional"]} · ${
              locationLocked ? "Set when the recording started" : useLocation ? "Included" : "Not included"
            }`}
          </ProovraText>
        </View>
        <Switch value={useLocation} onValueChange={onUseLocation} disabled={busy} accessibilityLabel="Include location metadata" />
      </View>
      {locationStatus ? (
        <ProovraText variant="label" color={theme.color.ink.secondary} testID="capture-location-status">
          {locationStatus}
        </ProovraText>
      ) : null}
    </View>
  );
}

/** The template picker: a row that opens the existing plan sheet. Locked once material is staged. */
export function CaptureTemplatePicker({
  templates,
  plan,
  onSelectPlan,
  busy,
  hasSessionItems,
}: {
  templates: CollectionPlanTemplate[] | null;
  plan: CollectionPlanTemplate | null;
  onSelectPlan: (t: CollectionPlanTemplate | null) => void;
  busy: boolean;
  hasSessionItems: boolean;
}) {
  const [picker, setPicker] = useState(false);
  const locked = busy || hasSessionItems;
  return (
    <View style={{ gap: theme.space.s2 }} testID="capture-template-picker">
      <SectionLabel>Template</SectionLabel>
      {templates === null ? (
        <ProovraText variant="label" color={theme.color.ink.muted}>
          Collection plans could not be loaded. You can capture without one.
        </ProovraText>
      ) : (
        <ProovraListRow
          title={plan ? plan.name : "No plan selected"}
          subtitle={locked ? "The plan is fixed once material is staged." : plan?.description || "Collection plan"}
          onPress={locked ? undefined : () => setPicker(true)}
        />
      )}
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
    </View>
  );
}

/**
 * REQUIREMENTS — the template's checklist, as something the person can act on.
 *
 * Every state is read from `buildSessionReadiness` and the step counts. The
 * label follows the ACTIVE mode: in Guided a required step blocks Finish &
 * Sign ("Required"); in Flexible it does not ("Recommended") — the old copy
 * said "Blocks Review & Sign" in both modes. An open step offers its next
 * action directly: assign a staged file, or add one.
 */
export function CaptureRequirements({
  plan,
  planMode,
  readiness,
  stepItemCounts,
  busy,
  onAddForStep,
  onAssignForStep,
}: {
  plan: CollectionPlanTemplate | null;
  planMode: CapturePlanMode;
  readiness: SessionReadiness;
  /** How many staged items map to each step id. */
  stepItemCounts: Record<string, number>;
  busy: boolean;
  onAddForStep: (stepId: string) => void;
  onAssignForStep: (stepId: string) => void;
}) {
  const steps = plan?.steps ?? [];
  if (steps.length === 0) return null;
  const guided = planMode === "CHECKLIST_REQUIRED";
  const hasUnassigned = readiness.unmappedCount > 0;
  const ordered = [...steps.filter((s) => s.required), ...steps.filter((s) => !s.required)];

  return (
    <ProovraCard testID="capture-requirements" style={{ gap: theme.space.s3, marginBottom: theme.space.s3 }}>
      <View style={{ gap: 2 }}>
        <ProovraText variant="h3" weight="semibold">Requirements</ProovraText>
        <ProovraText variant="label" color={theme.color.ink.secondary}>
          {`${plan?.name ?? ""}${
            readiness.requiredTotal > 0
              ? ` · ${readiness.requiredCompleted} of ${readiness.requiredTotal} ${guided ? "required" : "recommended"} assigned`
              : ""
          }`}
        </ProovraText>
        {!guided && readiness.requiredTotal > 0 ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>Flexible mode: these do not block signing.</ProovraText>
        ) : null}
      </View>

      {ordered.map((step) => {
        const count = stepItemCounts[step.id] ?? 0;
        const mapped = count > 0;
        const tier = step.required ? (guided ? "required" : "recommended") : "optional";
        const tierLabel = tier === "required" ? "Required" : tier === "recommended" ? "Recommended" : "Optional";
        const blocking = tier === "required" && !mapped;
        const accepts = step.acceptedKinds.map(captureKindLabel).join(", ");
        const primary = /^primary[_-]/i.test(step.id);
        const actionLabel = hasUnassigned ? (primary ? "Mark a file as primary evidence" : "Assign a file") : "Add file";
        return (
          <View
            key={step.id}
            testID={`capture-requirement-${step.id}`}
            accessibilityLabel={`${step.title}, ${tierLabel}, ${mapped ? `${count} assigned` : "not assigned"}`}
            style={{
              gap: 6,
              borderTopWidth: 1,
              borderTopColor: theme.color.border.subtle,
              paddingTop: theme.space.s2,
              opacity: tier === "optional" && !mapped ? 0.9 : 1,
            }}
          >
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s2 }}>
              <ProovraText variant="bodySm" weight={tier === "optional" ? "regular" : "semibold"}>{step.title}</ProovraText>
              <ProovraBadge label={tierLabel} tone={tier === "required" ? "risk" : tier === "recommended" ? "pending" : "neutral"} />
            </View>
            {step.description ? (
              <ProovraText variant="label" color={theme.color.ink.secondary}>
                {`${step.description}${accepts ? ` Accepts ${accepts}.` : ""}`}
              </ProovraText>
            ) : null}
            {mapped ? (
              <ProovraText variant="label" weight="semibold" color={theme.color.status.verified.fg}>
                {`${count} file${count === 1 ? "" : "s"} assigned`}
              </ProovraText>
            ) : (
              <ProovraButton
                label={actionLabel}
                accessibilityLabel={`${actionLabel} for ${step.title}`}
                variant={blocking ? "primary" : "secondary"}
                fullWidth={false}
                disabled={busy}
                onPress={() => (hasUnassigned ? onAssignForStep(step.id) : onAddForStep(step.id))}
              />
            )}
          </View>
        );
      })}
    </ProovraCard>
  );
}
