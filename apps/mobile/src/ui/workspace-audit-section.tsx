/**
 * WORKSPACE AUDIT HISTORY (T-12 / RC-13) — the native port of the web's
 * workspace-admin Audit tab. See src/product/workspace-audit.ts for the
 * contract. Touch adaptations: the outcome `<select>` becomes outcome chips;
 * the table becomes rows (action · UTC time · resource, outcome badge); the
 * JSON file download becomes the share sheet carrying the same JSON.
 */
import React, { useCallback, useEffect, useState } from "react";
import * as FileSystem from "expo-file-system";
import { shareFile } from "../lib/share-file";
import { View } from "react-native";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { theme } from "../theme/theme";
import {
  AUDIT_OUTCOME_OPTIONS,
  WORKSPACE_AUDIT_COPY,
  auditOutcomeTone,
  auditResourceLabel,
  buildTenantAuditPath,
  parseTenantAuditPage,
  type AuditOutcomeFilter,
  type AuditRow,
} from "../product/workspace-audit";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraInput, ProovraListRow, ProovraText } from "./index";
import { ProovraFilterChips, ProovraPageSection } from "./patterns";

/**
 * A 403/404 is ONE fixed sentence: the server's own denial text is not shown,
 * so the answer never distinguishes no-such-workspace, not-yours and
 * no-capability. Other failures use the safe-error projection.
 */
function auditDenialMessage(err: unknown, generic: string): string {
  const status = (err as { statusCode?: number } | null)?.statusCode;
  if (status === 403 || status === 404) return generic;
  return toSafeUserError(err, { message: generic }).message;
}

export function WorkspaceAuditSection({ teamId }: { teamId: string }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<AuditOutcomeFilter>("");
  const [action, setAction] = useState("");
  const [appliedAction, setAppliedAction] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Typing is debounced into the applied filter so each keystroke is not a
  // server query; the filter itself still runs only on the server.
  useEffect(() => {
    const h = setTimeout(() => setAppliedAction(action), 400);
    return () => clearTimeout(h);
  }, [action]);

  const load = useCallback(
    async (cursor: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const page = parseTenantAuditPage(
          await apiFetch(buildTenantAuditPath(teamId, { action: appliedAction, outcome, cursorId: cursor })),
        );
        setRows((prev) => (cursor ? [...prev, ...page.items] : page.items));
        setNextCursor(page.nextCursorId);
      } catch (err) {
        // One generic denial — never distinguishes "no such workspace" from
        // "not yours" from "no capability".
        setRows([]);
        setNextCursor(null);
        setError(auditDenialMessage(err, WORKSPACE_AUDIT_COPY.unavailable));
      } finally {
        setLoading(false);
      }
    },
    [teamId, appliedAction, outcome],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const exportAudit = useCallback(async () => {
    try {
      // SAME endpoint, SAME authorization, SAME filters — export=true only.
      const page = parseTenantAuditPage(
        await apiFetch(buildTenantAuditPath(teamId, { action: appliedAction, outcome, exportAll: true })),
      );
      // The web downloads a JSON FILE; the phone shares one (not the JSON pasted as text).
      const filename = `workspace-audit-${teamId}.json`;
      if (!FileSystem.cacheDirectory) throw new Error("A writable temporary directory is not available on this device.");
      const uri = `${FileSystem.cacheDirectory}${filename}`;
      await FileSystem.writeAsStringAsync(uri, JSON.stringify(page.raw, null, 2), { encoding: FileSystem.EncodingType.UTF8 });
      await shareFile(uri, { mimeType: "application/json", dialogTitle: filename, uti: "public.json" });
    } catch (err) {
      setError(auditDenialMessage(err, WORKSPACE_AUDIT_COPY.exportUnavailable));
    }
  }, [teamId, appliedAction, outcome]);

  return (
    <ProovraPageSection title={WORKSPACE_AUDIT_COPY.title}>
      <View style={{ gap: theme.space.s3 }} testID="workspace-audit">
        <ProovraText variant="label" color={theme.color.ink.muted}>
          {WORKSPACE_AUDIT_COPY.description}
        </ProovraText>
        <ProovraInput value={action} onChangeText={setAction} placeholder="Filter by action (exact)" accessibilityLabel="Filter by action" />
        <ProovraFilterChips<AuditOutcomeFilter>
          label="Filter by outcome"
          options={AUDIT_OUTCOME_OPTIONS}
          value={outcome}
          onChange={setOutcome}
        />
        <ProovraButton label="Export" variant="secondary" fullWidth={false} onPress={() => void exportAudit()} />

        {error ? (
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{error}</ProovraText>
        ) : rows.length === 0 ? (
          <ProovraText variant="bodySm" color={theme.color.ink.muted}>
            {loading ? WORKSPACE_AUDIT_COPY.loading : WORKSPACE_AUDIT_COPY.empty}
          </ProovraText>
        ) : (
          <ProovraCard>
            {rows.map((r) => (
              <ProovraListRow
                key={r.eventId}
                title={r.action || "—"}
                subtitle={`${r.occurredAtUtc} UTC · ${auditResourceLabel(r)}`}
                trailing={<ProovraBadge tone={auditOutcomeTone(r.outcome)} label={r.outcome ?? "—"} />}
              />
            ))}
          </ProovraCard>
        )}

        {nextCursor ? (
          <ProovraButton label="Load more" variant="ghost" fullWidth={false} disabled={loading} onPress={() => void load(nextCursor)} />
        ) : null}
      </View>
    </ProovraPageSection>
  );
}
