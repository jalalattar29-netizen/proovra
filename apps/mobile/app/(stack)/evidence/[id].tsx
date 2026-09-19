import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Linking, Pressable, View, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { EvidenceOutputState } from "@proovra/shared";
import { apiFetch } from "../../../src/api";
import { toSafeUserError, type SafeError } from "../../../src/errors/safe-error";
import { formatUserDateTime } from "../../../src/lib/date";
import { theme } from "../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraSection,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraEmptyState,
  ProovraErrorState,
  ProovraLoadingState,
} from "../../../src/ui";
import {
  evidenceStatusDisplay,
  evidenceTypeLabel,
  verificationStatusDisplay,
} from "../../../src/product/domain-display";

/**
 * P2-3 CLOSURE — one sentence per canonical output state. TOTAL over
 * EvidenceOutputState (from @proovra/shared — mobile holds no vocabulary of its
 * own). `null` is the honest "could not read status" case. Preserved verbatim.
 */
function reportStateMessage(state: EvidenceOutputState | null): string {
  switch (state) {
    case null:
      return "Report status is unavailable right now. Pull to refresh, or open this record on the web app.";
    case "READY":
      return "The report is ready. Open this record on the web app to download it.";
    case "NOT_INCLUDED":
      return "A report and verification package are not included for this record. Its integrity materials and public verification are unaffected.";
    case "NOT_APPLICABLE":
      return "A report becomes available once this record is finalized.";
    case "ELIGIBLE_NOT_GENERATED":
      return "No report has been generated for this record yet. Generate one from the web app.";
    case "QUEUED":
    case "GENERATING":
      return "The report is being generated. It will be available here shortly.";
    case "RETRYABLE_FAILURE":
      return "The last attempt to generate the report did not complete. The evidence record and its integrity state are unaffected.";
    case "TERMINAL_FAILURE":
      return "Report generation stopped for this record. Open it on the web app for the reason.";
    case "BLOCKED":
      return "Report generation is blocked for this record by a governance or lifecycle decision.";
  }
}

type Tab = "overview" | "integrity" | "custody" | "artifacts";
type LoadState = "loading" | "ready" | "error" | "notfound";

interface Core {
  status: string;
  statusLabel: string | null;
  verificationStatus: string | null;
  verificationStatusLabel: string | null;
  displayTitle: string | null;
  originalFileName: string | null;
  createdAt: string | null;
  type: string;
  fileSha256: string | null;
  fingerprintHash: string | null;
}

