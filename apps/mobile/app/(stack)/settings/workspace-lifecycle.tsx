/**
 * SETTINGS → WORKSPACE LIFECYCLE (mobile parity of the web section; members
 * audit LIFE-01/02/07).
 *
 * How the active Workspace ends is the server's `lifecycle` projection
 * (`resolveWorkspaceLifecyclePolicy`), rendered here and never decided here.
 * No Workspace kind has a delete control: a Personal Workspace closes only
 * with its account, an Organization Workspace through its organization's
 * offboarding, and a legacy owned one through the canonical closure request.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "expo-router";

import { describeWorkspaceLifecycle } from "@proovra/shared";

import { apiFetch } from "../../../src/api";
import { toSafeUserError } from "../../../src/errors/safe-error";
import { usePlatformContext } from "../../../src/product/platform-context";
import { useAuth } from "../../../src/auth-context";
import { theme } from "../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraPageHeader,
  ProovraPageSection,
  ProovraLoadingState,
  ProovraErrorState,
} from "../../../src/ui";
import { WorkspaceOwnershipTransferCard } from "../../../src/ui/workspace-ownership-transfer";
import { WorkspaceClosureCard } from "../../../src/ui/workspace-closure-card";
import {
  buildWorkspacePath,
  isWorkspaceOwner,
  parseWorkspaceOverview,
  type WorkspaceOverview,
} from "../../../src/product/workspace-people";

export default function WorkspaceLifecycleScreen() {
  const router = useRouter();
  const { context } = usePlatformContext();
  const { user } = useAuth();
  const teamId = context?.activeTeamId ?? null;

  const [overview, setOverview] = useState<WorkspaceOverview | null>(null);
  const [error, setError] = useState<{ message: string; requestId: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!teamId) return;
    setError(null);
    try {
      setOverview(parseWorkspaceOverview(await apiFetch(buildWorkspacePath(teamId))));
    } catch (err) {
      const safe = toSafeUserError(err);
      setError({ message: safe.message, requestId: safe.requestId ?? null });
    }
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  const policy = overview?.lifecycle ?? null;
  const copy = policy ? describeWorkspaceLifecycle(policy) : null;

  return (
    <ProovraScreen shell testID="settings-workspace-lifecycle">
      <ProovraPageHeader
        title="Workspace lifecycle"
        eyebrow="Settings"
        subtitle="How this workspace ends. Workspaces are never deleted."
        secondaryActions={
          <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
        }
      />

      {error ? (
        <ProovraErrorState message={error.message} requestId={error.requestId} onRetry={() => void load()} />
      ) : !overview ? (
        <ProovraLoadingState />
      ) : !policy || !copy ? (
        <ProovraCard testID="workspace-lifecycle-unknown">
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
            This workspace&rsquo;s lifecycle isn&rsquo;t available right now.
          </ProovraText>
        </ProovraCard>
      ) : (
        <>
          {notice ? (
            <ProovraCard testID="workspace-lifecycle-notice">
              <ProovraText variant="bodySm">{notice}</ProovraText>
            </ProovraCard>
          ) : null}

          <ProovraPageSection title={copy.title}>
            <ProovraCard testID={`workspace-lifecycle-${policy.kind.toLowerCase()}`}>
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                {copy.explanation}
              </ProovraText>
              {policy.nextAction === "CLOSE_ACCOUNT" ? (
                <ProovraButton
                  label="Go to Close account"
                  variant="secondary"
                  fullWidth={false}
                  onPress={() => router.push("/settings/privacy" as never)}
                />
              ) : null}
            </ProovraCard>
          </ProovraPageSection>

          {policy.kind === "OWNED" && isWorkspaceOwner(overview) && teamId ? (
            <ProovraPageSection title="Owner actions">
              {policy.transferable ? (
                <WorkspaceOwnershipTransferCard
                  teamId={teamId}
                  teamName={overview.name ?? "this workspace"}
                  currentUserId={user?.id ?? null}
                  onTransferred={async (message) => {
                    setNotice(message);
                    await load();
                  }}
                />
              ) : null}
              {policy.closable ? <WorkspaceClosureCard teamId={teamId} /> : null}
            </ProovraPageSection>
          ) : null}
        </>
      )}
    </ProovraScreen>
  );
}
