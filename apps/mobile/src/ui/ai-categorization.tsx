/**
 * AI CATEGORIZATION (T-14) — the touch port of the web AiCategorizationPanel:
 * collapsed until opened (the read happens on open), the advisory boundary
 * first, then the server's record. Run / Re-run call the server; its cost and
 * policy refusals are shown in the safe words, never retried silently.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { formatUserDateTime } from "../lib/date";
import {
  AI_CATEGORIZATION_COPY as C,
  buildAiCategorizationPath,
  buildAiCategorizationRunPath,
  canRunCategorization,
  parseAiCategorization,
  type AiCategorization,
} from "../product/ai-categorization";
import { theme } from "../theme/theme";
import { ProovraButton, ProovraCard, ProovraText } from "./index";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 2 }}>
      <ProovraText variant="label" weight="semibold">{label}</ProovraText>
      {children}
    </View>
  );
}

export function AiCategorizationPanel({ evidenceId }: { evidenceId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AiCategorization | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch(buildAiCategorizationPath(evidenceId))
      .then((d) => {
        if (!cancelled) setData(parseAiCategorization(d));
      })
      .catch((err) => {
        if (!cancelled) setError(toSafeUserError(err, { message: C.unavailable }).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [evidenceId, open]);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      setData(parseAiCategorization(await apiFetch(buildAiCategorizationRunPath(evidenceId), { method: "POST" })));
    } catch (err) {
      setError(toSafeUserError(err, { message: C.failed }).message);
    } finally {
      setRunning(false);
    }
  }, [evidenceId]);

  return (
    <View testID="ai-categorization" style={{ gap: theme.space.s2 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={C.title}
        onPress={() => setOpen((v) => !v)}
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <ProovraText variant="bodySm" weight="semibold" color={theme.color.ink.secondary}>{`${C.title} ${open ? "▴" : "▾"}`}</ProovraText>
      </Pressable>
      {open ? (
        <ProovraCard>
          <View style={{ gap: theme.space.s2 }}>
            <ProovraText variant="label" color={theme.color.ink.muted}>{C.advisory}</ProovraText>
            {loading ? <ProovraText variant="label" color={theme.color.ink.muted}>{C.loading}</ProovraText> : null}
            {error ? <ProovraText variant="label" color={theme.color.status.risk.fg}>{error}</ProovraText> : null}
            {!loading && data?.status === "DISABLED" ? (
              <ProovraText variant="bodySm" weight="semibold">{C.disabled}</ProovraText>
            ) : null}
            {!loading && canRunCategorization(data) ? (
              <ProovraButton label={running ? C.running : C.run} variant="secondary" disabled={running} onPress={() => void run()} />
            ) : null}
            {data && data.status === "COMPLETED" ? (
              <View style={{ gap: theme.space.s2 }} testID="ai-categorization-result">
                <ProovraButton label={running ? C.rerunning : C.rerun} variant="ghost" fullWidth={false} disabled={running} onPress={() => void run()} />
                <Field label={C.summary}>
                  <ProovraText variant="label" color={theme.color.ink.secondary}>{data.summary ?? C.noSummary}</ProovraText>
                </Field>
                <Field label={C.categories}>
                  <ProovraText variant="label" color={theme.color.ink.secondary}>{data.categories.length ? data.categories.join(", ") : C.noCategories}</ProovraText>
                </Field>
                <Field label={C.tags}>
                  <ProovraText variant="label" color={theme.color.ink.secondary}>{data.suggestedTags.length ? data.suggestedTags.join(", ") : C.noTags}</ProovraText>
                </Field>
                <Field label={C.risk}>
                  {data.riskFlags.length ? (
                    data.riskFlags.map((f, i) => (
                      <View key={`${f.title}-${i}`}>
                        <ProovraText variant="label" weight="semibold">{f.title}</ProovraText>
                        {f.detail ? <ProovraText variant="label" color={theme.color.ink.secondary}>{f.detail}</ProovraText> : null}
                      </View>
                    ))
                  ) : (
                    <ProovraText variant="label" color={theme.color.ink.secondary}>{C.noRisk}</ProovraText>
                  )}
                </Field>
                <Field label={C.model}>
                  {/* The web prints the raw ISO string; a date the reader can read is the adaptation. */}
                  <ProovraText variant="label" color={theme.color.ink.secondary}>
                    {`${data.model ?? C.noModel} • ${data.updatedAtIso ? formatUserDateTime(data.updatedAtIso) : C.noTime}`}
                  </ProovraText>
                </Field>
              </View>
            ) : null}
          </View>
        </ProovraCard>
      ) : null}
    </View>
  );
}
