/**
 * AI & ASSISTANCE — what AI does in this workspace, and who decided it.
 *
 * The app used AI-assisted surfaces and could not answer the one question a
 * person is owed about them. The web answers it on `/settings`, which is a
 * NATIVE_REQUIRED surface, from a read every membership role can make
 * (`governance.policy.read`) — so a VIEWER can learn what governs them
 * without being granted `intelligence.read`.
 *
 * TRANSPARENCY IS NOT AUTHORITY — and T-15 kept that line: switches appear ONLY
 * where the web shows them (personal assistance, organization governance) and
 * only when the SERVER returned the editable policy (src/ui/ai-policy-editor).
 * A member refused the policy read still gets this read-only answer, never a
 * greyed-out toggle that invites a tap and then refuses it.
 */
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch } from "../../../src/api";
import { toSafeUserError, type SafeError } from "../../../src/errors/safe-error";
import { theme } from "../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraListRow,
  ProovraPageHeader,
  ProovraPageSection,
  ProovraEmptyState,
  ProovraErrorState,
  ProovraLoadingState,
} from "../../../src/ui";
import { usePlatformContext } from "../../../src/product/platform-context";
import {
  aiFeatureStateDisplay,
  aiStatusDisplay,
  aiStatusDetail,
  buildAiAssistanceStatusPath,
  parseAiAssistanceSettings,
  type AiAssistanceSettings,
  resolveAiManagedBy,
  aiManagedByLabel,
  aiProcessingRows,
  AI_ADVISORY_NOTICE,
  AI_NOT_INCLUDED_COPY,
} from "../../../src/product/ai-assistance";
import { deriveAiSettingsMode } from "../../../src/product/ai-policy";
import { AiPolicyEditor } from "../../../src/ui/ai-policy-editor";

type Phase = "loading" | "ready" | "error" | "unavailable";

