/**
 * PROVENANCE CHAIN SECTION (T-15) — see src/product/provenance.ts. Rendered at
 * the top of the evidence Integrity tab, where the web renders it. Re-reads
 * when the active workspace changes and drops an answer that arrives after a
 * switch (a projection for another workspace is never shown).
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { formatUserDateTime } from "../lib/date";
import { theme } from "../theme/theme";
import {
  PROVENANCE_COPY as COPY,
  buildProvenancePath,
  parseProvenanceChain,
  provenanceCaptureRows,
  provenanceLimitationText,
  provenancePreservationRows,
  type ProvenanceView,
} from "../product/provenance";
import { ProovraButton, ProovraCard, ProovraSection, ProovraText } from "./index";
import { ProovraDetailRows } from "./patterns";

type Load = { kind: "loading" } | { kind: "denied"; message: string } | { kind: "error"; message: string } | { kind: "ready"; chain: ProvenanceView };

export function ProvenanceChainSection({ evidenceId, workspaceId }: { evidenceId: string; workspaceId: string | null }) {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    setState({ kind: "loading" });
    try {
      const chain = parseProvenanceChain(await apiFetch(buildProvenancePath(evidenceId)), evidenceId);
      if (mine !== generation.current) return;
      setState(chain ? { kind: "ready", chain } : { kind: "denied", message: COPY.notAvailable });
    } catch (err) {
      if (mine !== generation.current) return;
      const status = (err as { statusCode?: number } | null)?.statusCode;
      if (status === 403 || status === 404) {
        setState({ kind: "denied", message: status === 403 ? COPY.personalDenied : COPY.notAvailable });
        return;
      }
      setState({ kind: "error", message: toSafeUserError(err, { message: COPY.failed }).message });
    }
  }, [evidenceId]);

  useEffect(() => {
    void load();
  }, [load, workspaceId]);

  const fmt = (iso: string) => formatUserDateTime(iso);

  return (
    <ProovraSection title={COPY.title}>
      <ProovraCard>
        <View style={{ gap: theme.space.s2 }} testID={`provenance-${state.kind}`}>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.muted}>{COPY.kicker}</ProovraText>
          {state.kind === "loading" ? (
            <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.loading}</ProovraText>
          ) : state.kind === "denied" ? (
            <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{state.message}</ProovraText>
          ) : state.kind === "error" ? (
            <>
              <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{state.message}</ProovraText>
              <ProovraButton label="Try again" variant="secondary" fullWidth={false} onPress={() => void load()} />
            </>
          ) : (
            <>
              <ProovraDetailRows rows={provenanceCaptureRows(state.chain, fmt)} />
              <ProovraText variant="bodySm" weight="semibold">{COPY.preservation}</ProovraText>
              <ProovraDetailRows rows={provenancePreservationRows(state.chain, fmt)} />
              <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.custodyNote}</ProovraText>
              {state.chain.derivations.length > 0 ? (
                <>
                  <ProovraText variant="bodySm" weight="semibold">{COPY.derived}</ProovraText>
                  {state.chain.derivations.map((d) => (
                    <ProovraText key={`${d.derivedEvidenceId}:${d.derivedAtUtc}`} variant="label" color={theme.color.ink.secondary}>
                      {`${d.derivedEvidenceId.slice(0, 8)}… · ${d.transformLabel || "derived copy"} · ${fmt(d.derivedAtUtc)}`}
                    </ProovraText>
                  ))}
                </>
              ) : null}
              <ProovraText variant="bodySm" weight="semibold">{COPY.limits}</ProovraText>
              {state.chain.limitations.map((code) => (
                <ProovraText key={code} variant="label" color={theme.color.ink.muted}>{`• ${provenanceLimitationText(code)}`}</ProovraText>
              ))}
            </>
          )}
        </View>
      </ProovraCard>
    </ProovraSection>
  );
}
