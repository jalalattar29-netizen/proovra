/**
 * DURABLE PROGRESS (native) — one report/package request as the database
 * records it, projected by the SHARED `projectOutputProgress` (same steps as the
 * web). Nothing advances on a device timer; a reload, a reconnect or another
 * member sees the same step. A failure names the step, the typed error and the
 * request id as the support reference.
 */
import React from "react";
import { View } from "react-native";

import { outputOperationErrorForTerminal } from "@proovra/shared";

import type { NativeActiveRequest } from "../product/evidence-record";
import { theme } from "../theme/theme";
import { ProovraCard, ProovraText } from "./index";

const MARK: Record<string, string> = { done: "✓", current: "●", pending: "○", failed: "✕", skipped: "–" };

export function OutputProgressCard({ request, action }: { request: NativeActiveRequest; action?: React.ReactNode }) {
  const { progress } = request;
  const failed = progress.outcome === "FAILED" || progress.outcome === "BLOCKED";
  const v = request.targetVersion != null ? ` v${request.targetVersion}` : "";
  const packageOnly = request.artifactType === "VERIFICATION_PACKAGE";
  const title =
    progress.outcome === "SUCCEEDED"
      ? packageOnly
        ? `Verification package${v} is ready`
        : `Report${v} and verification package${v} are ready`
      : failed
        ? packageOnly
          ? `Recovering verification package${v} stopped`
          : `Generating report${v} stopped`
        : packageOnly
          ? `Recovering verification package${v}`
          : `Generating report${v}`;
  const current = progress.steps.find((s) => s.key === progress.currentStep)?.label ?? "";
  const error = failed
    ? outputOperationErrorForTerminal({ terminalReasonCode: request.terminalReasonCode, failedStep: progress.currentStep })
    : null;
  return (
    <ProovraCard testID="output-progress">
      <View style={{ gap: theme.space.s2 }}>
        <ProovraText variant="bodySm" weight="semibold">{title}</ProovraText>
        <View accessibilityLiveRegion="polite">
          <ProovraText variant="label" color={theme.color.ink.secondary} testID="output-progress-live">
            {progress.outcome === "SUCCEEDED" ? "Complete." : failed ? `Stopped at: ${current}.` : `${current}…`}
          </ProovraText>
        </View>
        <View style={{ gap: 2 }} accessibilityRole="list">
          {progress.steps.map((s) => (
            <ProovraText
              key={s.key}
              variant="label"
              color={s.status === "failed" ? theme.color.status.risk.fg : s.status === "pending" || s.status === "skipped" ? theme.color.ink.muted : theme.color.ink.secondary}
              weight={s.status === "current" || s.status === "failed" ? "semibold" : undefined}
              accessibilityLabel={`${s.label}: ${s.status}`}
              testID={`output-progress-step-${s.key}`}
            >
              {`${MARK[s.status] ?? ""} ${s.label}`}
            </ProovraText>
          ))}
        </View>
        {error ? (
          <View style={{ gap: 2 }} testID="output-progress-error">
            <ProovraText variant="bodySm" weight="semibold" color={theme.color.status.risk.fg}>{error.title}</ProovraText>
            <ProovraText variant="label">{error.description}</ProovraText>
            {action}
          </View>
        ) : null}
        {failed ? (
          <ProovraText variant="label" color={theme.color.ink.muted} selectable testID="output-progress-ref">
            {`Support reference: ${request.requestId}`}
          </ProovraText>
        ) : null}
      </View>
    </ProovraCard>
  );
}
