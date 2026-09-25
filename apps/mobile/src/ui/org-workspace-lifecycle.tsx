/**
 * ORG WORKSPACE LIFECYCLE (T-14) — the touch port of the web
 * OrgWorkspaceLifecycleControls: Suspend… (confirmed) and Resume on one
 * organization workspace. The server decides every refusal; the copy per
 * status is the web's. The outcome is announced here and survives the list
 * reload, because the screen reloads only the workspace list, in place.
 */
import React, { useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import {
  ORG_SUSPEND_CONSEQUENCE,
  buildOrgWorkspaceLifecyclePath,
  orgWorkspaceLifecycleDenial,
  orgWorkspaceLifecycleNotice,
  type OrgWorkspaceAction,
} from "../product/organizations";
import { theme } from "../theme/theme";
import { ProovraButton, ProovraText } from "./index";
import { ProovraConfirmSheet } from "./patterns";

export function OrgWorkspaceLifecycleControls({
  orgId,
  workspaceId,
  workspaceName,
  isPersonal,
  canManage,
  onChanged,
}: {
  orgId: string;
  workspaceId: string;
  workspaceName: string;
  isPersonal: boolean;
  canManage: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<OrgWorkspaceAction | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (action: OrgWorkspaceAction) => {
    setError(null);
    setNotice(null);
    setBusy(action);
    try {
      const res = await apiFetch(buildOrgWorkspaceLifecyclePath(orgId, workspaceId, action), { method: "POST", body: "{}" });
      setConfirming(false);
      setNotice(orgWorkspaceLifecycleNotice(action, workspaceName, res));
      await onChanged();
    } catch (err) {
      const status = typeof (err as { statusCode?: unknown })?.statusCode === "number" ? (err as { statusCode: number }).statusCode : null;
      setConfirming(false);
      setError(orgWorkspaceLifecycleDenial(status, action, toSafeUserError(err).message || null));
      if (status === 404) await onChanged();
    } finally {
      setBusy(null);
    }
  };

  const disabled = !canManage || isPersonal || busy !== null;

  return (
    <View style={{ gap: 4 }} testID={`org-workspace-lifecycle-${workspaceId}`}>
      <View style={{ flexDirection: "row", gap: theme.space.s2 }}>
        <ProovraButton
          label="Suspend…"
          accessibilityLabel={`Suspend workspace ${workspaceName}`}
          variant="secondary"
          fullWidth={false}
          disabled={disabled}
          loading={busy === "suspend"}
          onPress={() => {
            setError(null);
            setNotice(null);
            setConfirming(true);
          }}
        />
        <ProovraButton
          label="Resume"
          accessibilityLabel={`Resume workspace ${workspaceName}`}
          variant="secondary"
          fullWidth={false}
          disabled={disabled}
          loading={busy === "resume"}
          onPress={() => void run("resume")}
        />
      </View>
      {!canManage ? (
        <ProovraText variant="label" color={theme.color.ink.muted}>Organization admin access is required to suspend or resume a workspace.</ProovraText>
      ) : isPersonal ? (
        <ProovraText variant="label" color={theme.color.ink.muted}>A personal space can’t be suspended from here.</ProovraText>
      ) : null}
      {error || notice ? (
        <ProovraText variant="label" color={error ? theme.color.status.risk.fg : theme.color.ink.secondary}>
          {error ?? notice}
        </ProovraText>
      ) : null}
      <ProovraConfirmSheet
        visible={confirming}
        title="Suspend"
        consequence={ORG_SUSPEND_CONSEQUENCE(workspaceName)}
        confirmLabel="Confirm suspension"
        cancelLabel="Keep it running"
        tone="danger"
        busy={busy === "suspend"}
        onConfirm={() => void run("suspend")}
        onCancel={() => setConfirming(false)}
      />
    </View>
  );
}
