/**
 * SPACES — the native port of `/workspaces`
 * (`apps/web/components/workspace-admin/WorkspaceAdministrationHome.tsx`).
 *
 * Every space the caller belongs to, which one they are working in, and the
 * ability to move between them.
 *
 * There is no "create a workspace" here, and that is deliberate: POST /v1/teams
 * is a COMPATIBILITY_TOMBSTONE whose handler refuses on every path. The screen
 * says where a workspace comes from rather than offering a button that can
 * only fail.
 *
 * SWITCHING DID NOT EXIST ANYWHERE IN THE NATIVE APP
 * The ledger said native "switches workspace through the account menu"; it
 * did not, and no switcher existed. Because every workspace-scoped screen
 * reads `activeTeamId` from the platform context, a user with a Personal
 * Space and an organization workspace was pinned to whichever one the server
 * last recorded — unable to reach the other space's evidence, cases or people
 * from the phone at all.
 *
 * The switch is a SERVER pointer (`POST /v1/platform/context/switch-workspace`
 * writes `user.currentWorkspaceId` and returns the rebuilt envelope), not a
 * client preference. That is why nothing here keeps a local "selected
 * workspace": a second copy of the pointer is how two surfaces end up
 * disagreeing about which tenant the user is in.
 */
import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch } from "../../src/api";
import { toSafeUserError } from "../../src/errors/safe-error";
import { usePlatformContext } from "../../src/product/platform-context";
import { useToast } from "../../src/toast-context";
import { theme } from "../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraListRow,
  ProovraPageHeader,
  ProovraPageSection,
  ProovraLoadingState,
  ProovraErrorState,
  ProovraEmpty,
} from "../../src/ui";
import {
  SWITCH_WORKSPACE_PATH,
  WORKSPACE_CREATION_NOTE,
  buildSwitchWorkspaceBody,
  canSwitchTo,
  isActiveSpace,
  projectSpaces,
  spaceKindLabel,
  spaceSummaryLine,
  type Space,
} from "../../src/product/spaces";

function SpaceRow({
  space,
  active,
  busy,
  onSwitch,
}: {
  space: Space;
  active: boolean;
  busy: boolean;
  onSwitch: () => void;
}) {
  const summary = spaceSummaryLine(space);
  return (
    <ProovraListRow
      title={space.name}
      subtitle={[spaceKindLabel(space.kind), summary].filter(Boolean).join(" · ")}
      // The active space is not offered a switch: it is a request with nothing
      // to do, and an affordance that does nothing reads as one that failed.
      onPress={active || busy ? undefined : onSwitch}
      trailing={
        active ? (
          <ProovraBadge label="Working here" tone="verified" />
        ) : (
          <ProovraText variant="label" color={theme.color.accent.a600}>
            Switch
          </ProovraText>
        )
      }
    />
  );
}

export default function SpacesScreen() {
  const router = useRouter();
  const { addToast } = useToast();
  const { loading, error, envelope, refresh } = usePlatformContext();

  const [busy, setBusy] = useState(false);

  const view = useMemo(() => projectSpaces(envelope), [envelope]);

  const switchTo = useCallback(
    async (space: Space) => {
      if (!canSwitchTo(space, view)) return;
      setBusy(true);
      try {
        await apiFetch(SWITCH_WORKSPACE_PATH, {
          method: "POST",
          body: JSON.stringify(buildSwitchWorkspaceBody(space.id)),
        });
        // The pointer lives on the server. Rereading the envelope is what makes
        // it true here, rather than assuming the switch landed.
        refresh();
        addToast(`You are now working in ${space.name}.`, "success");
      } catch (err) {
        addToast(toSafeUserError(err).message, "error");
      } finally {
        setBusy(false);
      }
    },
    [view, refresh, addToast],
  );

  return (
    <ProovraScreen testID="spaces">
      <ProovraPageHeader
        title="Spaces"
        eyebrow="Workspace administration"
        subtitle="Your Personal Space is private to you. Organization workspaces are shared — members, roles and governance live there."
        secondaryActions={
          <ProovraButton
            label="Back"
            variant="ghost"
            fullWidth={false}
            onPress={() => router.back()}
          />
        }
      />

      {loading ? <ProovraLoadingState label="Loading your spaces" /> : null}
      {error ? (
        <ProovraErrorState message="Your spaces could not be loaded." onRetry={refresh} />
      ) : null}

      {!loading && !error ? (
        <>
          <ProovraPageSection title="Personal">
            {view.personal ? (
              <ProovraCard>
                <SpaceRow
                  space={view.personal}
                  active={isActiveSpace(view.personal, view)}
                  busy={busy}
                  onSwitch={() => void switchTo(view.personal as Space)}
                />
              </ProovraCard>
            ) : (
              // Never substituted. An ENTERPRISE identity under a
              // `noPersonalSpace` policy has none, and inventing one here
              // would offer a space the server would refuse to switch to.
              <ProovraEmpty
                presence="inline"
                title="You do not have a Personal Space"
                purpose="Your organization's policy does not provide one."
              />
            )}
          </ProovraPageSection>

          {view.owned.length > 0 ? (
            <ProovraPageSection title="Your workspaces">
              <ProovraCard>
                {view.owned.map((s) => (
                  <SpaceRow
                    key={s.id}
                    space={s}
                    active={isActiveSpace(s, view)}
                    busy={busy}
                    onSwitch={() => void switchTo(s)}
                  />
                ))}
              </ProovraCard>
            </ProovraPageSection>
          ) : null}

          <ProovraPageSection title="Organization workspaces">
            {view.organization.length === 0 ? (
              <ProovraEmpty
                presence="inline"
                title="You are not in any organization workspace."
              />
            ) : (
              <ProovraCard>
                {view.organization.map((s) => (
                  <SpaceRow
                    key={s.id}
                    space={s}
                    active={isActiveSpace(s, view)}
                    busy={busy}
                    onSwitch={() => void switchTo(s)}
                  />
                ))}
              </ProovraCard>
            )}
          </ProovraPageSection>

          {/*
            POST /v1/teams is a tombstone that refuses on every path, so there
            is no create control. A button that can only fail teaches the user
            the app is broken when the server is doing what it was asked to.
          */}
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {WORKSPACE_CREATION_NOTE}
          </ProovraText>

          <View style={{ gap: theme.space.s2 }}>
            {/*
              The web page cross-links these two for the same reason: this
              screen administers SPACES, and governance — members, invites,
              audit — belongs to the Organization, which is a different tenant.
            */}
            <ProovraButton
              label="Organizations"
              variant="secondary"
              onPress={() => router.push("/organizations")}
            />
            <ProovraButton
              label="People in this workspace"
              variant="secondary"
              onPress={() => router.push("/workspace-people")}
            />
          </View>
        </>
      ) : null}

    </ProovraScreen>
  );
}
