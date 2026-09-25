/**
 * CASE COPILOT (T-15) — "Evidence Operations Copilot" on the case screen; see
 * src/product/ai-copilot.ts. Eligibility is the SHARED authority
 * (evaluateCopilotEvidenceEligibility) the server also runs before any spend,
 * so an ineligible record cannot be selected and says why.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import {
  COPILOT_SELECTION_MAX,
  buildCopilotIdempotencyKey,
  copilotIneligibilityReason,
  evaluateCopilotEvidenceEligibility,
  evidencePackageVersionLabel,
  type CopilotEligibility,
} from "@proovra/shared";

import { apiFetch } from "../api";
import { theme } from "../theme/theme";
import {
  CASE_COPILOT_COPY as COPY,
  CASE_COPILOT_SECTIONS,
  buildCaseCopilotPath,
  caseCopilotFailure,
  caseEvidenceStatusLabel,
  parseCopilotRun,
  type CaseCopilotEvidence,
  type CopilotOutcome,
} from "../product/ai-copilot";
import { CitationList } from "./evidence-copilot";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraSection, ProovraText } from "./index";

type UiState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string; retryable: boolean }
  | { kind: "result"; outcome: CopilotOutcome };

export function CaseCopilot({
  caseId,
  linkedEvidence,
  onRefreshEvidence,
}: {
  caseId: string;
  linkedEvidence: CaseCopilotEvidence[];
  onRefreshEvidence: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [state, setState] = useState<UiState>({ kind: "idle" });
  const inFlight = useRef(false);

  const evaluated = useMemo(
    () =>
      linkedEvidence.map((e) => ({
        evidence: e,
        verdict: evaluateCopilotEvidenceEligibility({
          status: e.status,
          lifecycleState: e.lifecycleState,
          // Every item in the matter-workspace projection IS this case's linked evidence.
          caseLinked: true,
          analysisRevision: e.analysisRevision,
          analysisRevisionKnown: true,
        }) as CopilotEligibility,
      })),
    [linkedEvidence],
  );
  const eligibleIds = useMemo(() => evaluated.filter((x) => x.verdict.eligible).map((x) => x.evidence.id), [evaluated]);
  // A record that stops being eligible after a refresh leaves the selection.
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => eligibleIds.includes(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [eligibleIds]);

  const chosen = evaluated.filter((x) => selected.has(x.evidence.id) && x.verdict.eligible).map((x) => x.evidence);
  const overLimit = chosen.length > COPILOT_SELECTION_MAX;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const run = async () => {
    if (inFlight.current || chosen.length === 0 || overLimit) return;
    inFlight.current = true;
    setState({ kind: "loading" });
    const ids = chosen.map((e) => e.id);
    const revisions: Record<string, string> = {};
    for (const e of chosen) if (e.analysisRevision !== undefined) revisions[e.id] = e.analysisRevision;
    try {
      const res = await apiFetch(buildCaseCopilotPath(caseId), {
        method: "POST",
        body: JSON.stringify({
          selectedEvidenceIds: ids,
          selectedEvidenceRevisions: revisions,
          processingMode: "METADATA_ONLY",
          idempotencyKey: buildCopilotIdempotencyKey({ scope: "case", scopeId: caseId, selection: ids, revisions, mode: "METADATA_ONLY" }),
        }),
      });
      setState({ kind: "result", outcome: parseCopilotRun(res, CASE_COPILOT_SECTIONS, "caseSummary").outcome });
    } catch (err) {
      const status = (err as { statusCode?: number } | null)?.statusCode;
      const f = caseCopilotFailure(typeof status === "number" ? status : null);
      // The server ran the SAME eligibility authority and disagreed: the list is stale, so re-read it.
      if (f.refresh) onRefreshEvidence();
      setState({ kind: "error", message: f.message, retryable: f.retryable });
    } finally {
      inFlight.current = false;
    }
  };

  const hint = chosen.length === 0 ? COPY.needOne : overLimit ? `Select at most ${COPILOT_SELECTION_MAX} records.` : null;
  const outcome = state.kind === "result" ? state.outcome : null;
  const names = chosen.map((e) => e.title);

  return (
    <ProovraSection title={COPY.title}>
      <ProovraCard testID="case-copilot">
        <View style={{ gap: theme.space.s3 }}>
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{COPY.purpose}</ProovraText>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s1 }}>
            {COPY.disclosures.map((d) => (
              <ProovraBadge key={d} tone={d === "AI-generated" ? "governance" : "neutral"} label={d} />
            ))}
          </View>

          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s2 }}>
            <ProovraText variant="bodySm" weight="semibold">{COPY.selectTitle}</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.muted}>{`${chosen.length} selected`}</ProovraText>
            <ProovraButton label={COPY.selectAll} variant="ghost" fullWidth={false} disabled={eligibleIds.length === 0} onPress={() => setSelected(new Set(eligibleIds))} />
            <ProovraButton label={COPY.clear} variant="ghost" fullWidth={false} disabled={selected.size === 0} onPress={() => setSelected(new Set())} />
          </View>

          {linkedEvidence.length === 0 ? (
            <ProovraText variant="bodySm" color={theme.color.ink.muted}>{COPY.none}</ProovraText>
          ) : (
            evaluated.map(({ evidence: e, verdict }) => {
              const on = selected.has(e.id);
              return (
                <Pressable
                  key={e.id}
                  onPress={() => (verdict.eligible ? toggle(e.id) : undefined)}
                  disabled={!verdict.eligible}
                  accessibilityRole="checkbox"
                  accessibilityLabel={`Select ${e.title}`}
                  accessibilityState={{ checked: on, disabled: !verdict.eligible }}
                  style={{
                    borderWidth: 1,
                    borderRadius: 10,
                    padding: theme.space.s2,
                    borderColor: on ? theme.color.accent.a500 : theme.color.border.default,
                    backgroundColor: on ? theme.color.accent.a050 : theme.color.surface.card,
                    opacity: verdict.eligible ? 1 : 0.7,
                    gap: 2,
                  }}
                >
                  <ProovraText variant="bodySm" weight="semibold" numberOfLines={1}>{`${on ? "☑" : "☐"} ${e.title}`}</ProovraText>
                  <ProovraText variant="label" color={theme.color.ink.secondary}>
                    {`${e.type} · ${caseEvidenceStatusLabel(e.status)} · ${evidencePackageVersionLabel(e.packageVersion)}`}
                  </ProovraText>
                  {!verdict.eligible ? (
                    <ProovraText variant="label" color={theme.color.status.pending.fg}>{copilotIneligibilityReason(verdict.reason)}</ProovraText>
                  ) : null}
                </Pressable>
              );
            })
          )}

          {chosen.length > 0 ? (
            <View style={{ gap: theme.space.s1 }}>
              <ProovraText variant="bodySm" weight="semibold">{COPY.beforeRun}</ProovraText>
              <ProovraText variant="label">
                {`Records: ${chosen.length} selected — ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`}
              </ProovraText>
              {COPY.facts.map(([k, v]) => (
                <ProovraText key={k} variant="label">{`${k}: ${v}`}</ProovraText>
              ))}
            </View>
          ) : null}

          <ProovraButton
            label={state.kind === "loading" ? COPY.running : state.kind === "result" ? COPY.rerun : COPY.run}
            accessibilityLabel={state.kind === "result" ? COPY.rerun : COPY.run}
            disabled={chosen.length === 0 || overLimit || state.kind === "loading"}
            onPress={() => void run()}
          />
          {hint ? <ProovraText variant="label" color={theme.color.ink.muted}>{hint}</ProovraText> : null}
          {state.kind === "loading" ? <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.advisoryHint}</ProovraText> : null}

          {state.kind === "error" ? (
            <View style={{ gap: theme.space.s2 }}>
              <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{state.message}</ProovraText>
              {state.retryable ? <ProovraButton label={COPY.retry} variant="secondary" fullWidth={false} onPress={() => void run()} /> : null}
            </View>
          ) : null}
          {outcome?.kind === "provider_unavailable" ? <ProovraText variant="bodySm">{COPY.providerUnavailable}</ProovraText> : null}
          {outcome?.kind === "policy_denied" ? <ProovraText variant="bodySm">{COPY.policyDenied}</ProovraText> : null}
          {outcome?.kind === "no_selection" ? <ProovraText variant="bodySm">{COPY.noSelection}</ProovraText> : null}
          {outcome?.kind === "schema_error" ? <ProovraText variant="bodySm" color={theme.color.status.pending.fg}>{COPY.schemaError}</ProovraText> : null}
          {outcome?.kind === "blocked" ? <ProovraText variant="bodySm" color={theme.color.status.pending.fg}>{COPY.blocked}</ProovraText> : null}
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
              {outcome.advisoryBoundary ? <ProovraText variant="label" color={theme.color.ink.muted}>{outcome.advisoryBoundary}</ProovraText> : null}
            </View>
          ) : null}
        </View>
      </ProovraCard>
    </ProovraSection>
  );
}
