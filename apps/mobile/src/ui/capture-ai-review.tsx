/**
 * CAPTURE AI REVIEW (T-15) — see src/product/capture-ai-review.ts.
 * Touch adaptation: the web's portal modal is a bottom sheet; the collapsible
 * card and its four context tiles are kept.
 */
import React, { useState } from "react";
import { Pressable, View } from "react-native";

import { apiFetch } from "../api";
import { theme } from "../theme/theme";
import type { CollectionPlanTemplate } from "../product/capture-plan";
import {
  CAPTURE_AI_COPY as COPY,
  CAPTURE_ANALYZE_SESSION_PATH,
  analyzeFailure,
  buildAnalyzeSessionBody,
  buildReviewModel,
  parseAiResult,
  reviewButtonLabel,
  type AiResult,
  type ReviewItem,
} from "../product/capture-ai-review";
import { ProovraButton, ProovraCard, ProovraText } from "./index";
import { ProovraSheet } from "./patterns";

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <View style={{ flexBasis: "47%", flexGrow: 1, borderWidth: 1, borderColor: theme.color.border.default, borderRadius: 10, padding: theme.space.s2, gap: 2 }}>
      <ProovraText variant="label" color={theme.color.ink.muted}>{label}</ProovraText>
      <ProovraText variant="bodySm" weight="semibold">{value}</ProovraText>
      <ProovraText variant="label" color={theme.color.ink.secondary}>{sub}</ProovraText>
    </View>
  );
}
function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <View style={{ gap: theme.space.s1 }}>
      <ProovraText variant="bodySm" weight="semibold">{title}</ProovraText>
      {items.map((t, i) => (
        <ProovraText key={i} variant="bodySm">{`• ${t}`}</ProovraText>
      ))}
    </View>
  );
}

