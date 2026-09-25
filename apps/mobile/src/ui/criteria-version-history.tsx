/**
 * CRITERIA VERSION HISTORY (T-12 / RC-13) — the native port of the web's
 * `VersionHistory` (settings/reviewer-criteria/page.tsx:158-254).
 *
 * Every version with its criteria, its per-version Copilot usage, and a
 * from/to COMPARE computed by the same key-based diff the web uses. Native
 * previously showed only a usage count per version: which criteria a version
 * held, and what changed between two versions, could not be read at all.
 *
 * Usage is additive, exactly as on the web — a failed usage read leaves the
 * history intact; a failed history read is said, not hidden.
 * Touch adaptation: the two `<select>`s become two rows of version chips.
 */
import React, { useEffect, useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { formatUserDate } from "../lib/date";
import { theme } from "../theme/theme";
import {
  buildCriteriaSetPath,
  buildCriteriaUsagePath,
  diffCriteria,
  parseCriteriaUsage,
  parseCriteriaVersionHistory,
  versionUsageLine,
  type CriteriaUsage,
  type HistoryVersion,
} from "../product/reviewer-criteria";
import { ProovraBadge, ProovraText } from "./index";
import { ProovraFilterChips } from "./patterns";

type Load = { phase: "loading" } | { phase: "failed" } | { phase: "ready"; versions: HistoryVersion[] };

export function CriteriaVersionHistory({ teamId, setId }: { teamId: string; setId: string }) {
  const [state, setState] = useState<Load>({ phase: "loading" });
  const [usage, setUsage] = useState<CriteriaUsage[] | null>(null);
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const versions = parseCriteriaVersionHistory(await apiFetch(buildCriteriaSetPath(setId, teamId)));
        if (!cancelled) setState({ phase: "ready", versions });
      } catch {
        if (!cancelled) setState({ phase: "failed" });
      }
      try {
        const u = await apiFetch(buildCriteriaUsagePath(setId, teamId));
        if (!cancelled && (u as { usageAvailable?: boolean }).usageAvailable !== false) setUsage(parseCriteriaUsage(u));
      } catch {
        /* usage is additive — history still renders without it */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamId, setId]);

  if (state.phase === "failed") {
    return (
      <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>
        Version history is unavailable.
      </ProovraText>
    );
  }
  if (state.phase === "loading") {
    return (
      <ProovraText variant="label" color={theme.color.ink.muted}>
        Loading history…
      </ProovraText>
    );
  }

  const { versions } = state;
  const byNumber = (n: string) => versions.find((v) => String(v.version) === n) ?? null;
  const vA = byNumber(from);
  const vB = byNumber(to);
  const options = versions.map((v) => ({ value: String(v.version), label: `v${v.version}` }));

  return (
    <View style={{ gap: theme.space.s3 }} testID={`criteria-history-${setId}`}>
      {versions.length > 1 ? (
        <>
          <ProovraFilterChips label="Compare from version" options={options} value={from} onChange={setFrom} />
          <ProovraFilterChips label="Compare to version" options={options} value={to} onChange={setTo} />
        </>
      ) : null}
      {vA && vB && vA.id !== vB.id ? (
        <View
          style={{ gap: theme.space.s1, padding: theme.space.s3, borderRadius: theme.radius.md, backgroundColor: theme.color.surface.muted }}
          testID="criteria-compare"
        >
          <ProovraText variant="bodySm" weight="semibold">{`v${vA.version} → v${vB.version}`}</ProovraText>
          {vA.title !== vB.title ? (
            <ProovraText variant="label">{`Title: “${vA.title}” → “${vB.title}”`}</ProovraText>
          ) : null}
          {diffCriteria(vA.criteria, vB.criteria).map((line, i) => (
            <ProovraText key={i} variant="label">{`• ${line}`}</ProovraText>
          ))}
        </View>
      ) : null}
      {versions.map((v) => {
        const usageLine = versionUsageLine(usage?.find((u) => u.version === v.version) ?? null, formatUserDate);
        return (
          <View key={v.id} style={{ gap: theme.space.s1 }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s2 }}>
              <ProovraText variant="bodySm" weight="semibold">{`v${v.version} — ${v.title}`}</ProovraText>
              <ProovraBadge
                tone={v.publishedAtIso ? "verified" : "neutral"}
                label={v.publishedAtIso ? `published ${formatUserDate(v.publishedAtIso)} · immutable` : "draft"}
              />
            </View>
            {v.createdAtIso ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>{`created ${formatUserDate(v.createdAtIso)}`}</ProovraText>
            ) : null}
            {usageLine ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>{usageLine}</ProovraText>
            ) : null}
            {v.criteria.map((c) => (
              <ProovraText key={c.key} variant="label" color={theme.color.ink.secondary}>
                {`• ${c.title}${c.required ? " (required)" : ""}`}
              </ProovraText>
            ))}
          </View>
        );
      })}
    </View>
  );
}
