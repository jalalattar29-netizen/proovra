/**
 * EVIDENCE COPILOT (T-15) — see src/product/ai-copilot.ts. Top of the evidence
 * Review tab, as on the web (EvidenceReviewTab.tsx:150).
 */
import React, { useState } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { buildCopilotIdempotencyKey } from "@proovra/shared";

import { apiFetch } from "../api";
import { theme } from "../theme/theme";
import {
  EVIDENCE_COPILOT_COPY as COPY,
  EVIDENCE_COPILOT_SECTIONS,
  buildEvidenceCopilotPath,
  copilotFailure,
  generationOffer,
  parseCopilotRun,
  regenerateFailure,
  type CopilotCitation,
  type CopilotOutcome,
  type ServerAction,
} from "../product/ai-copilot";
import { buildRegeneratePath, readGenerationOutcome } from "../product/evidence-detail";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraSection, ProovraText } from "./index";

type UiState = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string; code: string } | { kind: "result"; outcome: CopilotOutcome; actions: ServerAction[] };

export function CitationList({ citations }: { citations: CopilotCitation[] }) {
  const router = useRouter();
  if (citations.length === 0) return <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.noSources}</ProovraText>;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s1 }}>
      {citations.map((c, i) => {
        const chip = <ProovraBadge tone="neutral" label={`${c.typeLabel} · ${c.label}`} />;
        return c.nativeRoute ? (
          <Pressable key={i} onPress={() => router.push(c.nativeRoute as string)} accessibilityRole="link" accessibilityLabel={`View ${c.typeLabel} source: ${c.label}`}>
            {chip}
          </Pressable>
        ) : (
          // A source native has no screen for (or no longer available) is shown, never linked.
          <View key={i} accessible accessibilityLabel={`${c.typeLabel} source: ${c.label}`}>
            {chip}
          </View>
        );
      })}
    </View>
  );
}

/**
 * Only the report-generation offer is ported: OPEN_MISSING_METADATA links back
 * to this same record, and OPEN_REVIEWER_ASSIGNMENT to the web /review queue,
 * which native does not have — a button to a missing screen is worse than none.
 */
function ConfirmedActions({ evidenceId, actions }: { evidenceId: string; actions: ServerAction[] }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const offer = generationOffer(actions);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // 202 answers every outcome; the typed outcome is what happened.
      setOutcome(readGenerationOutcome(await apiFetch(buildRegeneratePath(evidenceId), { method: "POST" })).message);
    } catch (err) {
      setOutcome(regenerateFailure((err as { statusCode?: number } | null)?.statusCode ?? null));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  if (!offer) return null;
  return (
    <View style={{ gap: theme.space.s2 }}>
      <ProovraText variant="bodySm" weight="semibold">{COPY.actionsTitle}</ProovraText>
      <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.actionsIntro}</ProovraText>
      {!confirming ? (
        <ProovraButton label={offer.displayLabel} variant="secondary" fullWidth={false} disabled={busy} onPress={() => setConfirming(true)} />
      ) : (
        <ProovraCard>
          <View style={{ gap: theme.space.s2 }}>
            <ProovraText variant="bodySm">{COPY.confirmBody}</ProovraText>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
              <ProovraButton label={busy ? COPY.queuing : COPY.confirm} accessibilityLabel={COPY.confirm} fullWidth={false} disabled={busy} onPress={() => void run()} />
              <ProovraButton label={COPY.cancel} variant="ghost" fullWidth={false} disabled={busy} onPress={() => setConfirming(false)} />
            </View>
          </View>
        </ProovraCard>
      )}
      {outcome ? <ProovraText variant="bodySm">{outcome}</ProovraText> : null}
    </View>
  );
}

