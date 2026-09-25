/**
 * ORGANIZATIONS — the native port of `apps/web/app/(app)/organizations`.
 *
 * The canonical org governance entry point, over `GET /v1/me/orgs`. Every
 * authenticated user gets it — it is membership-gated, not enterprise-gated —
 * and it lists only CUSTOMER organizations the caller is an ACTIVE member of,
 * because the server says so and for reasons worth repeating: the internal 1:1
 * bootstrap container every workspace owns is not a customer organization, and
 * "a suspended or revoked membership must not appear and then refuse on
 * arrival".
 *
 * Those filters are the server's and are not re-applied here. A client-side
 * filter over a server-filtered list is a second authority that will disagree
 * the moment either changes.
 */
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch } from "../../../src/api";
import { toSafeUserError } from "../../../src/errors/safe-error";
import { formatUserDate } from "../../../src/lib/date";
import { theme } from "../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraPageHeader,
  ProovraLoadingState,
  ProovraFormField,
  ProovraInput,
} from "../../../src/ui";
import { ProovraSheet } from "../../../src/ui/patterns";
import { WORKSPACE_CREATION_NOTE } from "../../../src/product/spaces";
import {
  MY_ORGS_PATH,
  ORG_LIST_COPY as COPY,
  orgRoleLabel,
  orgStatusTone,
  parseMyOrgs,
  parseMyOrgsTotal,
  type OrgSummary,
} from "../../../src/product/organizations";

type State =
  | { phase: "loading" }
  | { phase: "loaded"; orgs: OrgSummary[]; total: number | null }
  | { phase: "failed"; message: string; status: number | null };

