/**
 * HOME — the native port of the canonical PROOVRA Home
 * (`apps/web/components/home-experience/SelfServeHomeDashboard.tsx`).
 *
 * TWO THINGS CHANGED HERE, and they are related.
 *
 * 1. Home read TWO sources (`trust-summary`, `evidence`) where the web reads
 *    seven. It was not under-styled — it was data-starved, and no amount of
 *    layout work could have filled it. It now reads the canonical set and
 *    renders the web's overview composition: the one-state summary band, the
 *    five KPIs, the priority queue, and recent work.
 *
 * 2. The hero carried "Direct Screen Capture" / "Continuous Screen Capture"
 *    buttons — UC-2/UC-3/UC-5 promoted to the landing page as a native
 *    capability launcher. Home is the canonical PROOVRA Home, not a list of
 *    things this platform can do; those are ACQUISITION SOURCES and they now
 *    live in Capture's source chooser, which is where a user picks how to
 *    record something.
 *
 * The web's other three tabs (Operations / Analytics / Activity) are analytics
 * surfaces; their native disposition is recorded in the ledger rather than
 * silently dropped.
 */
import { View, StyleSheet } from "react-native";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { useLocale } from "../../src/locale-context";
import { apiFetch } from "../../src/api";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { formatUserDateTime } from "../../src/lib/date";
import { usePlatformContext } from "../../src/product/platform-context";
import { theme } from "../../src/theme/theme";
import {
  ProovraShell,
  ProovraCard,
  ProovraSection,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraListRow,
  ProovraEmptyState,
  ProovraErrorState,
  ProovraLoadingState,
  ProovraKpiGrid,
  ProovraEmpty,
} from "../../src/ui";
import { evidenceStatusDisplay, evidenceTypeLabel } from "../../src/product/domain-display";
import {
  buildHomeKpis,
  buildHomePriorities,
  buildHomeSummary,
  buildHomeStorage,
  type HomeSources,
} from "../../src/product/home-dashboard";

type EvidenceItem = {
  id: string;
  type: string;
  status: string;
  createdAt: string;
  title?: string;
  statusLabel?: string;
  displayTitle?: string;
  displaySubtitle?: string;
};

type CaseItem = { id: string; title?: string; name?: string; status?: string };

type LoadState = "loading" | "ready" | "error";

