/**
 * ORGANIZATION DETAIL — the native port of
 * `apps/web/app/(app)/organizations/[id]/page.tsx`.
 *
 * Governance only. `GET /v1/orgs/:id` returns governance fields and
 * deliberately omits workspace-level aggregates — no evidence counts, no case
 * counts, no reviewer queue counts — because an organization member is not
 * thereby a member of every workspace inside it. Native shows what the
 * endpoint gives and asks for nothing else.
 *
 * The destructive governance actions — ownership transfer, leaving, closure —
 * are NOT here. Each is irreversible or near-irreversible and needs the
 * surrounding confirmation the web surface builds around it; a phone-sized
 * version of a one-way door is not a smaller feature, it is a worse one. The
 * ledger names them rather than the screen implying they do not exist.
 */
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { apiFetch } from "../../../src/api";
import { formatUserDateTime } from "../../../src/lib/date";
import { theme } from "../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraListRow,
  ProovraPageHeader,
  ProovraPageSection,
  ProovraDetailRows,
  ProovraLoadingState,
  ProovraErrorState,
  ProovraEmpty,
} from "../../../src/ui";
import {
  buildOrgMembersPath,
  buildOrgPath,
  buildOrgWorkspacesPath,
  orgRoleLabel,
  orgStatusTone,
  parseOrgDetail,
  parseOrgMembers,
  parseOrgWorkspaces,
  type OrgDetail,
  type OrgMember,
  type OrgWorkspace,
} from "../../../src/product/organizations";

type State =
  | { phase: "loading" }
  | { phase: "loaded"; org: OrgDetail }
  | { phase: "denied" }
  | { phase: "failed" };

export default function OrganizationDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;

  const [state, setState] = useState<State>({ phase: "loading" });
  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [workspaces, setWorkspaces] = useState<OrgWorkspace[] | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setState({ phase: "loading" });
    try {
      const org = parseOrgDetail(await apiFetch(buildOrgPath(id)));
      if (!org) {
        setState({ phase: "failed" });
        return;
      }
      setState({ phase: "loaded", org });
    } catch (err) {
      // 403 is the membership gate answering; it is not a page failure.
      const status = (err as { statusCode?: number } | undefined)?.statusCode;
      setState({ phase: status === 403 || status === 404 ? "denied" : "failed" });
      return;
    }

    // Members and workspaces load independently: either may be gated on the
    // caller's org role, and one refusal must not blank the whole page.
    await Promise.all([
      apiFetch(buildOrgMembersPath(id))
        .then((d) => setMembers(parseOrgMembers(d)))
        .catch(() => setMembers(null)),
      apiFetch(buildOrgWorkspacesPath(id))
        .then((d) => setWorkspaces(parseOrgWorkspaces(d)))
        .catch(() => setWorkspaces(null)),
    ]);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ProovraScreen testID="organization-detail">
      <ProovraPageHeader
        title={state.phase === "loaded" ? (state.org.name ?? "Organization") : "Organization"}
        eyebrow="Governance"
        secondaryActions={
          <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
        }
      />

      {state.phase === "loading" ? <ProovraLoadingState label="Loading organization" /> : null}
      {state.phase === "failed" ? (
        <ProovraErrorState message="This organization could not be loaded." onRetry={() => void load()} />
      ) : null}
      {state.phase === "denied" ? (
        <ProovraEmpty
          presence="page"
          title="This organization is not available to you"
          purpose="You may have left it, or your membership may no longer be active."
        />
      ) : null}

      {state.phase === "loaded" ? (
        <>
          <ProovraCard>
            <View style={{ flexDirection: "row", gap: theme.space.s2, flexWrap: "wrap" }}>
              {state.org.status ? (
                <ProovraBadge label={state.org.status} tone={orgStatusTone(state.org.status)} />
              ) : null}
              {state.org.verificationState ? (
                <ProovraBadge
                  label={state.org.verificationState}
                  tone={orgStatusTone(state.org.verificationState)}
                />
              ) : null}
            </View>
            <ProovraDetailRows
              rows={[
                { label: "Legal name", value: state.org.legalName ?? "—" },
                { label: "Legal contact", value: state.org.legalEmail ?? "—" },
                { label: "Timezone", value: state.org.timezone ?? "—" },
                {
                  label: "Created",
                  value: state.org.createdAtIso ? formatUserDateTime(state.org.createdAtIso) : "—",
                },
                {
                  label: "Verified",
                  value: state.org.verifiedAtIso
                    ? formatUserDateTime(state.org.verifiedAtIso)
                    : "Not verified",
                },
              ]}
            />
          </ProovraCard>

          <ProovraPageSection title="Members">
            {members === null ? (
              <ProovraEmpty
                presence="inline"
                title="Members are visible to organization administrators."
              />
            ) : members.length === 0 ? (
              <ProovraEmpty presence="inline" title="No members are listed." />
            ) : (
              <ProovraCard>
                {members.map((m) => (
                  <ProovraListRow
                    key={m.id}
                    title={m.displayName}
                    subtitle={m.email ?? undefined}
                    trailing={
                      <ProovraText variant="label" color={theme.color.ink.muted}>
                        {orgRoleLabel(m.role)}
                      </ProovraText>
                    }
                  />
                ))}
              </ProovraCard>
            )}
          </ProovraPageSection>

          <ProovraPageSection title="Workspaces">
            {workspaces === null ? (
              <ProovraEmpty
                presence="inline"
                title="Workspaces are visible to organization administrators."
              />
            ) : workspaces.length === 0 ? (
              <ProovraEmpty presence="inline" title="This organization has no workspaces." />
            ) : (
              <ProovraCard>
                {workspaces.map((w) => (
                  <ProovraListRow
                    key={w.id}
                    title={w.name}
                    subtitle={
                      w.memberCount === null
                        ? undefined
                        : `${w.memberCount} member${w.memberCount === 1 ? "" : "s"}`
                    }
                  />
                ))}
              </ProovraCard>
            )}
          </ProovraPageSection>

          {/*
            Ownership transfer, leaving and closure are one-way doors. The web
            builds real confirmation around each; a phone-sized version of that
            is not a smaller feature, it is a worse one. Stated, not hidden.
          */}
          <ProovraText variant="label" color={theme.color.ink.muted}>
            Transferring ownership, leaving this organization and closing it are done in the
            PROOVRA web app.
          </ProovraText>
        </>
      ) : null}
    </ProovraScreen>
  );
}