export default function OrganizationsScreen() {
  const router = useRouter();
  const [state, setState] = useState<State>({ phase: "loading" });
  const [infoOpen, setInfoOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinToken, setJoinToken] = useState("");

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const data = await apiFetch(MY_ORGS_PATH);
      setState({ phase: "loaded", orgs: parseMyOrgs(data), total: parseMyOrgsTotal(data) });
    } catch (err) {
      const status = (err as { statusCode?: number } | undefined)?.statusCode;
      setState({
        phase: "failed",
        message: toSafeUserError(err, { message: "Failed to load organizations." }).message,
        status: typeof status === "number" ? status : null,
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openJoin = () => {
    setJoinToken("");
    setJoinOpen(true);
  };

  return (
    <ProovraScreen shell testID="organizations">
      <ProovraPageHeader
        title="Organizations"
        eyebrow={COPY.eyebrow}
        subtitle={COPY.subtitle}
        secondaryActions={
          <>
            <ProovraButton label="Accept invite token" variant="secondary" fullWidth={false} onPress={openJoin} />
            <ProovraButton label="About Enterprise organizations" variant="ghost" fullWidth={false} onPress={() => setInfoOpen(true)} />
          </>
        }
      />

      {/* The web's enterprise-provisioning info. Its "Create a workspace" link
          lands on collaboration groups (/teams → /collaboration-teams) and
          workspace creation is a server tombstone, so native says where a
          workspace really comes from instead. */}
      <ProovraSheet visible={infoOpen} title="Enterprise organizations" onClose={() => setInfoOpen(false)}>
        <View style={{ gap: theme.space.s3 }} testID="enterprise-info">
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
            Organizations are the legal, billing, and governance boundary for PROOVRA Enterprise customers. They are provisioned as part of an Enterprise agreement — they cannot be created self-service.
          </ProovraText>
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{WORKSPACE_CREATION_NOTE}</ProovraText>
          <ProovraButton label="Close" variant="ghost" onPress={() => setInfoOpen(false)} />
        </View>
      </ProovraSheet>

      {/* Paste-a-token join. Acceptance runs on the ONE native accept screen
          (/org-invite/[token]: preview, accept, workspace grants, the
          expired/revoked/not-found states) rather than a second accept path. */}
      <ProovraSheet visible={joinOpen} title="Accept invite token" onClose={() => setJoinOpen(false)}>
        <View style={{ gap: theme.space.s3 }} testID="join-org">
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
            Paste the invite token an organization administrator shared with you. Accepting binds your account to the organization at the role chosen by the inviter. This does NOT grant you access to workspace evidence, cases, or reviewer queues — those remain workspace-scoped.
          </ProovraText>
          <ProovraFormField label="Invite token">
            <ProovraInput value={joinToken} onChangeText={setJoinToken} autoCapitalize="none" accessibilityLabel="Invite token" />
          </ProovraFormField>
          <View style={{ flexDirection: "row", gap: theme.space.s2 }}>
            <ProovraButton label="Cancel" variant="ghost" fullWidth={false} onPress={() => setJoinOpen(false)} />
            <ProovraButton
              label="Accept invite"
              fullWidth={false}
              disabled={!joinToken.trim()}
              onPress={() => {
                setJoinOpen(false);
                router.push(`/org-invite/${encodeURIComponent(joinToken.trim())}`);
              }}
            />
          </View>
        </View>
      </ProovraSheet>

      {state.phase === "loading" ? <ProovraLoadingState label="Loading organizations…" /> : null}

      {state.phase === "failed" ? (
        <ProovraCard testID="organizations-error">
          <ProovraText variant="bodySm" weight="semibold" color={theme.color.status.risk.fg}>
            {COPY.loadFailed}
          </ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            {`${state.status ? `HTTP ${state.status}: ` : ""}${state.message}`}
          </ProovraText>
          <ProovraButton label="Retry" variant="secondary" fullWidth={false} onPress={() => void load()} />
        </ProovraCard>
      ) : null}

      {state.phase === "loaded" && state.orgs.length === 0 ? (
        <ProovraCard testID="organizations-empty" style={{ gap: theme.space.s2 }}>
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{COPY.emptyTitle}</ProovraText>
          {COPY.emptyBullets.map((line) => (
            <ProovraText key={line} variant="label" color={theme.color.ink.secondary}>{`• ${line}`}</ProovraText>
          ))}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
            <ProovraButton label="About Enterprise organizations" fullWidth={false} onPress={() => setInfoOpen(true)} />
            <ProovraButton label="Accept invite token" variant="secondary" fullWidth={false} onPress={openJoin} />
            <ProovraButton label="Workspace administration" variant="ghost" fullWidth={false} onPress={() => router.push("/spaces")} />
          </View>
        </ProovraCard>
      ) : null}

      {state.phase === "loaded" && state.orgs.length > 0
        ? state.orgs.map((org) => (
            <ProovraCard key={org.organizationId} testID={`org-card-${org.organizationId}`} style={{ gap: theme.space.s2 }}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s2 }}>
                <ProovraText variant="body" weight="semibold">{org.name}</ProovraText>
                <ProovraBadge label={orgRoleLabel(org.role)} tone="governance" />
                {org.status ? <ProovraBadge label={org.status} tone={orgStatusTone(org.status)} /> : null}
                {org.pendingInviteCount > 0 ? (
                  <ProovraBadge label={`${org.pendingInviteCount} pending`} tone="pending" />
                ) : null}
              </View>
              <ProovraText variant="label" color={theme.color.ink.secondary}>
                {[
                  `${org.memberCount} ${org.memberCount === 1 ? "member" : "members"}`,
                  `${org.workspaceCount} ${org.workspaceCount === 1 ? "workspace" : "workspaces"}`,
                  org.memberSinceIso ? `you joined ${formatUserDate(org.memberSinceIso)}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </ProovraText>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
                <ProovraButton
                  label="Open"
                  fullWidth={false}
                  accessibilityLabel={`Open ${org.name}`}
                  onPress={() => router.push(`/organizations/${org.organizationId}`)}
                />
                <ProovraButton label="Workspace admin" variant="secondary" fullWidth={false} onPress={() => router.push("/spaces")} />
              </View>
            </ProovraCard>
          ))
        : null}

      {/*
        The server's own total, shown when it disagrees with the list. They
        should always agree; if they ever do not, that is a signal worth seeing
        rather than something to paper over by counting rows.
      */}
      {state.phase === "loaded" && state.total !== null && state.total !== state.orgs.length ? (
        <ProovraText variant="label" color={theme.color.status.pending.fg}>
          {`The server reports ${state.total} organization(s) but sent ${state.orgs.length}.`}
        </ProovraText>
      ) : null}

      {/* The web's helper footer. */}
      <View style={{ gap: theme.space.s1, paddingTop: theme.space.s2 }} testID="organizations-footer">
        <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.footer}</ProovraText>
        <ProovraButton label="Workspace administration" variant="ghost" fullWidth={false} onPress={() => router.push("/spaces")} />
      </View>
    </ProovraScreen>
  );
}
