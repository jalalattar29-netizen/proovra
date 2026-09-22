/**
 * AI & ASSISTANCE — what AI does in this workspace, and who decided it.
 *
 * The app used AI-assisted surfaces and could not answer the one question a
 * person is owed about them. The web answers it on `/settings`, which is a
 * NATIVE_REQUIRED surface, from a read every membership role can make
 * (`governance.policy.read`) — so a VIEWER can learn what governs them
 * without being granted `intelligence.read`.
 *
 * TRANSPARENCY IS NOT AUTHORITY. There are no switches here, and no disabled
 * ones either: a greyed-out toggle invites a tap and then refuses it, which is
 * a worse answer than a sentence naming who decides. Changing the policy is an
 * administration action the product keeps behind
 * `intelligence.policy.manage`.
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
  aiManagedByCopy,
  aiProcessingLines,
  aiStatusDisplay,
  buildAiAssistanceStatusPath,
  parseAiAssistanceSettings,
  type AiAssistanceSettings,
} from "../../../src/product/ai-assistance";

type Phase = "loading" | "ready" | "error" | "unavailable";

export default function AiSettingsScreen() {
  const router = useRouter();
  const { context } = usePlatformContext();
  const teamId = context?.activeTeamId ?? null;
  const workspaceKind = context?.activeSpaceType ?? null;

  const [phase, setPhase] = useState<Phase>("loading");
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
      <ProovraScreen scroll={false}>
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
      <ProovraScreen scroll={false}>
        <ProovraLoadingState label="Loading AI settings" />
      </ProovraScreen>
    );
  }
  if (phase === "unavailable") {
    return (
      <ProovraScreen scroll={false}>
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
      <ProovraScreen scroll={false}>
        <ProovraErrorState message={error.message} onRetry={load} />
      </ProovraScreen>
    );
  }

  const s = settings!;
  const status = aiStatusDisplay(s.status);

  return (
    <ProovraScreen>
      <View style={{ flexDirection: "row", marginTop: theme.space.s2 }}>
        <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
      </View>
      <ProovraPageHeader
        title="AI & assistance"
        subtitle="What AI does in this workspace, and who decides it"
      />

      <ProovraPageSection title="AI assistance">
        <ProovraCard style={{ gap: theme.space.s2 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.space.s2 }}>
            <ProovraText variant="body" weight="semibold">
              In this workspace
            </ProovraText>
            <ProovraBadge tone={status.tone} label={status.label} />
          </View>
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
            {status.detail}
          </ProovraText>
          {/*
            Who decides, rather than a disabled control. A personal workspace
            has no administrator other than its owner, and "ask your
            administrator" there sends somebody looking for a person who does
            not exist.
          */}
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {aiManagedByCopy(workspaceKind)}
          </ProovraText>
        </ProovraCard>
      </ProovraPageSection>

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

      <ProovraPageSection title="How AI uses your evidence">
        <ProovraCard style={{ gap: theme.space.s2 }}>
          {aiProcessingLines(s.processing).map((line) => (
            <ProovraText key={line} variant="bodySm" color={theme.color.ink.secondary}>
              {line}
            </ProovraText>
          ))}
        </ProovraCard>
      </ProovraPageSection>
    </ProovraScreen>
  );
}