export function CaptureAiReview({
  plan,
  useLocation,
  items,
  planMode = "FLEXIBLE",
  recommended = false,
}: {
  plan: CollectionPlanTemplate | null;
  useLocation: boolean;
  items: ReviewItem[];
  planMode?: "FLEXIBLE" | "CHECKLIST_REQUIRED";
  /** Web `sessionReadiness.aiRecommendedReview` — any readiness warning. */
  recommended?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [analysis, setAnalysis] = useState<AiResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const model = buildReviewModel(plan, useLocation, items, analysis);
  const canAnalyze = items.length > 0 && !!plan;

  const analyze = async () => {
    if (!plan) return;
    setLoading(true);
    setError(null);
    setUnavailable(false);
    try {
      setAnalysis(parseAiResult(await apiFetch(CAPTURE_ANALYZE_SESSION_PATH, { method: "POST", body: JSON.stringify(buildAnalyzeSessionBody(plan, useLocation, items, planMode)) })));
    } catch (err) {
      const f = analyzeFailure(err);
      setUnavailable(f.unavailable);
      setError(f.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={{ gap: theme.space.s2 }} testID="capture-ai-review">
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.space.s2 }}>
        <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>{COPY.advisoryTitle}</ProovraText>
        <ProovraText variant="label" weight="semibold" color={recommended ? theme.color.status.pending.fg : theme.color.ink.muted}>
          {recommended ? "Recommended before finalization" : "Optional metadata review"}
        </ProovraText>
      </View>
      <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.advisory}</ProovraText>
      <ProovraCard>
        <Pressable
          onPress={() => setOpen((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={COPY.title}
          accessibilityState={{ expanded: open }}
          style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
        >
          <ProovraText variant="bodySm" weight="semibold">{COPY.title}</ProovraText>
          <ProovraText variant="label" weight="semibold" color={theme.color.accent.a600}>{open ? "Hide" : model.qaIssues > 0 ? String(model.qaIssues) : "Open"}</ProovraText>
        </Pressable>
        {open ? (
          <View style={{ gap: theme.space.s3, marginTop: theme.space.s3 }}>
            <View style={{ gap: 2 }}>
              <ProovraText variant="bodySm" weight="semibold">{model.state.label}</ProovraText>
              <ProovraText variant="label" color={theme.color.ink.secondary}>{model.state.detail}</ProovraText>
              <ProovraText variant="label" color={theme.color.ink.muted}>{analysis ? "Analyzed" : "Pre-check"}</ProovraText>
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
              <Tile label="Workflow" value={plan?.name ?? "No plan selected"} sub={planMode === "CHECKLIST_REQUIRED" ? "Checklist required" : "Flexible intake"} />
              <Tile label="Coverage" value={`${model.requiredDone}/${model.requiredTotal}`} sub={`${model.coveragePercent}% required coverage`} />
              <Tile label="Materials" value={String(items.length)} sub={`${model.locationItems} with location signal`} />
              <Tile label="Signals" value={String(model.signalIssues)} sub={`${analysis?.flags.length ?? 0} AI flag(s)`} />
            </View>
            {error ? <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{error}</ProovraText> : null}
            {unavailable ? <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{COPY.unavailable}</ProovraText> : null}
            <View style={{ gap: theme.space.s1 }}>
              <ProovraText variant="bodySm" weight="semibold">{COPY.gateTitle}</ProovraText>
              <ProovraText variant="label" color={theme.color.ink.secondary}>{COPY.gateBody}</ProovraText>
            </View>
            <ProovraButton
              label={reviewButtonLabel(loading, canAnalyze, model.qaIssues)}
              accessibilityLabel="Run AI QA review"
              fullWidth={false}
              disabled={!canAnalyze || loading}
              onPress={() => {
                setSheet(true);
                if (!analysis) void analyze();
              }}
            />
          </View>
        ) : null}
      </ProovraCard>

      <ProovraSheet visible={sheet} title={COPY.sheetTitle} onClose={() => setSheet(false)}>
        <View style={{ gap: theme.space.s3 }} testID="capture-ai-review-sheet">
          <ProovraText variant="label" color={theme.color.ink.secondary}>{COPY.sheetIntro}</ProovraText>
          {loading ? (
            <View style={{ gap: theme.space.s1 }}>
              <ProovraText variant="bodySm" weight="semibold">{COPY.reviewing}</ProovraText>
              <ProovraText variant="label">{COPY.reviewingBody}</ProovraText>
            </View>
          ) : error ? (
            <View style={{ gap: theme.space.s1 }}>
              <ProovraText variant="bodySm" weight="semibold">{COPY.aiUnavailable}</ProovraText>
              <ProovraText variant="bodySm">{error}</ProovraText>
            </View>
          ) : (
            <>
              <ProovraText variant="bodySm">{`Current QA state: ${model.state.label} · Required coverage: ${model.coveragePercent}% · Workflow signals: ${model.qaIssues}`}</ProovraText>
              <View style={{ gap: 2 }}>
                <ProovraText variant="label">{`Coverage gate — ${model.coverage[0]}`}</ProovraText>
                <ProovraText variant="label">{`Risk signals — ${model.risks.length} workflow note(s).`}</ProovraText>
                <ProovraText variant="label">{`Metadata review — ${analysis?.flags.length ?? 0} metadata flag(s).`}</ProovraText>
                <ProovraText variant="label">{`Human gate — ${COPY.humanGate}`}</ProovraText>
              </View>
              <List title="Coverage requirements" items={model.coverage} />
              <List title="Risk signals" items={model.risks} />
              <List title="Metadata review" items={(analysis?.flags ?? []).map((f) => `[${f.severity}] ${f.title}: ${f.detail}`)} />
              <ProovraText variant="bodySm" weight="semibold">Workflow next actions</ProovraText>
              <List title="Resolve before final review" items={model.groups.high} />
              <List title="Recommended QA check" items={model.groups.recommended} />
              <List title="Informational" items={model.groups.info} />
              <View style={{ gap: theme.space.s1 }}>
                <ProovraText variant="bodySm" weight="semibold">{COPY.legalTitle}</ProovraText>
                <ProovraText variant="label">{analysis?.legalDisclaimer ?? COPY.legalFallback}</ProovraText>
              </View>
              <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.notSaved}</ProovraText>
            </>
          )}
        </View>
      </ProovraSheet>
    </View>
  );
}
