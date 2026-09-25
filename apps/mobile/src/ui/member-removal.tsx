/**
 * MEMBER REMOVAL (T-14) — the touch port of the web MemberRemovalDialog. The
 * impact is read first; when the member owns active records an ADMIN/OWNER
 * transfer target must be chosen (or the removal is blocked, said in words);
 * the DELETE runs only on an explicit tap.
 */
import React, { useEffect, useState } from "react";
import { View } from "react-native";

import { apiFetch, apiFetchText } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import {
  buildMemberRemovalImpactPath,
  buildMemberRemovePath,
  parseRemovalImpact,
  removalFailure,
  removalImpactFailure,
  type RemovalImpact,
  type WorkspaceMember,
} from "../product/workspace-people";
import { theme } from "../theme/theme";
import { ProovraButton, ProovraText } from "./index";
import { ProovraFilterChips, ProovraSheet } from "./patterns";

export function MemberRemovalSheet({
  teamId,
  member,
  onClose,
  onRemoved,
}: {
  teamId: string;
  member: WorkspaceMember | null;
  onClose: () => void;
  onRemoved: (member: WorkspaceMember) => void | Promise<void>;
}) {
  const [impact, setImpact] = useState<RemovalImpact | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    setImpact(null);
    setLoadError(null);
    setTarget("");
    setSubmitError(null);
    if (!member) return;
    let cancelled = false;
    apiFetch(buildMemberRemovalImpactPath(teamId, member.id))
      .then((d) => {
        if (!cancelled) setImpact(parseRemovalImpact(d));
      })
      .catch((err) => {
        if (cancelled) return;
        const status = (err as { statusCode?: number })?.statusCode ?? null;
        setLoadError(removalImpactFailure(status, toSafeUserError(err).message || null));
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, member]);

  const requiresTransfer = impact?.requiresTransfer === true;
  const canSubmit = Boolean(impact) && !busy && (!requiresTransfer || (impact!.targets.length > 0 && target !== ""));

  const remove = async () => {
    if (!member || !canSubmit) return;
    setBusy(true);
    setSubmitError(null);
    try {
      // 204 No Content (teams.routes.ts:2206): apiFetch would parse an empty
      // body and report a completed removal as a failure.
      await apiFetchText(buildMemberRemovePath(teamId, member.id), {
        method: "DELETE",
        ...(requiresTransfer && target ? { body: JSON.stringify({ transferToUserId: target }) } : {}),
      });
      await onRemoved(member);
    } catch (err) {
      const e = err as { statusCode?: number; code?: string };
      setSubmitError(removalFailure(e?.code ?? null, e?.statusCode ?? null, toSafeUserError(err).message || null));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ProovraSheet visible={member !== null} title={member ? `Remove ${member.displayName}` : ""} onClose={() => (busy ? undefined : onClose())}>
      {member ? (
        <View style={{ gap: theme.space.s3 }} testID="member-removal">
          <ProovraText variant="bodySm">{`You're about to remove ${member.displayName} (${member.role}) from the workspace.`}</ProovraText>
          {!impact && !loadError ? <ProovraText variant="label" color={theme.color.ink.muted}>Checking what they own in this team…</ProovraText> : null}
          {loadError ? <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{loadError}</ProovraText> : null}
          {impact ? (
            <>
              <ProovraText variant="label" color={theme.color.ink.secondary}>
                {`Evidence owned ${impact.ownedEvidence} · Cases owned ${impact.ownedCases} · Open assignments ${impact.openAssignments}`}
              </ProovraText>
              {requiresTransfer ? (
                impact.targets.length > 0 ? (
                  <View style={{ gap: theme.space.s1 }}>
                    <ProovraFilterChips<string>
                      label="Transfer ownership to"
                      value={target}
                      onChange={setTarget}
                      options={impact.targets.map((t) => ({ value: t.userId, label: `${t.label} (${t.role})` }))}
                    />
                    <ProovraText variant="label" color={theme.color.ink.muted}>
                      Only ADMIN-or-OWNER members are eligible. Ownership transfer happens atomically with the removal — no record will be orphaned.
                    </ProovraText>
                  </View>
                ) : (
                  <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>
                    Removal blocked — no eligible transfer target. This member owns active records but the workspace has no other ADMIN or OWNER to receive them. Promote another member to ADMIN first, then re-open this dialog.
                  </ProovraText>
                )
              ) : (
                <ProovraText variant="label" color={theme.color.ink.secondary}>
                  This member doesn’t own any active evidence or cases in this team. Removing them won’t transfer any ownership.
                </ProovraText>
              )}
            </>
          ) : null}
          {submitError ? <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{submitError}</ProovraText> : null}
          <View style={{ flexDirection: "row", gap: theme.space.s2 }}>
            <ProovraButton label="Cancel" variant="ghost" fullWidth={false} disabled={busy} onPress={onClose} />
            <ProovraButton label={busy ? "Removing…" : "Remove member"} variant="danger" fullWidth={false} disabled={!canSubmit} onPress={() => void remove()} />
          </View>
        </View>
      ) : null}
    </ProovraSheet>
  );
}
