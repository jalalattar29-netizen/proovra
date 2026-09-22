/**
 * EVIDENCE REQUEST — DETAIL (Native Convergence §8, Workstream E). The requested
 * items, instructions, status and due date from GET /v1/evidence-requests/:id
 * (member-enforced). Offers a capture handoff to fulfil it. Deep-link target.
 * Honest states for invalid / expired / unauthorized (404/403).
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, View, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { apiFetch } from "../../../src/api";
import { toSafeUserError, type SafeError } from "../../../src/errors/safe-error";
import { formatUserDateTime } from "../../../src/lib/date";
import {
  availableRequestTransitions,
  buildRequestDeliveriesPath,
  buildRequestEventsPath,
  buildRequestTransitionPath,
  buildTransitionBody,
  deliveryTone,
  parseEvidenceRequestDetail,
  parseRequestDeliveries,
  parseRequestEvents,
  requestStatusDisplay,
  requestTransitionConsequence,
  requestTransitionIsDestructive,
  requestTransitionLabel,
  type EvidenceRequestDetail,
  type RequestDelivery,
  type RequestEvent,
  type RequestTransition,
} from "../../../src/product/evidence-requests";
import { humanizeEnum } from "../../../src/product/domain-display";
import { theme } from "../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraSection,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraListRow,
  ProovraEmpty,
  ProovraSheet,
  ProovraInput,
  ProovraFormField,
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
  const [deliveries, setDeliveries] = useState<RequestDelivery[] | null>(null);
  const [events, setEvents] = useState<RequestEvent[] | null>(null);
  const [pending, setPending] = useState<RequestTransition | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

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

      // Deliveries and history load independently: either may be gated on the
      // reader's role, and one refusal must not blank the request itself.
      void apiFetch(buildRequestDeliveriesPath(String(id)))
        .then((d) => setDeliveries(parseRequestDeliveries(d)))
        .catch(() => setDeliveries([]));
      void apiFetch(buildRequestEventsPath(String(id)))
        .then((d) => setEvents(parseRequestEvents(d)))
        .catch(() => setEvents([]));
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

  const runTransition = useCallback(async () => {
    if (!id || !pending) return;
    const transition = pending;
    setBusy(true);
    try {
      await apiFetch(buildRequestTransitionPath(String(id), transition), {
        method: "POST",
        body: JSON.stringify(buildTransitionBody(note)),
      });
      setPending(null);
      setNote("");
      await load();
    } catch (err) {
      Alert.alert("Could not complete that", toSafeUserError(err).message);
    } finally {
      setBusy(false);
    }
  }, [id, pending, note, load]);

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

      {/*
        The transitions this request's CURRENT status permits. The state
        machine is the server's and every route re-checks; what this prevents
        is the other failure — offering "Send" on a request cancelled last
        week, which produces a refusal the user cannot act on and makes the
        surface look broken rather than the action look wrong.
      */}
      {request && availableRequestTransitions(request.status ?? "").length > 0 ? (
        <ProovraSection title="Actions">
          <ProovraCard>
            {availableRequestTransitions(request.status ?? "").map((t) => (
              <ProovraButton
                key={t}
                label={requestTransitionLabel(t)}
                variant={requestTransitionIsDestructive(t) ? "ghost" : "secondary"}
                loading={busy}
                onPress={() => setPending(t)}
              />
            ))}
          </ProovraCard>
        </ProovraSection>
      ) : null}

      <ProovraSection title="Deliveries">
        {deliveries === null ? (
          <ProovraLoadingState label="Loading deliveries" />
        ) : deliveries.length === 0 ? (
          <ProovraEmpty presence="inline" title="This request has not been sent yet." />
        ) : (
          <ProovraCard>
            {deliveries.map((d) => (
              <View key={d.id} style={{ gap: 2, paddingVertical: theme.space.s2 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.space.s2 }}>
                  <ProovraText variant="bodySm">{d.recipientLabel ?? d.channel ?? "Recipient"}</ProovraText>
                  <ProovraBadge label={d.status} tone={deliveryTone(d.status)} />
                </View>
                {/* A failure that says nothing is worse than one that names itself. */}
                {d.failureReason ? (
                  <ProovraText variant="label" color={theme.color.status.risk.fg}>
                    {d.failureReason}
                  </ProovraText>
                ) : d.sentAtIso ? (
                  <ProovraText variant="label" color={theme.color.ink.muted}>
                    {formatUserDateTime(d.sentAtIso)}
                  </ProovraText>
                ) : null}
              </View>
            ))}
          </ProovraCard>
        )}
      </ProovraSection>

      <ProovraSection title="History">
        {events === null ? (
          <ProovraLoadingState label="Loading history" />
        ) : events.length === 0 ? (
          <ProovraEmpty presence="inline" title="Nothing has happened on this request yet." />
        ) : (
          <ProovraCard>
            {events.map((e) => (
              <View key={e.id} style={{ gap: 2, paddingVertical: theme.space.s2 }}>
                <ProovraText variant="bodySm">{humanizeEnum(e.type)}</ProovraText>
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  {[e.actorLabel, e.occurredAtIso ? formatUserDateTime(e.occurredAtIso) : null]
                    .filter(Boolean)
                    .join(" · ")}
                </ProovraText>
                {e.note ? (
                  <ProovraText variant="label" color={theme.color.ink.secondary}>
                    {e.note}
                  </ProovraText>
                ) : null}
              </View>
            ))}
          </ProovraCard>
        )}
      </ProovraSection>

      <ProovraSheet
        visible={pending !== null}
        title={pending ? requestTransitionLabel(pending) : ""}
        onClose={() => { setPending(null); setNote(""); }}
      >
        {/*
          Cancel and close both END a request and neither can be undone, so the
          difference is stated rather than left to be inferred from two similar
          words.
        */}
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
          {pending ? requestTransitionConsequence(pending) : ""}
        </ProovraText>
        <ProovraFormField label="Note (optional)">
          <ProovraInput
            value={note}
            onChangeText={setNote}
            placeholder="Recorded on the request"
            multiline
            autoCapitalize="sentences"
            accessibilityLabel="Note"
          />
        </ProovraFormField>
        <ProovraButton
          label={pending ? requestTransitionLabel(pending) : "Confirm"}
          variant={pending && requestTransitionIsDestructive(pending) ? "danger" : "primary"}
          loading={busy}
          onPress={() => void runTransition()}
        />
      </ProovraSheet>
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", marginTop: theme.space.s2 },
  hero: { marginBottom: theme.space.s4, gap: theme.space.s2 },
  gap: { marginTop: theme.space.s2 },
});
