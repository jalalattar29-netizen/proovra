/**
 * EVIDENCE REQUESTS — LIST (Native Convergence §8, Workstream E). Requests in the
 * active workspace the member participates in: GET /v1/evidence-requests?teamId=.
 * A 403 (no capability) or an unresolved workspace renders an honest state.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { apiFetch } from "../../src/api";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { formatUserDateTime } from "../../src/lib/date";
import { usePlatformContext } from "../../src/product/platform-context";
import {
  parseEvidenceRequestList,
  requestStatusDisplay,
  type EvidenceRequestListItem,
} from "../../src/product/evidence-requests";
import {
  ProovraScreen,
  ProovraCard,
  ProovraSection,
  ProovraButton,
  ProovraBadge,
  ProovraListRow,
  ProovraEmptyState,
  ProovraErrorState,
  ProovraLoadingState,
} from "../../src/ui";

type Phase = "loading" | "ready" | "error" | "unavailable";

export default function EvidenceRequestsScreen() {
  const router = useRouter();
  const { loading: ctxLoading, context } = usePlatformContext();
  const teamId = context?.activeTeamId ?? null;
  const [items, setItems] = useState<EvidenceRequestListItem[]>([]);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<SafeError | null>(null);

  const load = useCallback(async () => {
    if (ctxLoading) return;
    if (!teamId) {
      setPhase("ready");
      setItems([]);
      return;
    }
    setPhase("loading");
    setError(null);
    try {
      const data = await apiFetch(`/v1/evidence-requests?teamId=${encodeURIComponent(teamId)}`);
      setItems(parseEvidenceRequestList(data));
      setPhase("ready");
    } catch (err) {
      const safe = toSafeUserError(err);
      if (safe.kind === "forbidden") setPhase("unavailable");
      else {
        setError(safe);
        setPhase("error");
      }
    }
  }, [teamId, ctxLoading]);

  useEffect(() => { void load(); }, [load]);

  return (
    <ProovraScreen>
      <ProovraSection
        title="Evidence requests"
        action={<ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />}
      >
        {ctxLoading || phase === "loading" ? (
          <ProovraLoadingState label="Loading requests" />
        ) : phase === "unavailable" ? (
          <ProovraEmptyState title="Not available" message="Evidence requests aren’t available for this workspace." />
        ) : phase === "error" && error ? (
          <ProovraErrorState message={error.message} onRetry={load} />
        ) : items.length === 0 ? (
          <ProovraEmptyState title="No evidence requests" message="Requests to submit evidence will appear here." />
        ) : (
          <ProovraCard>
            {items.map((req) => {
              const status = requestStatusDisplay(req.status);
              return (
                <ProovraListRow
                  key={req.id}
                  title={req.title}
                  subtitle={req.dueAtUtc ? `Due ${formatUserDateTime(req.dueAtUtc)}` : undefined}
                  trailing={<ProovraBadge tone={status.tone} label={status.label} />}
                  onPress={() => router.push(`/evidence-request/${req.id}`)}
                />
              );
            })}
          </ProovraCard>
        )}
      </ProovraSection>
    </ProovraScreen>
  );
}
