/**
 * HOME — the native port of the canonical PROOVRA Home
 * (`apps/web/components/home-experience/SelfServeHomeDashboard.tsx`).
 *
 * The web page, in its order:
 *   header      greeting + one neutral CTA (Capture evidence / All evidence)
 *   tabs        "Workspace views": Overview / Operations / Analytics
 *   Overview    executive summary band, five KPIs, "What needs you now"
 *               (workspace health + priorities, or getting started) and
 *               "Your recent work" (recent evidence + active matters)
 *   Operations  "Verification & production": public verification links,
 *               verification summary, report production, intake status
 *   Analytics   "Workspace analytics": records by type, evidence activity,
 *               recent activity; Team work (organization workspaces)
 *
 * The enterprise CommandCenter branch of /home is ENTERPRISE_ONLY
 * (apps/web/app/(app)/home/page.tsx:3-21, resolveHomeSurface) and is not
 * ported.
 *
 * The screen-capture launchers that once sat in the hero are ACQUISITION
 * SOURCES and live in Capture's source chooser, not on Home.
 */
import { View } from "react-native";
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
  ProovraErrorState,
  ProovraLoadingState,
  ProovraKpiGrid,
  ProovraFilterChips,
} from "../../src/ui";
import { evidenceStatusDisplay, evidenceTypeLabel } from "../../src/product/domain-display";
import {
  buildCaseHealthSummary,
  buildHomeKpis,
  buildHomeStorage,
  buildHomeSummary,
  buildOperationsVerdict,
  buildReportProduction,
  buildWorkspacePriorities,
  homeEvidenceCount,
  homeGreeting,
  homeHeaderCta,
  parsePipeline,
  parseTrustState,
  shouldShowGettingStarted,
  type HomeSources,
} from "../../src/product/home-dashboard";
import { HomeAnalyticsSections } from "../../src/ui/home-operations-sections";
import { buildActiveMatters, buildRecentReports, buildTeamWork, buildVerificationHealth } from "../../src/product/home-sections";
import { HomeActiveMattersSection, HomeTeamWorkSection, HomeVerificationHealthSection } from "../../src/ui/home-sections";
import {
  HomeGettingStartedCard,
  HomeHeaderBlock,
  HomePrioritiesCard,
  HomeRecentEvidenceCard,
  HomeReportProductionCard,
  HomeSummaryBand,
  HomeTrustStateCard,
  HomeWorkspaceHealthCard,
} from "../../src/ui/home-overview";
import { HomeIntakePipelineCard } from "../../src/ui/home-intake-pipeline";
import { HOME_INTAKE_MESSAGES_PATH, buildIntakePipeline } from "../../src/product/home-intake";
import {
  RECORDS_BY_TYPE_PATH,
  buildActivityGroups,
  buildActivitySeries,
  buildActivitySeriesByRange,
  buildWorkspaceHealth,
  parseRecordsByType,
  parsePreservedFilesByType,
  type TypeDistribution,
} from "../../src/product/home-operations";

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

type LoadState = "loading" | "ready" | "error";
type HomeTabId = "overview" | "operations" | "analytics";

/** web SelfServeHomeDashboard HOME_TABS. */
const HOME_TABS: ReadonlyArray<{ value: HomeTabId; label: string }> = [
  { value: "overview", label: "Overview" },
  { value: "operations", label: "Operations" },
  { value: "analytics", label: "Analytics" },
];

/** What each source is called when we have to name it to a person. */
const SOURCE_LABELS: Record<string, string> = {
  commandCenter: "Workspace summary",
  trustSummary: "Evidence integrity",
  billing: "Plan usage",
  reports: "Reports",
  intakeLinks: "Intake links",
  intakeMessages: "Intake deliveries",
  inbox: "Inbox",
  recordsByType: "Records by type",
  series: "Recent activity",
  opsSummary: "Operations status",
};