export default function AiSettingsScreen() {
  const [editorShown, setEditorShown] = useState(false);
  const router = useRouter();
  const { context, envelope } = usePlatformContext();
  const teamId = context?.activeTeamId ?? null;
  const workspaceKind = context?.activeSpaceType ?? null;

  const [phase, setPhase] = useState<Phase>("loading");
  // The web's deriveAiSettingsMode inputs, from the same envelope.
  const env = (envelope ?? {}) as { planFeatures?: Record<string, unknown>; capabilities?: Record<string, unknown> };
  const allowance = env.planFeatures?.["aiAssistanceMonthlyOperations"];
  const settingsManage = env.capabilities?.["SETTINGS_MANAGE"];
  const aiMode = deriveAiSettingsMode({
    workspaceKind: workspaceKind === "ORGANIZATION" ? "ORGANIZATION" : "PERSONAL",
    monthlyAllowance: typeof allowance === "number" ? allowance : null,
    canManageWorkspaceAiPolicy: typeof settingsManage === "boolean" ? settingsManage : null,
  });
  const [error, setError] = useState<SafeError | null>(null);
  const [settings, setSettings] = useState<AiAssistanceSettings | null>(null);

  const load = useCallback(async () => {
    if (!teamId) return;
    setPhase("loading");
    setError(null);
    try {
      const data = await apiFetch(buildAiAssistanceStatusPath(teamId));
      setSettings(parseAiAssistanceSettings(data));
      setPhase("ready");
    } catch (err) {
      const safe = toSafeUserError(err);
      // A refusal here is a fact about the workspace, not a broken screen.
      if (safe.kind === "forbidden" || safe.kind === "notFound") setPhase("unavailable");
      else {
        setError(safe);
        setPhase("error");
      }
    }
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!teamId) {
    return (
      <ProovraScreen shell scroll={false}>
        <ProovraEmptyState
          title="No workspace selected"
          message="Open a workspace to see how AI is configured in it."
          action={<ProovraButton label="Back" fullWidth={false} onPress={() => router.back()} />}
        />
      </ProovraScreen>
    );
  }
  if (phase === "loading") {
    return (
      <ProovraScreen shell scroll={false}>
        <ProovraLoadingState label="Loading AI settings" />
      </ProovraScreen>
    );
  }
  if (phase === "unavailable") {
    return (
      <ProovraScreen shell scroll={false}>
        <ProovraEmptyState
          title="Not available"
          message="This workspace does not make its AI configuration available to you."
          action={<ProovraButton label="Back" fullWidth={false} onPress={() => router.back()} />}
        />
      </ProovraScreen>
    );
  }
  if (phase === "error" && error) {
    return (
      <ProovraScreen shell scroll={false}>
        <ProovraErrorState message={error.message} onRetry={load} />
      </ProovraScreen>
    );
  }

  const s = settings!;
  const status = aiStatusDisplay(s.status);
  const managedBy = resolveAiManagedBy({
    status: s.status,
    workspaceKind,
    canManage: typeof settingsManage === "boolean" ? settingsManage : null,
  });

  return (
    <ProovraScreen shell>
      <View style={{ flexDirection: "row", marginTop: theme.space.s2 }}>
        <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
      </View>
      <ProovraPageHeader
        title="AI & assistance"
        subtitle="Whether AI assistance is available in this workspace, what it may be used for, and the allowance your plan or agreement provides."
      />

      {/* The effective answer first (the web's AiStatusRow), before any switch. */}
      <ProovraPageSection title="AI assistance">
        <ProovraCard style={{ gap: theme.space.s2 }} testID="ai-status">
          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.space.s2 }}>
            <ProovraText variant="body" weight="semibold">
              In this workspace
            </ProovraText>
            <ProovraBadge tone={status.tone} label={status.label} />
          </View>
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            {AI_ADVISORY_NOTICE}
          </ProovraText>
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
            {aiStatusDetail(s.status, s.enabled, status.detail)}
          </ProovraText>
        </ProovraCard>
      </ProovraPageSection>

      {aiMode === "personal-not-included" ? (
        // FREE: an honest, control-free surface with the way forward (AiSection :309).
        <ProovraCard style={{ gap: theme.space.s2 }} testID="ai-not-included">
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{AI_NOT_INCLUDED_COPY}</ProovraText>
          <ProovraButton label="See plans" variant="secondary" fullWidth={false} onPress={() => router.push("/(stack)/billing")} />
        </ProovraCard>
      ) : (
        <>
          {teamId ? <AiPolicyEditor teamId={teamId} mode={aiMode} onVisibility={setEditorShown} /> : null}

          {/* The member-safe read-only view (AiReadOnlyView) — rendered when the
              editor is not, never beside it. */}
          {!editorShown ? (
            <>
              <ProovraPageSection title="AI features">
                {s.features.length === 0 ? (
                  <ProovraText variant="bodySm" color={theme.color.ink.muted}>
                    This workspace lists no AI capabilities.
                  </ProovraText>
                ) : (
                  <ProovraCard>
                    {s.features.map((f) => {
                      const state = aiFeatureStateDisplay(f.state);
                      return (
                        <ProovraListRow
                          key={f.id}
                          title={f.label}
                          subtitle={f.description || undefined}
                          trailing={<ProovraBadge tone={state.tone} label={state.label} />}
                        />
                      );
                    })}
                  </ProovraCard>
                )}
              </ProovraPageSection>

              <ProovraPageSection title="How AI uses your data">
                <ProovraCard style={{ gap: theme.space.s2 }} testID="ai-data">
                  {aiProcessingRows(s.processing).map((row) => (
                    <View key={row.name} style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.space.s3 }}>
                      <ProovraText variant="label" color={theme.color.ink.secondary}>{row.name}</ProovraText>
                      <ProovraText variant="label" weight="semibold" style={{ flexShrink: 1, textAlign: "right" }}>{row.value}</ProovraText>
                    </View>
                  ))}
                  <ProovraButton
                    label="View AI Use Policy →"
                    variant="ghost"
                    fullWidth={false}
                    onPress={() => router.push("/legal/ai-use-policy")}
                  />
                </ProovraCard>
              </ProovraPageSection>

              {/*
                Who decides, rather than a disabled control. Never claims an
                organization-level lock PROOVRA does not have: the policy row is
                keyed by workspace.
              */}
              <ProovraPageSection title="Workspace AI policy">
                <ProovraCard style={{ gap: theme.space.s2 }} testID="ai-governance">
                  <View style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.space.s3 }}>
                    <ProovraText variant="label" color={theme.color.ink.secondary}>Effective state</ProovraText>
                    <ProovraBadge tone={status.tone} label={status.label} />
                  </View>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.space.s3 }}>
                    <ProovraText variant="label" color={theme.color.ink.secondary}>Managed by</ProovraText>
                    <ProovraText variant="label" weight="semibold">{aiManagedByLabel(managedBy)}</ProovraText>
                  </View>
                  <ProovraText variant="label" color={theme.color.ink.muted}>
                    You can see this policy but cannot change it. Ask a workspace administrator if it needs to be different.
                  </ProovraText>
                </ProovraCard>
              </ProovraPageSection>
            </>
          ) : null}
        </>
      )}
    </ProovraScreen>
  );
}


