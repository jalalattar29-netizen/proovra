/**
 * EVIDENCE REQUEST — DETAIL (Native Convergence §8, Workstream E). The requested
 * items, instructions, status and due date from GET /v1/evidence-requests/:id
 * (member-enforced). Offers a capture handoff to fulfil it. Deep-link target.
 * Honest states for invalid / expired / unauthorized (404/403).
 */
import { useCallback, useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { apiFetch } from "../../../src/api";
import { toSafeUserError, type SafeError } from "../../../src/errors/safe-error";
import { formatUserDateTime } from "../../../src/lib/date";
import {
  parseEvidenceRequestDetail,
  requestStatusDisplay,
  type EvidenceRequestDetail,
} from "../../../src/product/evidence-requests";
import { theme } from "../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraSection,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraListRow,
  ProovraEmptyState,
  ProovraErrorState,
  ProovraLoadingState,
} from "../../../src/ui";

type Phase = "loading" | "ready" | "error" | "notfound" | "unavailable";

export default function EvidenceRequestDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const id = params.id ?? "";
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<SafeError | null>(null);
  const [request, setRequest] = useState<EvidenceRequestDetail | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setPhase("loading");
    setError(null);
    try {
      const data = await apiFetch(`/v1/evidence-requests/${id}`);
      const detail = parseEvidenceRequestDetail(data);
      if (!detail) {
        setPhase("notfound");
        return;
      }
      setRequest(detail);
      setPhase("ready");
    } catch (err) {
      const safe = toSafeUserError(err);
      if (safe.kind === "notFound") setPhase("notfound");
      else if (safe.kind === "forbidden") setPhase("unavailable");
      else {
        setError(safe);
        setPhase("error");
      }
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  if (phase === "loading") return <ProovraScreen scroll={false}><ProovraLoadingState label="Loading request" /></ProovraScreen>;
  if (phase === "notfound") return <ProovraScreen scroll={false}><ProovraEmptyState title="Request not available" message="This evidence request is no longer available or has expired." action={<ProovraButton label="Back" fullWidth={false} onPress={() => router.back()} />} /></ProovraScreen>;
  if (phase === "unavailable") return <ProovraScreen scroll={false}><ProovraEmptyState title="Not available" message="You don’t have access to this request." action={<ProovraButton label="Back" fullWidth={false} onPress={() => router.back()} />} /></ProovraScreen>;
  if (phase === "error" && error) return <ProovraScreen scroll={false}><ProovraErrorState message={error.message} onRetry={load} /></ProovraScreen>;

  const r = request!;
  const status = requestStatusDisplay(r.status);
  const openForFulfilment = !["FULFILLED", "CLOSED", "CANCELLED"].includes(r.status);

  return (
    <ProovraScreen>
      <View style={styles.headerRow}>
        <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
      </View>

      <ProovraCard style={styles.hero}>
        <ProovraBadge tone={status.tone} label={status.label} />
        <ProovraText variant="h1" weight="bold" style={styles.gap}>{r.title}</ProovraText>
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
          {[r.recipientLabel, r.dueAtUtc ? `Due ${formatUserDateTime(r.dueAtUtc)}` : null].filter(Boolean).join(" · ") || "—"}
        </ProovraText>
      </ProovraCard>

      {r.instructions ? (
        <ProovraSection title="Instructions">
          <ProovraCard><ProovraText variant="bodySm">{r.instructions}</ProovraText></ProovraCard>
        </ProovraSection>
      ) : null}

      <ProovraSection title="Requested items">
        {r.deliverables.length === 0 ? (
          <ProovraText variant="bodySm" color={theme.color.ink.muted}>No specific items listed.</ProovraText>
        ) : (
          <ProovraCard>
            {r.deliverables.map((d) => (
              <ProovraListRow
                key={d.id}
                title={d.title}
                subtitle={[d.description, d.required ? "Required" : "Optional"].filter(Boolean).join(" · ") || undefined}
                trailing={<ProovraBadge tone={d.fulfilledCount > 0 ? "verified" : "neutral"} label={d.fulfilledCount > 0 ? `${d.fulfilledCount} added` : "Pending"} />}
              />
            ))}
          </ProovraCard>
        )}
      </ProovraSection>

      {openForFulfilment ? (
        <ProovraButton label="Capture evidence to fulfil" onPress={() => router.push("/capture")} />
      ) : null}
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", marginTop: theme.space.s2 },
  hero: { marginBottom: theme.space.s4, gap: theme.space.s2 },
  gap: { marginTop: theme.space.s2 },
});
