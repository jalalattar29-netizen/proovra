/**
 * SEARCH ACTIVITY panel (T-15) — see src/product/search-audit.ts.
 * Touch adaptation: the web's seven-column table becomes one card per search.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Switch, View } from "react-native";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { formatUserDateTime } from "../lib/date";
import { theme } from "../theme/theme";
import { SEARCH_AUDIT_COPY as COPY, buildSearchAuditPath, parseSearchAudit, type SearchAuditRow } from "../product/search-audit";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraSection, ProovraText } from "./index";

type Load = { kind: "loading" } | { kind: "denied"; reason: string } | { kind: "error"; message: string } | { kind: "ready" };

export function SearchActivityPanel({ teamId }: { teamId: string | null }) {
  const [rows, setRows] = useState<SearchAuditRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [withheldOnly, setWithheldOnly] = useState(false);
  const [state, setState] = useState<Load>({ kind: "loading" });
  // A workspace switch between request and response makes it another tenant's log.
  const generation = useRef(0);

  const load = useCallback(
    async (beforeUtc: string | null, append: boolean) => {
      if (!teamId) return;
      const mine = ++generation.current;
      setState({ kind: "loading" });
      try {
        const page = parseSearchAudit(await apiFetch(buildSearchAuditPath(teamId, { failClosedOnly: withheldOnly, beforeUtc })), teamId);
        if (mine !== generation.current) return;
        setRows((prev) => (append ? [...prev, ...page.rows] : page.rows));
        setNext(page.nextBeforeUtc);
        setState({ kind: "ready" });
      } catch (err) {
        if (mine !== generation.current) return;
        const status = (err as { statusCode?: number } | null)?.statusCode;
        if (status === 403 || status === 404) {
          setRows([]);
          setNext(null);
          // A refusal, not a failure: the same request answers the same way, so no retry.
          setState({ kind: "denied", reason: status === 403 ? COPY.denied403 : COPY.denied404 });
          return;
        }
        setState({ kind: "error", message: toSafeUserError(err, { message: COPY.failed }).message });
      }
    },
    [teamId, withheldOnly],
  );
  useEffect(() => {
    void load(null, false);
  }, [load]);

  return (
    <ProovraSection title={COPY.title}>
      <View style={{ gap: theme.space.s3 }} testID="search-activity-panel">
        <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.intro}</ProovraText>
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.s2 }}>
          <Switch value={withheldOnly} onValueChange={setWithheldOnly} accessibilityLabel={COPY.withheldOnly} />
          <ProovraText variant="bodySm">{COPY.withheldOnly}</ProovraText>
        </View>

        {state.kind === "loading" && rows.length === 0 ? <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.loading}</ProovraText> : null}
        {state.kind === "denied" ? <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{state.reason}</ProovraText> : null}
        {state.kind === "error" ? (
          <View style={{ gap: theme.space.s2 }}>
            <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{state.message}</ProovraText>
            <ProovraButton label={COPY.retry} variant="secondary" fullWidth={false} onPress={() => void load(null, false)} />
          </View>
        ) : null}
        {state.kind === "ready" && rows.length === 0 ? (
          <ProovraText variant="bodySm" color={theme.color.ink.muted}>{withheldOnly ? COPY.emptyWithheld : COPY.empty}</ProovraText>
        ) : null}

        {rows.map((r) => (
          <ProovraCard key={r.id}>
            <View style={{ gap: theme.space.s1 }}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: theme.space.s2 }}>
                <ProovraText variant="label" color={theme.color.ink.secondary}>{r.occurredAtUtc ? formatUserDateTime(r.occurredAtUtc) : "—"}</ProovraText>
                <ProovraBadge tone={r.failClosed ? "pending" : "verified"} label={r.failClosed ? COPY.withheldBadge : COPY.completed} />
              </View>
              <ProovraText variant="bodySm">{`Person ${r.actorShort} · ${r.surface}`}</ProovraText>
              <ProovraText variant="label" color={theme.color.ink.muted}>
                {r.queryHash ? `${r.queryHash} · ${r.queryLength} chars` : COPY.noWording}
              </ProovraText>
              <ProovraText variant="label">{`Returned ${r.resultCount} · Withheld ${r.withheld}`}</ProovraText>
            </View>
          </ProovraCard>
        ))}

        {next ? (
          <ProovraButton
            label={state.kind === "loading" ? "Loading…" : COPY.loadMore}
            variant="secondary"
            fullWidth={false}
            disabled={state.kind === "loading"}
            onPress={() => void load(next, true)}
          />
        ) : null}
      </View>
    </ProovraSection>
  );
}
