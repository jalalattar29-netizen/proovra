/**
 * LIVE AI CAPABILITY STATUS (T-14) — the touch port of the web
 * AiCapabilityStatusTable: one card per capability instead of a seven-column
 * table. Cleared on workspace change so one workspace's status never sits
 * under another's name.
 */
import React, { useEffect, useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { formatUserDateTime } from "../lib/date";
import {
  aiCapabilitiesFailure,
  aiCapabilityTone,
  aiEnumWords,
  buildAiCapabilitiesPath,
  parseAiCapabilities,
  type AiCapability,
} from "../product/ai-capabilities";
import { usePlatformContext } from "../product/platform-context";
import { theme } from "../theme/theme";
import { ProovraBadge, ProovraCard, ProovraText } from "./index";

export function AiCapabilityStatus() {
  const platform = usePlatformContext();
  const teamId = platform.context?.activeTeamId ?? null;
  const [caps, setCaps] = useState<AiCapability[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCaps(null);
    setError(null);
    if (!teamId) return;
    apiFetch(buildAiCapabilitiesPath(teamId))
      .then((d) => {
        if (!cancelled) setCaps(parseAiCapabilities(d));
      })
      .catch((err) => {
        if (cancelled) return;
        const status = (err as { statusCode?: unknown })?.statusCode;
        setError(aiCapabilitiesFailure(typeof status === "number" ? status : null));
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  if (!teamId) return null;
  return (
    <View style={{ gap: theme.space.s2 }} testID="ai-capability-status">
      <ProovraText variant="h3" weight="semibold">Live AI capability status (this workspace)</ProovraText>
      <ProovraText variant="label" color={theme.color.ink.secondary}>
        Computed from the actual platform configuration and this workspace’s AI policy — never inferred from the existence of code or a provider key. Stubs and previews are labelled as such.
      </ProovraText>
      {!caps && !error ? <ProovraText variant="label" color={theme.color.ink.muted}>Loading live status…</ProovraText> : null}
      {error ? <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{error}</ProovraText> : null}
      {(caps ?? []).map((c) => (
        <ProovraCard key={c.capability} testID={`ai-capability-${c.capability}`}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.space.s2, alignItems: "center" }}>
            <ProovraText variant="bodySm" weight="semibold">{c.capability}</ProovraText>
            <ProovraBadge label={aiEnumWords(c.operationalStatus)} tone={aiCapabilityTone(c.operationalStatus)} />
          </View>
          {c.purpose ? <ProovraText variant="label" color={theme.color.ink.muted}>{c.purpose}</ProovraText> : null}
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            {`Provider ${c.provider ?? "—"} · ${c.region ?? "—"} · ${c.transferMechanism ?? "—"}`}
          </ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            {`Data ${aiEnumWords(c.dataCategory)} · Default ${c.defaultState ?? "—"} · Opt-in ${c.workspaceOptInRequired ? "required" : "—"}`}
          </ProovraText>
          <ProovraText variant="label" color={theme.color.ink.muted}>{[c.trainingMode, c.retentionMode].filter(Boolean).join(" · ")}</ProovraText>
        </ProovraCard>
      ))}
      {caps && caps.length > 0 && caps[0].lastVerifiedAtUtc ? (
        <ProovraText variant="label" color={theme.color.ink.muted}>
          {`Last verified ${formatUserDateTime(caps[0].lastVerifiedAtUtc)} · statuses refresh on load.`}
        </ProovraText>
      ) : null}
    </View>
  );
}
