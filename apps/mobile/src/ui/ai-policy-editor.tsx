/**
 * AI POLICY EDITOR (T-15) — see src/product/ai-policy.ts.
 *
 * Renders ONLY where the web renders switches (personal-assistance,
 * org-governance) AND the server returned the editable policy envelope. A
 * 403 on the policy read renders nothing: the screen's read-only
 * transparency view (what is on, and who decides) stays the answer.
 * Touch adaptation: checkboxes become switch rows.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch } from "../api";
import { theme } from "../theme/theme";
import {
  AI_POLICY_PUT_PATH,
  GOVERNANCE_TOGGLES,
  LAUNCHED_PERSONAL_AI_FEATURES,
  aiPlanLabel,
  aiPolicySaveFailure,
  aiUsageResetLabel,
  buildAiPolicyBody,
  buildAiPolicyPath,
  buildAiUsagePath,
  isAiPolicyDirty,
  parseAiPolicyEnvelope,
  parseAiUsage,
  type AiPolicy,
  type AiPolicyEnvelope,
  type AiSettingsMode,
  type AiUsageAllowance,
} from "../product/ai-policy";
import { ProovraButton, ProovraCard, ProovraText } from "./index";
import { ProovraPageSection } from "./patterns";

function SwitchRow({
  label,
  hint,
  value,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Pressable
      onPress={() => !disabled && onChange(!value)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled: !!disabled }}
      accessibilityLabel={label}
      style={{ flexDirection: "row", alignItems: "flex-start", gap: theme.space.s3, paddingVertical: theme.space.s2, opacity: disabled ? 0.55 : 1 }}
    >
      <View
        style={{
          width: 36,
          height: 22,
          borderRadius: 11,
          padding: 2,
          backgroundColor: value ? theme.color.accent.a500 : theme.color.border.strong,
          alignItems: value ? "flex-end" : "flex-start",
        }}
      >
        <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: "#fff" }} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <ProovraText variant="bodySm" weight="semibold">{label}</ProovraText>
        {hint ? <ProovraText variant="label" color={theme.color.ink.muted}>{hint}</ProovraText> : null}
      </View>
    </Pressable>
  );
}

function UsageRows({ allowance, monthUtc }: { allowance: AiUsageAllowance; monthUtc: string | null }) {
  const reset = aiUsageResetLabel(monthUtc);
  const row = (k: string, v: string) => (
    <View key={k} style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.space.s3 }}>
      <ProovraText variant="label" color={theme.color.ink.secondary}>{k}</ProovraText>
      <ProovraText variant="label">{v}</ProovraText>
    </View>
  );
  return (
    <View style={{ gap: theme.space.s1 }} testID="ai-usage">
      {row("Current plan", aiPlanLabel(allowance.plan))}
      {row("Monthly allowance", allowance.monthlyOperations === null ? "Custom" : `${allowance.monthlyOperations} operations`)}
      {row("Used", allowance.monthlyOperations === null ? `${allowance.consumed} operations` : `${allowance.consumed} of ${allowance.monthlyOperations}`)}
      {allowance.remaining !== null ? row("Remaining", String(allowance.remaining)) : null}
      {reset ? row("Resets on", reset) : null}
    </View>
  );
}

/** The web's allowance bar (AiSection.tsx "Monthly AI operations used"). */
function UsageBar({ consumed, cap }: { consumed: number; cap: number }) {
  const pct = Math.min(100, (consumed / cap) * 100);
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel="Monthly AI operations used"
      accessibilityValue={{ min: 0, max: cap, now: Math.min(consumed, cap) }}
      style={{ marginTop: theme.space.s3, height: 8, borderRadius: theme.radius.pill, backgroundColor: theme.color.border.subtle, overflow: "hidden" }}
    >
      <View style={{ height: "100%", width: `${pct}%`, borderRadius: theme.radius.pill, backgroundColor: theme.color.accent.a500 }} />
    </View>
  );
}