export default function HomeScreen() {
  const { t } = useLocale();
  const router = useRouter();
  const platform = usePlatformContext();
  const teamId = platform.context?.activeTeamId ?? null;

  const [items, setItems] = useState<EvidenceItem[]>([]);
  const [cases, setCases] = useState<CaseItem[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<SafeError | null>(null);
  const [sources, setSources] = useState<HomeSources>({});

  /**
   * The canonical Home reads, settled together.
   *
   * `allSettled`, and each source optional: the web treats every module as
   * independently degradable, and one unavailable dashboard read must not blank
   * the page. Recent evidence is the one read that decides the page's own
   * loading/error state, because it is the content a user came for.
   */
  const load = useCallback(async () => {
    setState("loading");
    setError(null);
    const scoped = (path: string) =>
      teamId ? `${path}${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(teamId)}` : path;

    const [evidence, commandCenter, trustSummary, billing, reports, intake, inbox, caseList] =
      await Promise.allSettled([
        apiFetch("/v1/evidence?scope=active&limit=5"),
        teamId ? apiFetch(scoped("/v1/dashboard/command-center")) : Promise.resolve(null),
        teamId ? apiFetch(scoped("/v1/dashboard/trust-summary")) : Promise.resolve(null),
        apiFetch("/v1/billing/overview"),
        teamId ? apiFetch(scoped("/v1/reports")) : Promise.resolve(null),
        teamId ? apiFetch(scoped("/v1/workflow/intake-links")) : Promise.resolve(null),
        apiFetch("/v1/me/inbox?pageSize=50"),
        apiFetch("/v1/cases?limit=5"),
      ]);

    const ok = <T,>(r: PromiseSettledResult<T>): T | undefined =>
      r.status === "fulfilled" ? r.value : undefined;

    setSources({
      commandCenter: ok(commandCenter),
      trustSummary: ok(trustSummary),
      billingOverview: ok(billing),
      reports: ok(reports),
      intakeLinks: ok(intake),
      inbox: ok(inbox),
    });

    const caseRows = ok(caseList) as { items?: CaseItem[]; cases?: CaseItem[] } | undefined;
    setCases(caseRows?.items ?? caseRows?.cases ?? []);

    if (evidence.status === "rejected") {
      setError(toSafeUserError(evidence.reason));
      setState("error");
      return;
    }
    const payload = evidence.value as { items?: EvidenceItem[] } | undefined;
    setItems(payload?.items ?? []);
    setState("ready");
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  const priorities = buildHomePriorities(sources);
  const summary = buildHomeSummary(sources, priorities);
  const kpis = buildHomeKpis(sources);
  const storage = buildHomeStorage(sources);

  return (
    <ProovraShell>
      <ProovraCard
        style={styles.searchBar}
        onPress={() => router.push("/search")}
        accessibilityLabel="Search evidence and cases"
      >
        <ProovraText variant="body" color={theme.color.ink.muted}>
          Search evidence, cases…
        </ProovraText>
      </ProovraCard>

      {/* Executive summary band — one state, one sentence, one action. */}
      <ProovraCard style={styles.summary} accessibilityLabel={`${summary.state}. ${summary.sentence}`}>
        <View style={styles.summaryHead}>
          <ProovraBadge label={summary.state} tone={summary.tone} />
          <ProovraButton
            label={t("ctaCapture")}
            fullWidth={false}
            onPress={() => router.push("/capture")}
          />
        </View>
        <ProovraText variant="body" color={theme.color.ink.secondary}>
          {summary.sentence}
        </ProovraText>
      </ProovraCard>

      {/* The five canonical KPIs. */}
      <ProovraKpiGrid
        items={kpis.map((k) => ({
          key: k.key,
          label: k.label,
          value: k.value,
          caption: k.subtitle,
          tone: k.tone,
          onPress: () => router.push(k.href as never),
        }))}
      />

      {/* What needs you now — ranked by severity, not by arrival. */}
      <ProovraSection title="What needs you now">
        {priorities.length === 0 ? (
          <ProovraEmpty
            presence="inline"
            title="Nothing is waiting on you"
            purpose="Submissions, reviews and alerts appear here."
          />
        ) : (
          <ProovraCard>
            {priorities.slice(0, 6).map((p) => (
              <ProovraListRow
                key={p.id}
                title={p.label}
                subtitle={p.detail ?? undefined}
                trailing={<ProovraBadge label={p.tone === "risk" ? "Urgent" : "Open"} tone={p.tone} />}
                onPress={p.href ? () => router.push(p.href as never) : undefined}
              />
            ))}
          </ProovraCard>
        )}
      </ProovraSection>

      {/* Your recent work — the latest captures and the matters in progress. */}
      <ProovraSection title={t("recentEvidence")}>
        {state === "loading" ? (
          <ProovraLoadingState label={t("recentEvidence")} />
        ) : state === "error" && error ? (
          <ProovraErrorState message={error.message} onRetry={load} />
        ) : items.length === 0 ? (
          <ProovraEmptyState
            title="No evidence yet"
            message="Capture your first record to see it here."
            action={
              <ProovraButton
                label={t("ctaCapture")}
                fullWidth={false}
                onPress={() => router.push("/capture")}
              />
            }
          />
        ) : (
          <ProovraCard>
            {items.map((item) => {
              const status = evidenceStatusDisplay(item.status);
              return (
                <ProovraListRow
                  key={item.id}
                  title={item.displayTitle?.trim() || item.title?.trim() || evidenceTypeLabel(item.type)}
                  subtitle={
                    item.displaySubtitle?.trim() ||
                    `${evidenceTypeLabel(item.type)} · ${formatUserDateTime(item.createdAt)}`
                  }
                  trailing={<ProovraBadge tone={status.tone} label={item.statusLabel?.trim() || status.label} />}
                  onPress={() => router.push(`/evidence/${item.id}`)}
                />
              );
            })}
          </ProovraCard>
        )}
      </ProovraSection>

      <ProovraSection title="Active matters">
        {cases.length === 0 ? (
          <ProovraEmpty
            presence="inline"
            title="No open matters"
            purpose="Group related evidence into a case to track it."
          />
        ) : (
          <ProovraCard>
            {cases.slice(0, 5).map((c) => (
              <ProovraListRow
                key={c.id}
                title={c.title?.trim() || c.name?.trim() || "Untitled matter"}
                subtitle={c.status ?? undefined}
                onPress={() => router.push(`/case/${c.id}`)}
              />
            ))}
          </ProovraCard>
        )}
      </ProovraSection>

      {storage ? (
        <ProovraSection title="Storage">
          <ProovraCard>
            <ProovraText variant="bodySm">
              {storage.usedLabel} of {storage.limitLabel} used
            </ProovraText>
          </ProovraCard>
        </ProovraSection>
      ) : null}
    </ProovraShell>
  );
}

const styles = StyleSheet.create({
  searchBar: { marginBottom: theme.space.s3 },
  summary: { gap: theme.space.s2, marginBottom: theme.space.s3 },
  summaryHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space.s3 },
});
