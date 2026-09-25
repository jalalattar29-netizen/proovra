/**
 * HOME — INTAKE STATUS card (T-15 / T-14) — see src/product/home-intake.ts.
 * The web's 3×2 stage-tile grid and per-link delivery rows; a failed send
 * offers "Retry delivery" (POST …/retry), and if the retry is refused the row
 * falls back to the link's delivery history, as on the web.
 */
import React, { useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch } from "../api";
import { describeRelativeTime } from "../lib/relative-time";
import { theme } from "../theme/theme";
import {
  HOME_INTAKE_COPY as COPY,
  INTAKE_PREVIEW_LIMIT,
  buildHomeDeliveryRetryPath,
  type IntakePipeline,
  type IntakeRow,
  type IntakeStage,
} from "../product/home-intake";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraSection, ProovraText } from "./index";

function StageTile({ stage }: { stage: IntakeStage }) {
  // Coloured ONLY by count: a zero stage never looks active.
  const tone = stage.count > 0 ? stage.tone : "neutral";
  const palette =
    tone === "danger"
      ? theme.color.status.risk
      : tone === "warn"
        ? theme.color.status.pending
        : tone === "ok"
          ? theme.color.status.verified
          : theme.color.status.neutral;
  return (
    <View
      accessible
      accessibilityLabel={`${stage.label}: ${stage.count}`}
      style={{
        flexBasis: "31%",
        flexGrow: 1,
        minWidth: 0,
        paddingVertical: theme.space.s2,
        paddingHorizontal: theme.space.s2,
        borderRadius: 10,
        backgroundColor: palette.bg,
        borderWidth: 1,
        borderColor: palette.border,
        alignItems: "center",
        gap: 2,
      }}
    >
      <ProovraText variant="h3" weight="bold" color={stage.count > 0 ? palette.fg : theme.color.ink.primary}>{String(stage.count)}</ProovraText>
      <ProovraText variant="label" color={stage.count > 0 ? palette.fg : theme.color.ink.secondary} style={{ textAlign: "center" }}>
        {stage.label}
      </ProovraText>
    </View>
  );
}

function RetryDelivery({ row, teamId, onRetried }: { row: IntakeRow; teamId: string | null; onRetried?: () => void }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "pending" | "done" | "error">("idle");
  const messageId = row.delivery?.messageId;
  if (!messageId) return null;
  if (state === "done") return <ProovraBadge tone="verified" label={COPY.retried} />;
  const retry = async () => {
    if (!teamId || state === "pending") return;
    setState("pending");
    try {
      await apiFetch(buildHomeDeliveryRetryPath(messageId), { method: "POST", body: JSON.stringify({ teamId }) });
      setState("done");
      onRetried?.();
    } catch {
      setState("error");
    }
  };
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s2 }}>
      <ProovraButton
        label={state === "pending" ? COPY.retrying : COPY.retry}
        accessibilityLabel={`${COPY.retry}: ${row.label}`}
        variant="secondary"
        fullWidth={false}
        disabled={state === "pending"}
        onPress={() => void retry()}
      />
      {state === "error" ? (
        <ProovraButton
          label={COPY.openDelivery}
          variant="ghost"
          fullWidth={false}
          onPress={() => router.push({ pathname: "/intake-links", params: { linkId: row.id } })}
        />
      ) : null}
    </View>
  );
}

export function HomeIntakePipelineCard({
  pipeline,
  teamId,
  locked,
  onChanged,
}: {
  /** null = a source did not load. */
  pipeline: IntakePipeline | null;
  teamId: string | null;
  locked: boolean;
  onChanged?: () => void;
}) {
  const router = useRouter();
  let body: React.ReactNode;
  if (locked) {
    body = (
      <View style={{ gap: theme.space.s3 }}>
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{COPY.locked}</ProovraText>
        <ProovraButton label={COPY.seePlans} fullWidth={false} onPress={() => router.push("/billing")} />
      </View>
    );
  } else if (!pipeline) {
    body = <ProovraText variant="bodySm" color={theme.color.ink.muted}>{COPY.unavailable}</ProovraText>;
  } else if (pipeline.empty) {
    body = (
      <View style={{ gap: theme.space.s3 }}>
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{COPY.empty}</ProovraText>
        <ProovraButton label={COPY.create} fullWidth={false} onPress={() => router.push("/intake-link-create")} />
      </View>
    );
  } else {
    body = (
      <View style={{ gap: theme.space.s3 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }} testID="home-intake-stages">
          {pipeline.stages.map((st) => (
            <StageTile key={st.key} stage={st} />
          ))}
        </View>
        {pipeline.links.slice(0, INTAKE_PREVIEW_LIMIT).map((r) => {
          const failed = r.delivery?.failed === true;
          return (
            <View key={r.id} style={{ gap: theme.space.s2, borderTopWidth: 1, borderTopColor: theme.color.border.default, paddingTop: theme.space.s2 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.space.s2 }}>
                <ProovraText variant="bodySm" weight="semibold" numberOfLines={1} style={{ flexShrink: 1 }}>{r.label}</ProovraText>
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  {`${r.usedCount}${r.maxUses != null ? ` / ${r.maxUses}` : ""} used${r.expiresAtUtc ? ` · expires ${describeRelativeTime(r.expiresAtUtc)}` : ""}`}
                </ProovraText>
              </View>
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s2 }}>
                {r.delivery ? (
                  <ProovraBadge
                    tone={failed ? "risk" : r.delivery.statusLabel === "Delivered" ? "verified" : "info"}
                    label={`${r.delivery.channel} · ${r.delivery.statusLabel}${r.delivery.at ? ` · ${describeRelativeTime(r.delivery.at)}` : ""}`}
                  />
                ) : (
                  <ProovraBadge tone="neutral" label={COPY.notSent} />
                )}
                {failed ? (
                  <RetryDelivery row={r} teamId={teamId} onRetried={onChanged} />
                ) : (
                  <ProovraButton
                    label={COPY.open}
                    accessibilityLabel={`Open ${r.label}`}
                    variant="ghost"
                    fullWidth={false}
                    onPress={() => router.push({ pathname: "/intake-links", params: { linkId: r.id } })}
                  />
                )}
              </View>
            </View>
          );
        })}
        {pipeline.links.length > INTAKE_PREVIEW_LIMIT ? (
          <ProovraButton label={COPY.viewAll} variant="ghost" fullWidth={false} onPress={() => router.push("/intake-links")} />
        ) : null}
      </View>
    );
  }
  return (
    <ProovraSection title={COPY.title}>
      <ProovraCard testID="home-intake-pipeline">{body}</ProovraCard>
    </ProovraSection>
  );
}
