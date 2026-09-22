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
import { useRouter } from "expo-router";

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
  ProovraLoadingState,
  ProovraErrorState,
  ProovraEmpty,
} from "../../../src/ui";
import {
  MY_ORGS_PATH,
  orgRoleLabel,
  orgStatusTone,
  orgSummaryLine,
  parseMyOrgs,
  parseMyOrgsTotal,
  type OrgSummary,
} from "../../../src/product/organizations";

type State =
  | { phase: "loading" }
  | { phase: "loaded"; orgs: OrgSummary[]; total: number | null }
  | { phase: "failed" };

export default function OrganizationsScreen() {
  const router = useRouter();
  const [state, setState] = useState<State>({ phase: "loading" });

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const data = await apiFetch(MY_ORGS_PATH);
      setState({ phase: "loaded", orgs: parseMyOrgs(data), total: parseMyOrgsTotal(data) });
    } catch {
      setState({ phase: "failed" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ProovraScreen testID="organizations">
      <ProovraPageHeader
        title="Organizations"
        eyebrow="Governance"
        subtitle="The organizations you belong to, and what each one contains."
        secondaryActions={
          <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
        }
      />

      {state.phase === "loading" ? <ProovraLoadingState label="Loading organizations" /> : null}
      {state.phase === "failed" ? (
        <ProovraErrorState message="Organizations could not be loaded." onRetry={() => void load()} />
      ) : null}

      {state.phase === "loaded" && state.orgs.length === 0 ? (
        <ProovraEmpty
          presence="page"
          title="You are not a member of any organization"
          purpose="Organizations appear here when you accept an invitation to one. Your personal space is unaffected."
        />
      ) : null}

      {state.phase === "loaded" && state.orgs.length > 0 ? (
        <ProovraCard>
          {state.orgs.map((org) => (
            <ProovraListRow
              key={org.organizationId}
              title={org.name}
              subtitle={
                [
                  orgSummaryLine(org),
                  org.memberSinceIso ? `member since ${formatUserDateTime(org.memberSinceIso)}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              }
              onPress={() => router.push(`/organizations/${org.organizationId}`)}
              trailing={
                <ProovraBadge
                  label={orgRoleLabel(org.role)}
                  tone={orgStatusTone(org.status)}
                />
              }
            />
          ))}
        </ProovraCard>
      ) : null}

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
    </ProovraScreen>
  );
}