export function AiPolicyEditor({
  teamId,
  mode,
  onVisibility,
}: {
  teamId: string;
  mode: AiSettingsMode;
  /** Told whether the editor is showing, so the screen renders the editor OR the read-only view — as the web does, never both. */
  onVisibility?: (visible: boolean) => void;
}) {
  const router = useRouter();
  const [envelope, setEnvelope] = useState<AiPolicyEnvelope | null>(null);
  const [draft, setDraft] = useState<AiPolicy | null>(null);
  const [usage, setUsage] = useState<{ monthUtc: string | null; allowance: AiUsageAllowance | null } | null>(null);
  const [status, setStatus] = useState<"loading" | "idle" | "saving" | "saved" | "conflict" | "denied" | "error" | "hidden" | "load-failed">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const editable = mode === "personal-assistance" || mode === "org-governance";

  const load = useCallback(async () => {
    setStatus("loading");
    setMessage(null);
    try {
      const env = parseAiPolicyEnvelope(await apiFetch(buildAiPolicyPath(teamId)));
      if (!env) {
        setStatus("hidden");
        return;
      }
      setEnvelope(env);
      setDraft(env.policy);
      setStatus("idle");
    } catch (err) {
      // 403 is an ANSWER — this member may read the status only, which the
      // screen already shows. Anything else is a failure, and is said.
      if ((err as { statusCode?: number } | null)?.statusCode === 403) {
        setStatus("hidden");
        return;
      }
      setStatus("load-failed");
      return;
    }
    try {
      setUsage(parseAiUsage(await apiFetch(buildAiUsagePath(teamId))));
    } catch {
      /* usage is optional */
    }
  }, [teamId]);

  useEffect(() => {
    // Clear first: a stale editable policy from another workspace must never show.
    setEnvelope(null);
    setDraft(null);
    setUsage(null);
    if (editable) void load();
    else setStatus("hidden");
  }, [load, editable]);

  const visible = editable && status !== "hidden";
  useEffect(() => {
    onVisibility?.(visible);
  }, [visible, onVisibility]);

  const dirty = !!(draft && envelope && isAiPolicyDirty(draft, envelope.policy));

  const save = async () => {
    if (!draft || !envelope || !dirty) return;
    setStatus("saving");
    setMessage(null);
    try {
      const res = parseAiPolicyEnvelope(
        await apiFetch(AI_POLICY_PUT_PATH, { method: "PUT", body: JSON.stringify(buildAiPolicyBody(teamId, envelope, draft)) }),
      );
      if (res) {
        setEnvelope(res);
        setDraft(res.policy);
      }
      setStatus("saved");
      setMessage("Saved. Changes take effect immediately.");
    } catch (err) {
      const f = aiPolicySaveFailure((err as { statusCode?: number } | null)?.statusCode);
      setStatus(f.kind);
      setMessage(f.message);
    }
  };

  if (status === "hidden" || !editable) return null;
  if (status === "load-failed") {
    return (
      <ProovraCard>
        <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>Could not load the AI settings for this workspace.</ProovraText>
        <ProovraButton label="Try again" variant="secondary" fullWidth={false} onPress={() => void load()} />
      </ProovraCard>
    );
  }
  if (status === "loading" || !draft) {
    return <ProovraText variant="label" color={theme.color.ink.muted}>Loading AI settings…</ProovraText>;
  }

  const saving = status === "saving";
  const set = (k: keyof AiPolicy) => (v: boolean) => setDraft({ ...draft, [k]: v });
  const feedback = message ? (
    <ProovraCard>
      <ProovraText variant="bodySm" color={status === "saved" ? theme.color.status.verified.fg : theme.color.status.risk.fg}>{message}</ProovraText>
      {status === "conflict" ? <ProovraButton label="Reload latest" variant="ghost" fullWidth={false} onPress={() => void load()} /> : null}
    </ProovraCard>
  ) : null;

  if (mode === "org-governance") {
    return (
      <View style={{ gap: theme.space.s3 }} testID="ai-policy-editor-org">
        {feedback}
        <ProovraPageSection title="Master AI policy">
          <ProovraCard>
            <SwitchRow
              label="AI capabilities may run in this workspace (per the policy below)"
              value={draft.aiEnabled}
              disabled={saving}
              onChange={set("aiEnabled")}
            />
          </ProovraCard>
        </ProovraPageSection>
        <ProovraPageSection title="Capabilities & data classes">
          <ProovraCard>
            {GOVERNANCE_TOGGLES.map((t) => (
              <SwitchRow key={t.key} label={t.label} hint={t.hint} value={draft[t.key]} disabled={saving || !draft.aiEnabled} onChange={set(t.key)} />
            ))}
            {!draft.aiEnabled ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>Turn on AI assistance above to choose this.</ProovraText>
            ) : null}
          </ProovraCard>
        </ProovraPageSection>
        {usage?.allowance ? (
          <ProovraPageSection title="Usage & governance">
            <ProovraCard>
              <UsageRows allowance={usage.allowance} monthUtc={usage.monthUtc} />
            </ProovraCard>
          </ProovraPageSection>
        ) : null}
        <ProovraButton label="Save AI policy" loading={saving} disabled={saving || !dirty} onPress={() => void save()} />
        {!dirty ? <ProovraText variant="label" color={theme.color.ink.muted}>There are no changes to save.</ProovraText> : null}
      </View>
    );
  }

  return (
    <View style={{ gap: theme.space.s3 }} testID="ai-policy-editor-personal">
      <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
        Control the AI-assisted features available in your Personal Space. AI provides advisory support only and never determines truth, authenticity, or admissibility.
      </ProovraText>
      {feedback}
      <ProovraPageSection title="Monthly usage">
        <ProovraCard>
          {usage?.allowance ? (
            <>
              <UsageRows allowance={usage.allowance} monthUtc={usage.monthUtc} />
              {usage.allowance.monthlyOperations !== null && usage.allowance.monthlyOperations > 0 ? (
                <UsageBar consumed={usage.allowance.consumed} cap={usage.allowance.monthlyOperations} />
              ) : null}
            </>
          ) : (
            <ProovraText variant="label" color={theme.color.ink.muted}>Usage is unavailable right now.</ProovraText>
          )}
        </ProovraCard>
      </ProovraPageSection>
      <ProovraPageSection title="AI assistance">
        <ProovraCard>
          <SwitchRow
            label="Enable AI assistance in this workspace"
            hint="Turning this off stops every AI-assisted feature immediately — enforcement is server-side on each request, not just in this page."
            value={draft.aiEnabled}
            disabled={saving}
            onChange={set("aiEnabled")}
          />
        </ProovraCard>
      </ProovraPageSection>
      <ProovraPageSection title="Available features">
        <ProovraCard>
          {LAUNCHED_PERSONAL_AI_FEATURES.map((f) => (
            <SwitchRow key={f.key} label={f.label} hint={f.description} value={draft[f.key]} disabled={saving || !draft.aiEnabled} onChange={set(f.key)} />
          ))}
          {!draft.aiEnabled ? (
            <ProovraText variant="label" color={theme.color.ink.muted}>Turn on AI assistance above to choose features.</ProovraText>
          ) : null}
        </ProovraCard>
      </ProovraPageSection>
      <ProovraPageSection title="How AI uses your data">
        <ProovraCard>
          <ProovraText variant="label" color={theme.color.ink.secondary}>• These features use metadata only — never your evidence files.</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            • AI output is advisory only. It never determines authenticity, truth, or admissibility, and never blocks capture, reports, or verification.
          </ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>• Each feature runs only when you have it enabled here.</ProovraText>
          <ProovraButton label="Review AI transparency and subprocessors →" variant="ghost" fullWidth={false} onPress={() => router.push("/(stack)/trust-center")} />
        </ProovraCard>
      </ProovraPageSection>
      <ProovraButton label="Save changes" loading={saving} disabled={saving || !dirty} onPress={() => void save()} />
      {!dirty ? <ProovraText variant="label" color={theme.color.ink.muted}>There are no changes to save.</ProovraText> : null}
    </View>
  );
}