export function EvidenceCopilot({ evidenceId, analysisRevision }: { evidenceId: string; analysisRevision: string | null }) {
  const [state, setState] = useState<UiState>({ kind: "idle" });

  const run = async () => {
    // FAIL CLOSED: without the server revision there is nothing to compare, so nothing is sent.
    if (state.kind === "loading" || !analysisRevision) return;
    setState({ kind: "loading" });
    try {
      const res = await apiFetch(buildEvidenceCopilotPath(evidenceId), {
        method: "POST",
        body: JSON.stringify({
          evidenceRevision: analysisRevision,
          processingMode: "METADATA_ONLY",
          idempotencyKey: buildCopilotIdempotencyKey({
            scope: "evidence",
            scopeId: evidenceId,
            selection: [evidenceId],
            revisions: { [evidenceId]: analysisRevision },
            mode: "METADATA_ONLY",
          }),
        }),
      });
      const parsed = parseCopilotRun(res, EVIDENCE_COPILOT_SECTIONS, "operationalSummary");
      setState({ kind: "result", outcome: parsed.outcome, actions: parsed.serverActions });
    } catch (err) {
      const e = err as { statusCode?: number; code?: string } | null;
      const status = typeof e?.statusCode === "number" ? e.statusCode : null;
      setState({ kind: "error", message: copilotFailure(status, "evidence"), code: e?.code ?? (status ? String(status) : "NETWORK") });
    }
  };

  const outcome = state.kind === "result" ? state.outcome : null;
  return (
    <ProovraSection title={COPY.title}>
      <ProovraCard testID="evidence-copilot">
        <View style={{ gap: theme.space.s3 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s1 }}>
            {COPY.chips.map((c) => (
              <ProovraBadge key={c} tone={c === "AI-generated" ? "governance" : "neutral"} label={c} />
            ))}
          </View>
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{COPY.intro}</ProovraText>
          {!analysisRevision ? <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.noRevision}</ProovraText> : null}
          <ProovraButton
            label={state.kind === "loading" ? COPY.running : state.kind === "result" ? COPY.rerun : COPY.run}
            accessibilityLabel={state.kind === "result" ? COPY.rerun : COPY.run}
            fullWidth={false}
            disabled={state.kind === "loading" || !analysisRevision}
            onPress={() => void run()}
          />

          {state.kind === "error" ? (
            <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{`${state.message} (${state.code})`}</ProovraText>
          ) : null}

          {outcome?.kind === "provider_unavailable" ? <ProovraText variant="bodySm">{COPY.providerUnavailable}</ProovraText> : null}
          {outcome?.kind === "policy_denied" ? <ProovraText variant="bodySm">{`Evidence AI is disabled for this workspace (${outcome.decision}).`}</ProovraText> : null}
          {outcome?.kind === "blocked" ? <ProovraText variant="bodySm" color={theme.color.status.pending.fg}>{COPY.blocked}</ProovraText> : null}
          {outcome?.kind === "schema_error" ? (
            <View style={{ gap: theme.space.s2 }}>
              <ProovraText variant="bodySm" color={theme.color.status.pending.fg}>{COPY.schemaError}</ProovraText>
              <ProovraButton label={COPY.tryAgain} variant="secondary" fullWidth={false} onPress={() => void run()} />
            </View>
          ) : null}

          {outcome?.kind === "result" ? (
            <View style={{ gap: theme.space.s3 }}>
              <View style={{ gap: theme.space.s1 }}>
                <ProovraText variant="bodySm" weight="semibold">{COPY.summary}</ProovraText>
                <ProovraText variant="bodySm">{outcome.summary}</ProovraText>
              </View>
              {outcome.sections.map((sec) => (
                <View key={sec.label} style={{ gap: theme.space.s1 }}>
                  <ProovraText variant="bodySm" weight="semibold">{sec.label}</ProovraText>
                  {sec.items.map((item, i) => (
                    <ProovraText key={i} variant="bodySm">{`• ${item}`}</ProovraText>
                  ))}
                </View>
              ))}
              <View style={{ gap: theme.space.s1 }}>
                <ProovraText variant="bodySm" weight="semibold">{COPY.sources}</ProovraText>
                <CitationList citations={outcome.citations} />
                {outcome.droppedCitations > 0 ? (
                  <ProovraText variant="label" color={theme.color.ink.muted}>{`${outcome.droppedCitations} unverifiable citation(s) were removed.`}</ProovraText>
                ) : null}
              </View>
              {state.kind === "result" ? <ConfirmedActions evidenceId={evidenceId} actions={state.actions} /> : null}
              {outcome.advisoryBoundary ? <ProovraText variant="label" color={theme.color.ink.muted}>{outcome.advisoryBoundary}</ProovraText> : null}
            </View>
          ) : null}
        </View>
      </ProovraCard>
    </ProovraSection>
  );
}