export default function EvidenceDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const id = params.id ?? "";

  const [tab, setTab] = useState<Tab>("overview");
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<SafeError | null>(null);
  const [core, setCore] = useState<Core | null>(null);
  const [reportState, setReportState] = useState<EvidenceOutputState | null>(null);
  const [reportUrl, setReportUrl] = useState<string | null>(null);
  const [rw, setRw] = useState<Record<string, unknown> | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setState("loading");
    setError(null);
    try {
      const data = await apiFetch(`/v1/evidence/${id}`);
      const ev = (data.evidence ?? {}) as Record<string, unknown>;
      setCore({
        status: (ev.status as string) ?? "SIGNED",
        statusLabel: (ev.statusLabel as string) ?? null,
        verificationStatus: (ev.verificationStatus as string) ?? null,
        verificationStatusLabel: (ev.verificationStatusLabel as string) ?? null,
        displayTitle: (ev.displayTitle as string) ?? (ev.displayFileName as string) ?? null,
        originalFileName: (ev.originalFileName as string) ?? null,
        createdAt: (ev.createdAt as string) ?? null,
        type: (ev.type as string) ?? "Evidence",
        fileSha256: (ev.fileSha256 as string) ?? null,
        fingerprintHash: (ev.fingerprintHash as string) ?? null,
      });
      setState("ready");
    } catch (err) {
      const safe = toSafeUserError(err);
      if (safe.kind === "notFound") {
        setState("notfound");
      } else {
        setError(safe);
        setState("error");
      }
      return;
    }

    // STATUS BEFORE URL — side-effect-free status first; only mint the report
    // URL (which records a custody/audit download) once the server says READY.
    try {
      const st = await apiFetch(`/v1/evidence/${id}/artifacts/status`);
      const next = (st?.outputs?.report?.state ?? null) as EvidenceOutputState | null;
      setReportState(next);
      if (next === "READY") {
        try {
          const report = await apiFetch(`/v1/evidence/${id}/report/latest`);
          setReportUrl((report.url as string) ?? null);
        } catch {
          setReportUrl(null);
        }
      } else {
        setReportUrl(null);
      }
    } catch {
      setReportState(null);
      setReportUrl(null);
    }

    // Rich review-workspace projection (defensive: render only what is present;
    // never fabricate integrity/custody facts).
    try {
      setRw(await apiFetch(`/v1/evidence/${id}/review-workspace`));
    } catch {
      setRw(null);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const runAction = useCallback(
    (label: string, opts: { path?: string; method?: "POST" | "DELETE"; body?: object; destructive?: boolean }) => {
      Alert.alert(label, `${label} this record?`, [
        { text: "Cancel", style: "cancel" },
        {
          text: label,
          style: opts.destructive ? "destructive" : "default",
          onPress: () => {
            void (async () => {
              setActionBusy(true);
              try {
                const suffix = opts.path ? `/${opts.path}` : "";
                await apiFetch(`/v1/evidence/${id}${suffix}`, {
                  method: opts.method ?? "POST",
                  body: opts.body ? JSON.stringify(opts.body) : undefined,
                });
                await load(); // reconcile after mutation
              } catch (err) {
                Alert.alert("Action failed", toSafeUserError(err).message);
              } finally {
                setActionBusy(false);
              }
            })();
          },
        },
      ]);
    },
    [id, load],
  );

  const parts = useMemo(() => (Array.isArray(rw?.parts) ? (rw!.parts as unknown[]) : []), [rw]);
  const integrity = (rw?.integrity ?? null) as Record<string, unknown> | null;
  const publicVerification = (rw?.publicVerification ?? null) as Record<string, unknown> | null;

  if (state === "loading") {
    return (
      <ProovraScreen scroll={false}>
        <ProovraLoadingState label="Loading record" />
      </ProovraScreen>
    );
  }
  if (state === "notfound") {
    return (
      <ProovraScreen scroll={false}>
        <ProovraEmptyState title="Record not found" message="This evidence record is no longer available." action={<ProovraButton label="Back" fullWidth={false} onPress={() => router.back()} />} />
      </ProovraScreen>
    );
  }
  if (state === "error" && error) {
    return (
      <ProovraScreen scroll={false}>
        <ProovraErrorState message={error.message} onRetry={load} />
      </ProovraScreen>
    );
  }

  const c = core!;
  const TABS: Array<{ key: Tab; label: string }> = [
    { key: "overview", label: "Overview" },
    { key: "integrity", label: "Integrity" },
    { key: "custody", label: "Custody" },
    { key: "artifacts", label: "Artifacts" },
  ];

  return (
    <ProovraScreen>
      <View style={styles.headerRow}>
        <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
      </View>

      <ProovraCard style={styles.hero}>
        <View style={styles.badgeRow}>
          <ProovraBadge tone={evidenceStatusDisplay(c.status).tone} label={c.statusLabel?.trim() || evidenceStatusDisplay(c.status).label} />
          {c.verificationStatus ? (
            <ProovraBadge
              tone={verificationStatusDisplay(c.verificationStatus).tone}
              label={c.verificationStatusLabel?.trim() || verificationStatusDisplay(c.verificationStatus).label}
            />
          ) : null}
        </View>
        <ProovraText variant="h1" weight="bold" style={styles.heroTitle}>
          {c.displayTitle?.trim() || c.originalFileName?.trim() || evidenceTypeLabel(c.type)}
        </ProovraText>
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
          {[evidenceTypeLabel(c.type), c.createdAt ? `Created ${formatUserDateTime(c.createdAt)}` : null].filter(Boolean).join(" · ")}
        </ProovraText>
      </ProovraCard>

      <View style={styles.tabs}>
        {TABS.map((tb) => {
          const active = tb.key === tab;
          return (
            <Pressable
              key={tb.key}
              onPress={() => setTab(tb.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={[styles.tab, { borderColor: active ? theme.color.accent.a500 : theme.color.border.default, backgroundColor: active ? theme.color.accent.a050 : "transparent" }]}
            >
              <ProovraText variant="label" weight="semibold" color={active ? theme.color.accent.a600 : theme.color.ink.secondary}>
                {tb.label}
              </ProovraText>
            </Pressable>
          );
        })}
      </View>

      {tab === "overview" ? (
        <ProovraSection>
          <ProovraCard>
            <Row k="Type" v={evidenceTypeLabel(c.type)} />
            <Row k="Status" v={c.statusLabel?.trim() || evidenceStatusDisplay(c.status).label} />
            {c.verificationStatus ? (
              <Row k="Verification" v={c.verificationStatusLabel?.trim() || verificationStatusDisplay(c.verificationStatus).label} />
            ) : null}
            <Row k="Created" v={c.createdAt ? formatUserDateTime(c.createdAt) : "—"} />
            {parts.length > 0 ? <Row k="Parts" v={String(parts.length)} /> : null}
          </ProovraCard>
          <View style={styles.actions}>
            <ProovraButton label="Lock" variant="secondary" loading={actionBusy} onPress={() => runAction("Lock", { path: "lock" })} />
            <ProovraButton label="Archive" variant="secondary" loading={actionBusy} onPress={() => runAction("Archive", { path: "archive" })} />
            <ProovraButton label="Move to Trash" variant="danger" loading={actionBusy} onPress={() => runAction("Move to Trash", { method: "DELETE", destructive: true })} />
          </View>
        </ProovraSection>
      ) : null}

      {tab === "integrity" ? (
        <ProovraSection title="Integrity">
          <ProovraCard>
            <Row k="SHA-256" v={c.fileSha256 ?? "—"} mono />
            <Row k="Ed25519 fingerprint" v={c.fingerprintHash ?? "—"} mono />
            {integrity ? <Row k="Sealed" v={integrity.sealed ? "Yes" : "See record"} /> : null}
            {publicVerification ? <Row k="Public verification" v={publicVerification.state ? String(publicVerification.state) : "—"} /> : null}
          </ProovraCard>
          <ProovraText variant="label" color={theme.color.ink.muted} style={styles.note}>
            Integrity is computed and sealed by the server; this view reflects that record, it does not recompute it.
          </ProovraText>
        </ProovraSection>
      ) : null}

      {tab === "custody" ? (
        <ProovraSection title="Custody & access">
          {parts.length === 0 && !rw ? (
            <ProovraEmptyState title="Custody detail unavailable" message="Open this record on the web app for the full custody timeline." />
          ) : (
            <ProovraCard>
              <Row k="Parts sealed" v={String(parts.length)} />
              <ProovraText variant="label" color={theme.color.ink.muted} style={styles.note}>
                The full forensic custody and access-history timeline is available on the web app.
              </ProovraText>
            </ProovraCard>
          )}
        </ProovraSection>
      ) : null}

      {tab === "artifacts" ? (
        <ProovraSection title="Report & artifacts">
          {reportState === "READY" && reportUrl ? (
            <ProovraButton label="Download report" onPress={() => void Linking.openURL(reportUrl)} />
          ) : (
            <ProovraCard>
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                {reportStateMessage(reportState)}
              </ProovraText>
            </ProovraCard>
          )}
        </ProovraSection>
      ) : null}
    </ProovraScreen>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <View style={styles.detailRow}>
      <ProovraText variant="label" color={theme.color.ink.muted}>
        {k}
      </ProovraText>
      <ProovraText variant="bodySm" mono={mono} numberOfLines={mono ? 2 : 1} style={styles.detailValue}>
        {v}
      </ProovraText>
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", marginTop: theme.space.s2 },
  hero: { marginBottom: theme.space.s4 },
  badgeRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 },
  heroTitle: { marginTop: theme.space.s2 },
  tabs: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginBottom: theme.space.s4 },
  tab: { paddingHorizontal: theme.space.s3, paddingVertical: theme.space.s2, borderRadius: theme.radius.pill, borderWidth: 1, minHeight: 36, justifyContent: "center" },
  detailRow: { paddingVertical: theme.space.s2, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.border.subtle, gap: 2 },
  detailValue: { marginTop: 2 },
  actions: { marginTop: theme.space.s4, gap: theme.space.s2 },
  note: { marginTop: theme.space.s3 },
});