export default function HomeScreen() {
  const { t } = useLocale();
  const router = useRouter();
  const platform = usePlatformContext();
  const teamId = platform.context?.activeTeamId ?? null;

  const [tab, setTab] = useState<HomeTabId>("overview");
  const [items, setItems] = useState<EvidenceItem[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<SafeError | null>(null);
  const [sources, setSources] = useState<HomeSources>({});
  /*
   * WHY A FIGURE IS MISSING. `Promise.allSettled` rejections are kept so the
   * screen can name them: a 401, a 403, a 500 and a dropped connection must
   * not all arrive at a tile as the same silence (measured on a physical iPad,
   * 2026-09-24). Values are still never invented.
   */
  const [failed, setFailed] = useState<Record<string, SafeError>>({});
  const [distribution, setDistribution] = useState<TypeDistribution | null>(null);
  const [filesDistribution, setFilesDistribution] = useState<TypeDistribution | null>(null);
  /**
   * A WIDER evidence page, for the activity series and the KPI 7-day delta.
   * A fourteen-day chart drawn from five rows would be a picture of the list.
   */
  const [seriesSource, setSeriesSource] = useState<{
    createdAtIsoList: Array<string | null>;
    hasMore: boolean;
  } | null>(null);

  /**
   * The canonical Home reads, settled together. Each source is independently
   * degradable; recent evidence alone decides the page's own loading/error
   * state, because it is the content a user came for.
   */
  const load = useCallback(async () => {
    setState("loading");
    setError(null);
    const scoped = (path: string) =>
      teamId ? `${path}${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(teamId)}` : path;

    const [
      evidence,
      commandCenter,
      trustSummary,
      billing,
      reports,
      intake,
      inbox,
      recordsByType,
      seriesPage,
      intakeMessages,
      opsSummary,
    ] = await Promise.allSettled([
      apiFetch("/v1/evidence?scope=active&limit=5"),
      teamId ? apiFetch(scoped("/v1/dashboard/command-center")) : Promise.resolve(null),
      teamId ? apiFetch(scoped("/v1/dashboard/trust-summary")) : Promise.resolve(null),
      apiFetch("/v1/billing/overview"),
      teamId ? apiFetch(scoped("/v1/reports")) : Promise.resolve(null),
      teamId ? apiFetch(scoped("/v1/workflow/intake-links")) : Promise.resolve(null),
      apiFetch("/v1/me/inbox?pageSize=50"),
      // The SERVER's aggregate over every active record in scope.
      teamId ? apiFetch(scoped(RECORDS_BY_TYPE_PATH)) : Promise.resolve(null),
      apiFetch("/v1/evidence?scope=active&limit=200"),
      // Latest delivery per intake link, for the Intake status card.
      teamId ? apiFetch(scoped(HOME_INTAKE_MESSAGES_PATH)) : Promise.resolve(null),
      // THE canonical workspace Operations summary: may Home say "All clear"?
      // (useHomeData.ts:185-195; ops.routes.ts:883 answers { summary, workspace }).
      teamId ? apiFetch(`/v1/ops/summary?teamId=${encodeURIComponent(teamId)}`) : Promise.resolve(null),
    ]);

    const problems: Record<string, SafeError> = {};
    /** Unwrap a settled result, RECORDING a rejection rather than erasing it. */
    const ok = <T,>(r: PromiseSettledResult<T>, key: string): T | undefined => {
      if (r.status === "fulfilled") return r.value;
      problems[key] = toSafeUserError(r.reason);
      return undefined;
    };

    const page = ok(seriesPage, "series") as
      | { items?: Array<{ createdAt?: string | null }>; nextCursor?: string | null }
      | undefined;
    const ops = ok(opsSummary, "opsSummary") as { summary?: unknown } | null | undefined;

    setSources({
      commandCenter: ok(commandCenter, "commandCenter"),
      trustSummary: ok(trustSummary, "trustSummary"),
      billingOverview: ok(billing, "billing"),
      reports: ok(reports, "reports"),
      intakeLinks: ok(intake, "intakeLinks"),
      intakeMessages: ok(intakeMessages, "intakeMessages"),
      inbox: ok(inbox, "inbox"),
      recentEvidence: page,
      opsSummary: ops?.summary ?? undefined,
    });

    setFailed(problems);

    const byType = ok(recordsByType, "recordsByType");
    setDistribution(byType ? parseRecordsByType(byType) : null);
    setFilesDistribution(byType ? parsePreservedFilesByType(byType) : null);

    setSeriesSource(
      page
        ? {
            createdAtIsoList: (page.items ?? []).map((i) => i.createdAt ?? null),
            // The cursor is the server saying there is more — the series is a sample.
            hasMore: typeof page.nextCursor === "string" && page.nextCursor.length > 0,
          }
        : null,
    );

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

  /*
   * With no active workspace the scoped requests are never SENT. That is a
   * third state, and it used to look exactly like an empty workspace.
   */
  const noWorkspace = teamId === null;
  const loadFailures = Object.entries(failed).map(([key, err]) => `${SOURCE_LABELS[key] ?? key}: ${err.message}`);
  const failureSentence = loadFailures.length > 0 ? `Some figures could not be loaded. ${loadFailures.join(" ")}` : "";

  // Server-projected plan features (fail-closed), as the web reads vm.features.
  const envelope = (platform.envelope ?? null) as {
    planFeatures?: Record<string, unknown>;
    user?: { firstName?: string | null; displayName?: string | null };
  } | null;
  const intakeIncluded = envelope?.planFeatures?.["intakeIncluded"] === true;
  const reportsIncluded = envelope?.planFeatures?.["reportsIncluded"] !== false;

  const trust = parseTrustState(sources.trustSummary);
  const pipeline = parsePipeline(sources.commandCenter);
  const storage = buildHomeStorage(sources);
  const recentReports = buildRecentReports(sources.reports);
  const reportCaseIds = new Set(
    ((sources.reports as { items?: Array<{ caseId?: string | null; report?: { available?: boolean } }> } | undefined)?.items ?? [])
      .filter((r) => r.report?.available && r.caseId)
      .map((r) => String(r.caseId)),
  );
  const matters = buildActiveMatters(sources.commandCenter, reportCaseIds);
  const caseHealth = buildCaseHealthSummary(sources.commandCenter);
  const production = buildReportProduction(pipeline, sources.reports ? recentReports : null);
  const intakePipeline = buildIntakePipeline({
    intakeLinks: sources.intakeLinks,
    communications: sources.intakeMessages,
    inbox: sources.inbox,
    workspaceId: teamId,
  });
  const intakeStats = intakePipeline
    ? {
        activeLinks: intakePipeline.stages.find((s) => s.key === "active")?.count ?? 0,
        failedDeliveries: intakePipeline.stages.find((s) => s.key === "failed")?.count ?? 0,
      }
    : null;
  const activeLinks =
    sources.intakeLinks === undefined || sources.intakeLinks === null
      ? null
      : // GET /v1/workflow/intake-links answers { links } (workflow-intake-links.routes.ts:646).
        (intakeStats?.activeLinks ??
        ((sources.intakeLinks as { links?: Array<{ status?: string }> }).links ?? []).filter((l) => l?.status === "ACTIVE").length);

  const priorities = buildWorkspacePriorities({
    trust,
    pipeline,
    reportCount: sources.reports ? ((sources.reports as { items?: unknown[] }).items ?? []).length : 0,
    mattersNeedingWork: matters.rows.filter((m) => m.verdict !== "healthy").length,
    reportsReady: production.reportsReady,
    storage,
    intakeIncluded,
    activeLinks,
  });
  const verdict = buildOperationsVerdict(sources.opsSummary, state === "loading");
  const evidenceCount = homeEvidenceCount(pipeline, trust, state === "ready" ? items.length : null);
  const showGettingStarted = shouldShowGettingStarted({
    evidenceCount,
    reportCount: sources.reports ? ((sources.reports as { items?: unknown[] }).items ?? []).length : null,
    caseCount: matters.activeCasesCount,
    verifyPublished: trust?.verifyPublished ?? null,
  });
  const summary = buildHomeSummary({ sources, trust, priorities, production, storage, showGettingStarted });
  const kpis = buildHomeKpis(sources, { intakeIncluded, intakeStats });
  const verificationHealth = buildVerificationHealth(sources.trustSummary, { commandCenter: sources.commandCenter, recentReports });
  const teamWork = buildTeamWork({ envelope: platform.envelope, trustSummary: sources.trustSummary, reports: sources.reports, nowMs: Date.now() });

  const firstName =
    envelope?.user?.firstName?.trim() || envelope?.user?.displayName?.trim().split(/\s+/)[0] || null;
  // web pickHeroAction: capture_first is the fall-through for a workspace with no evidence and no other work.
  const captureFirst =
    evidenceCount === 0 && (trust?.submissionsAwaitingReview ?? 0) === 0 && matters.rows.every((m) => m.verdict === "healthy");

  const health = buildWorkspaceHealth({
    commandCenter: sources.commandCenter,
    trustSummary: sources.trustSummary,
    reports: sources.reports,
    inbox: sources.inbox,
    // The server's count for the active workspace; null means unknown ("—").
    activeCases: matters.activeCasesCount,
    storageLabel: storage ? `${storage.usedLabel} of ${storage.limitLabel}` : null,
    // Null stays null: a plan with no published limit is not a plan that is 0% full.
    storagePercent: storage && storage.fraction !== null ? Math.round(storage.fraction * 100) : null,
  });

  const series = seriesSource ? buildActivitySeries(seriesSource) : null;
  const seriesByRange = seriesSource ? buildActivitySeriesByRange(seriesSource) : null;
  const activity = buildActivityGroups({
    recentEvidence: { items },
    reports: sources.reports,
    intakeLinks: sources.intakeLinks,
    commandCenter: sources.commandCenter,
    communications: sources.intakeMessages,
    inbox: sources.inbox,
  });

  const recentRows = items.map((item) => {
    const status = evidenceStatusDisplay(item.status);
    return {
      id: item.id,
      title: item.displayTitle?.trim() || item.title?.trim() || evidenceTypeLabel(item.type),
      subtitle: item.displaySubtitle?.trim() || `${evidenceTypeLabel(item.type)} · ${formatUserDateTime(item.createdAt)}`,
      statusLabel: item.statusLabel?.trim() || status.label,
      statusTone: status.tone,
    };
  });

  return (
    <ProovraShell>
      {/*
        Search lives in the shell header (`src/ui/header.tsx`) on every
        surface, as the web's AppAccountToolbar does — Home carries no search
        card of its own.
      */}
      <HomeHeaderBlock greeting={homeGreeting(new Date().getHours(), firstName)} cta={homeHeaderCta(captureFirst)} />

      {/* WHY figures are missing — shown above the content, never instead of it. */}
      {noWorkspace ? (
        <ProovraCard>
          <ProovraText variant="body" color={theme.color.ink.secondary}>
            No workspace is selected, so six of the figures below are not
            requested at all. Choose a workspace to see them.
          </ProovraText>
        </ProovraCard>
      ) : null}
      {loadFailures.length > 0 ? (
        <ProovraCard>
          <ProovraText variant="body" color={theme.color.ink.secondary}>
            {failureSentence}
          </ProovraText>
          <ProovraButton label="Try again" fullWidth={false} onPress={load} />
        </ProovraCard>
      ) : null}

      <View style={{ marginBottom: theme.space.s3 }}>
        <ProovraFilterChips<HomeTabId> label="Workspace views" value={tab} onChange={setTab} options={HOME_TABS} />
      </View>

      {tab === "overview" ? (
        <>
          {/* Operational summary band — one state, one sentence, one action. */}
          <HomeSummaryBand summary={summary} />

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

          <ProovraSection title="What needs you now">
            <ProovraText variant="label" color={theme.color.ink.secondary} style={{ marginBottom: theme.space.s2 }}>
              Workspace health and the priorities ranked by severity.
            </ProovraText>
            <HomeWorkspaceHealthCard health={health} />
            {showGettingStarted ? <HomeGettingStartedCard /> : <HomePrioritiesCard priorities={priorities} verdict={verdict} />}
          </ProovraSection>

          <ProovraSection title="Your recent work">
            <ProovraText variant="label" color={theme.color.ink.secondary} style={{ marginBottom: theme.space.s2 }}>
              The latest evidence you captured and the matters in progress.
            </ProovraText>
            <HomeRecentEvidenceCard
              rows={recentRows}
              body={
                state === "loading" ? (
                  <ProovraLoadingState label={t("recentEvidence")} />
                ) : state === "error" && error ? (
                  <ProovraErrorState message={error.message} onRetry={load} />
                ) : undefined
              }
            />
            {state === "ready" && !noWorkspace ? <HomeActiveMattersSection matters={matters} summary={caseHealth} /> : null}
          </ProovraSection>
        </>
      ) : null}

      {tab === "operations" ? (
        <ProovraSection title="Verification & production">
          <ProovraText variant="label" color={theme.color.ink.secondary} style={{ marginBottom: theme.space.s2 }}>
            Trust posture, verification health, report production, and the intake pipeline.
          </ProovraText>
          {verificationHealth ? <HomeVerificationHealthSection health={verificationHealth} /> : null}
          {trust ? <HomeTrustStateCard trust={trust} /> : null}
          <HomeReportProductionCard production={production} recent={recentReports} reportsIncluded={reportsIncluded} />
          {state === "ready" && !noWorkspace && platform.envelope ? (
            <HomeIntakePipelineCard
              pipeline={intakePipeline}
              teamId={teamId}
              locked={!intakeIncluded}
              onChanged={() => void load()}
            />
          ) : null}
        </ProovraSection>
      ) : null}

      {tab === "analytics" ? (
        <>
          <ProovraSection title="Workspace analytics">
            <ProovraText variant="label" color={theme.color.ink.secondary} style={{ marginBottom: theme.space.s2 }}>
              Records by type, evidence activity, and recent activity.
            </ProovraText>
            <HomeAnalyticsSections
              distribution={distribution}
              filesDistribution={filesDistribution}
              series={series}
              seriesByRange={seriesByRange}
              activity={activity}
            />
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
          {teamWork ? <HomeTeamWorkSection team={teamWork} /> : null}
        </>
      ) : null}
    </ProovraShell>
  );
}
