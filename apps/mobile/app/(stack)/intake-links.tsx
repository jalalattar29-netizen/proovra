/**
 * EXTERNAL INTAKE LINKS — the native port of the web management surface
 * (apps/web/app/(app)/intake-links/page.tsx and its _components).
 *
 * GET /v1/workflow/intake-links?teamId&archiveScope=all[&search] lists the
 * workspace's links; tabs (KPI cards), channel, lifecycle, delivery state,
 * sort and paging run over the returned rows exactly as the web's
 * `applyFilters` does. The search term is a SERVER parameter.
 *
 * The intake URL is a server-side secret shown once at creation (see
 * intake-link-create.tsx), so no row offers "copy link".
 *
 * Fail closed, as the web does: no envelope, or an envelope without
 * INTAKE_LINKS_MANAGE, renders the restricted panel; a 503 / FEATURE_DISABLED
 * read renders "Not enabled yet"; a 403 / anti-enumeration 404 is restricted
 * (no retry); anything else is a retryable error.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { apiFetch } from "../../src/api";
import { toSafeUserError } from "../../src/errors/safe-error";
import { usePlatformContext } from "../../src/product/platform-context";
import { BUILT_IN_PURPOSES } from "../../src/product/intake-create";
import {
  DEFAULT_INTAKE_FILTERS,
  DISABLE_LINK_COPY,
  INTAKE_LINKS_COPY as COPY,
  INTAKE_REVEAL_CONSEQUENCE,
  applyIntakeFilters,
  buildIntakeArchivePath,
  buildIntakeListPath,
  buildIntakeRevealPath,
  buildIntakeSubmissionsPath,
  canDisableLink,
  classifyIntakeListFailure,
  computeIntakeKpis,
  intakeFiltersActive,
  linkHasSessions,
  parseIntakeLinks,
  parseIntakeSubmissions,
  parseRevealedContact,
  type IntakeFilterState,
  type IntakeLinkItem,
  type IntakeSubmission,
  type IntakeTab,
  type RevealedContact,
} from "../../src/product/intake-links";
import { theme } from "../../src/theme/theme";
import { IntakeDeliveryHistory } from "../../src/ui/intake-delivery-history";
import { IntakeLinkDetails } from "../../src/ui/intake-link-details";
import {
  IntakeLinkRecord,
  IntakeLinkSubmissionsList,
  IntakeLinksEmpty,
  IntakeLinksKpis,
  IntakeLinksMutationError,
  IntakeLinksPager,
  IntakeLinksRefreshing,
  IntakeLinksStateCard,
  IntakeLinksToolbar,
} from "../../src/ui/intake-links-console";
import {
  ProovraButton,
  ProovraCard,
  ProovraErrorState,
  ProovraFormField,
  ProovraInput,
  ProovraLoadingState,
  ProovraScreen,
  ProovraText,
} from "../../src/ui";
import { ProovraConfirmSheet, ProovraPageHeader, ProovraSheet } from "../../src/ui/patterns";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; items: IntakeLinkItem[] }
  | { kind: "error"; message: string; requestId: string | null }
  | { kind: "restricted"; reason: "forbidden" | "no_envelope" }
  | { kind: "feature_disabled" };

const NO_ITEMS: IntakeLinkItem[] = [];

export default function IntakeLinksScreen() {
  const router = useRouter();
  const { loading: ctxLoading, context, envelope } = usePlatformContext();
  // page.tsx:115 useCan("INTAKE_LINKS_MANAGE") — envelope.capabilities[key] === true.
  const canManage =
    (envelope as { capabilities?: Record<string, unknown> } | null)?.capabilities?.["INTAKE_LINKS_MANAGE"] === true;
  const teamId = context?.activeTeamId ?? null;
  const teamName = context?.activeSpaceType === "PERSONAL" ? COPY.personalSpace : (context?.displayName ?? "Workspace");

  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [mutationError, setMutationError] = useState<{ action: string; message: string } | null>(null);

  // Search is a SERVER parameter (debounced); everything else filters the rows in hand.
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  useEffect(() => {
    const h = setTimeout(() => setAppliedSearch(search.trim()), 300);
    return () => clearTimeout(h);
  }, [search]);
  const [filters, setFilters] = useState<IntakeFilterState>(DEFAULT_INTAKE_FILTERS);

  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [deliveryFor, setDeliveryFor] = useState<string | null>(null);
  const [submissionsFor, setSubmissionsFor] = useState<string | null>(null);
  const [disableFor, setDisableFor] = useState<IntakeLinkItem | null>(null);
  const [disableBusy, setDisableBusy] = useState(false);
  const [archivePendingId, setArchivePendingId] = useState<string | null>(null);
  // null is LOADING. A failure carries its reason: "no submissions" and "we could not read them" differ.
  const [submissions, setSubmissions] = useState<IntakeSubmission[] | null>(null);
  const [submissionsError, setSubmissionsError] = useState<string | null>(null);
  const [revealing, setRevealing] = useState<IntakeLinkItem | null>(null);
  const [revealReason, setRevealReason] = useState("");
  const [revealBusy, setRevealBusy] = useState(false);
  const [revealed, setRevealed] = useState<RevealedContact | null>(null);

  // Home's Intake status rows open a link's delivery history here (?linkId=); ?new=1 opens creation (page.tsx:295-307).
  const params = useLocalSearchParams<{ linkId?: string; new?: string }>();
  const deepLinkApplied = useRef(false);
  useEffect(() => {
    if (deepLinkApplied.current) return;
    if (params.new === "1") {
      deepLinkApplied.current = true;
      router.push("/intake-link-create");
      return;
    }
    if (typeof params.linkId === "string" && params.linkId.length > 0) {
      deepLinkApplied.current = true;
      setDeliveryFor(params.linkId);
    }
  }, [params.new, params.linkId, router]);

  // Fail closed BEFORE any read (page.tsx:417-421).
  const restricted: LoadState | null = ctxLoading
    ? null
    : !envelope || !teamId
      ? { kind: "restricted", reason: "no_envelope" }
      : !canManage
        ? { kind: "restricted", reason: "forbidden" }
        : null;

  const fetchLinks = useCallback(
    async (mode: "initial" | "refresh", term: string) => {
      if (!teamId) return;
      if (mode === "refresh") setRefreshing(true);
      else setLoad({ kind: "loading" });
      try {
        const data = await apiFetch(buildIntakeListPath(teamId, term));
        setLoad({ kind: "ready", items: parseIntakeLinks(data) });
      } catch (err) {
        const safe = toSafeUserError(err, { message: COPY.errorFallback });
        const kind = classifyIntakeListFailure(safe);
        if (kind === "feature_disabled") setLoad({ kind: "feature_disabled" });
        else if (kind === "restricted") setLoad({ kind: "restricted", reason: "forbidden" });
        else setLoad({ kind: "error", message: safe.message, requestId: safe.requestId ?? null });
      } finally {
        setRefreshing(false);
      }
    },
    [teamId],
  );

  // The first read for a workspace replaces the rows; a new search term refreshes them in place.
  const loadedFor = useRef<string | null>(null);
  const termRef = useRef(appliedSearch);
  termRef.current = appliedSearch;
  useEffect(() => {
    if (ctxLoading || restricted || !teamId) return;
    if (loadedFor.current !== teamId) {
      loadedFor.current = teamId;
      void fetchLinks("initial", termRef.current);
    }
  }, [ctxLoading, restricted, teamId, fetchLinks]);
  const searchedFor = useRef("");
  useEffect(() => {
    if (!teamId || loadedFor.current !== teamId) return;
    if (appliedSearch === searchedFor.current) return;
    searchedFor.current = appliedSearch;
    void fetchLinks("refresh", appliedSearch);
  }, [appliedSearch, teamId, fetchLinks]);

  const refresh = useCallback(() => fetchLinks("refresh", termRef.current), [fetchLinks]);

  const patchFilters = useCallback((patch: Partial<IntakeFilterState>) => {
    setFilters((prev) => {
      const resetsPage = "tab" in patch || "channel" in patch || "lifecycle" in patch || "delivery" in patch || "pageSize" in patch;
      return { ...prev, ...patch, ...(resetsPage ? { page: 1 } : {}) };
    });
  }, []);
  const clearFilters = useCallback(() => {
    setSearch("");
    setAppliedSearch("");
    setFilters(DEFAULT_INTAKE_FILTERS);
  }, []);
  // A KPI is a whole view: it clears the secondary filters (page.tsx:265-270).
  const selectKpi = useCallback((tab: IntakeTab) => patchFilters({ tab, channel: "", lifecycle: "", delivery: "" }), [patchFilters]);

  /** Submissions for one link. The retry in the sheet uses this too. */
  const loadSubmissions = useCallback(async (linkId: string) => {
    setSubmissions(null);
    setSubmissionsError(null);
    try {
      setSubmissions(parseIntakeSubmissions(await apiFetch(buildIntakeSubmissionsPath(linkId))));
    } catch (err) {
      // A refusal, a transport failure, or an envelope this build cannot read.
      setSubmissionsError(toSafeUserError(err, { message: COPY.submissionsLoadFailed }).message);
      setSubmissions([]);
    }
  }, []);
  const openSubmissions = useCallback(
    (id: string) => {
      setDetailsId(null);
      setSubmissionsFor(id);
      void loadSubmissions(id);
    },
    [loadSubmissions],
  );

  const archiveLink = useCallback(
    async (item: IntakeLinkItem) => {
      if (archivePendingId) return;
      const archived = item.archived;
      setArchivePendingId(item.id);
      setMutationError(null);
      try {
        await apiFetch(buildIntakeArchivePath(item.id, archived), { method: "POST" });
        await refresh();
      } catch (err) {
        setMutationError({
          action: archived ? "Couldn't restore that link from the archive." : "Couldn't archive that link.",
          message: toSafeUserError(err, { message: COPY.mutationRetry }).message,
        });
      } finally {
        setArchivePendingId(null);
      }
    },
    [archivePendingId, refresh],
  );

  const confirmDisable = useCallback(async () => {
    const item = disableFor;
    if (!item) return;
    setDisableBusy(true);
    setMutationError(null);
    try {
      await apiFetch(`/v1/workflow/intake-links/${encodeURIComponent(item.id)}/revoke`, {
        method: "POST",
        body: JSON.stringify({ reason: null }),
      });
      await refresh();
    } catch (err) {
      setMutationError({ action: "Couldn't disable that link.", message: toSafeUserError(err, { message: COPY.mutationRetry }).message });
    } finally {
      setDisableBusy(false);
      setDisableFor(null);
    }
  }, [disableFor, refresh]);

  /**
   * The ONE audited disclosure. Every projection ships the masked address;
   * this asks for the raw one, needs a capability, and is recorded at WARNING
   * severity with the reason. The user is told that before they tap.
   */
  const reveal = useCallback(async () => {
    const item = revealing;
    if (!item) return;
    setRevealBusy(true);
    try {
      const res = await apiFetch(buildIntakeRevealPath(item.id), {
        method: "POST",
        body: JSON.stringify({ reason: revealReason.trim() }),
      });
      setRevealed(parseRevealedContact(res));
    } catch (err) {
      setRevealing(null);
      setRevealReason("");
      setMutationError({ action: "Couldn't reveal the recipient contact.", message: toSafeUserError(err).message });
    } finally {
      setRevealBusy(false);
    }
  }, [revealing, revealReason]);
  const closeReveal = () => {
    setRevealing(null);
    setRevealReason("");
    setRevealed(null);
  };

  const effective: LoadState = ctxLoading ? { kind: "loading" } : (restricted ?? load);
  const items = effective.kind === "ready" ? effective.items : NO_ITEMS;
  const kpis = useMemo(() => computeIntakeKpis(items), [items]);
  const result = useMemo(() => applyIntakeFilters(items, filters), [items, filters]);
  const filtersActive = intakeFiltersActive(search, filters);
  const detailsItem = detailsId ? (items.find((i) => i.id === detailsId) ?? null) : null;
  const submissionsItem = submissionsFor ? (items.find((i) => i.id === submissionsFor) ?? null) : null;
  // The primary action only when the surface is actually usable (page.tsx:436).
  const canOfferCreate = canManage && !!teamId && effective.kind === "ready";
  const openCreate = (slug?: string) =>
    router.push(slug ? `/intake-link-create?purpose=${encodeURIComponent(slug)}` : "/intake-link-create");

  return (
    <ProovraScreen shell testID="intake-links-page">
      <ProovraPageHeader
        title={COPY.title}
        subtitle={COPY.subtitle}
        contextStrip={
          teamId ? (
            <ProovraText variant="label" color={theme.color.ink.secondary}>
              {COPY.linksIn}{" "}
              <ProovraText variant="label" weight="semibold">{teamName}</ProovraText>
            </ProovraText>
          ) : undefined
        }
        primaryAction={
          canOfferCreate ? <ProovraButton label={COPY.newLink} fullWidth={false} onPress={() => openCreate()} testID="intake-new" /> : undefined
        }
        secondaryActions={<ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />}
      />

      <View style={{ gap: theme.space.s3 }}>
        {mutationError ? (
          <IntakeLinksMutationError action={mutationError.action} message={mutationError.message} onDismiss={() => setMutationError(null)} />
        ) : null}

        {effective.kind === "loading" ? <ProovraLoadingState label={COPY.loading} /> : null}

        {effective.kind === "feature_disabled" ? (
          <IntakeLinksStateCard tone="neutral" title={COPY.featureDisabledTitle} message={COPY.featureDisabledBody} testID="intake-links-feature-disabled" />
        ) : null}

        {effective.kind === "restricted" ? (
          <IntakeLinksStateCard
            tone="neutral"
            title={COPY.restrictedTitle}
            message={effective.reason === "forbidden" ? COPY.restrictedForbidden : COPY.restrictedNoEnvelope}
            testID="intake-links-restricted"
          />
        ) : null}

        {effective.kind === "error" ? (
          <IntakeLinksStateCard tone="risk" title={COPY.errorTitle} message={effective.message} onRetry={() => void fetchLinks("initial", termRef.current)} testID="intake-links-error" />
        ) : null}

        {effective.kind === "ready" && items.length === 0 && !appliedSearch ? (
          <IntakeLinksEmpty canCreate={canManage} purposes={BUILT_IN_PURPOSES} onCreate={() => openCreate()} onPickPurpose={(slug) => openCreate(slug)} />
        ) : null}

        {effective.kind === "ready" && (items.length > 0 || !!appliedSearch) ? (
          <>
            {refreshing ? <IntakeLinksRefreshing /> : null}
            <IntakeLinksKpis kpis={kpis} currentTab={filters.tab} onSelect={selectKpi} />
            <IntakeLinksToolbar
              search={search}
              onSearch={setSearch}
              filters={filters}
              onChange={patchFilters}
              showClear={filtersActive}
              onClear={clearFilters}
              resultSummary={result.matched.length === 1 ? "1 link" : `${result.matched.length} links`}
              pageSummary={result.pageCount > 1 ? `Page ${result.page} of ${result.pageCount}` : null}
            />
            {result.matched.length === 0 ? (
              <IntakeLinksStateCard
                tone="neutral"
                title={COPY.noMatchTitle}
                message={COPY.noMatchBody}
                action={<ProovraButton label={COPY.clearFilters} variant="secondary" fullWidth={false} onPress={clearFilters} />}
                testID="intake-links-no-match"
              />
            ) : (
              result.visible.map((item) => (
                <IntakeLinkRecord
                  key={item.id}
                  item={item}
                  onOpenDetails={() => setDetailsId(item.id)}
                  onOpenSubmissions={() => openSubmissions(item.id)}
                  onOpenDelivery={() => setDeliveryFor(item.id)}
                  onArchive={() => void archiveLink(item)}
                  archivePending={archivePendingId === item.id}
                  onDisable={canDisableLink(item) ? () => setDisableFor(item) : null}
                />
              ))
            )}
            {result.pageCount > 1 ? (
              <IntakeLinksPager
                page={result.page}
                pageCount={result.pageCount}
                pageSize={filters.pageSize}
                onPage={(page) => patchFilters({ page })}
                onPageSize={(pageSize) => patchFilters({ pageSize })}
              />
            ) : null}
            <ProovraText variant="label" color={theme.color.ink.muted}>
              {COPY.safetyNote}
            </ProovraText>
          </>
        ) : null}
      </View>

      {/* DetailsDrawer — Overview, Delivery, Activity, Submissions, Access. */}
      <ProovraSheet visible={detailsItem !== null} title={detailsItem?.templateName ?? ""} onClose={() => setDetailsId(null)}>
        {detailsItem ? (
          <>
            <IntakeLinkDetails
              item={detailsItem}
              onOpenDelivery={() => {
                setDetailsId(null);
                setDeliveryFor(detailsItem.id);
              }}
              onOpenSubmissions={linkHasSessions(detailsItem) ? () => openSubmissions(detailsItem.id) : null}
              onArchive={() => void archiveLink(detailsItem)}
              archivePending={archivePendingId === detailsItem.id}
              onDisable={
                canDisableLink(detailsItem)
                  ? () => {
                      setDetailsId(null);
                      setDisableFor(detailsItem);
                    }
                  : null
              }
            />
            <ProovraButton
              label="Reveal recipient contact"
              variant="ghost"
              fullWidth={false}
              onPress={() => {
                setDetailsId(null);
                setRevealing(detailsItem);
              }}
            />
          </>
        ) : null}
      </ProovraSheet>

      {/* SubmissionsDrawer. */}
      <ProovraSheet visible={submissionsFor !== null} title="Submissions" onClose={() => setSubmissionsFor(null)}>
        {submissionsItem ? (
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            {submissionsItem.templateName}
          </ProovraText>
        ) : null}
        {submissions === null ? (
          <ProovraLoadingState label="Loading submissions…" />
        ) : submissionsError ? (
          <ProovraErrorState message={submissionsError} onRetry={() => submissionsFor && void loadSubmissions(submissionsFor)} />
        ) : (
          <IntakeLinkSubmissionsList
            submissions={submissions}
            onOpenEvidence={(id) => {
              setSubmissionsFor(null);
              router.push(`/evidence/${id}` as never);
            }}
          />
        )}
      </ProovraSheet>

      <ProovraConfirmSheet
        visible={disableFor !== null}
        title={DISABLE_LINK_COPY.title}
        consequence={DISABLE_LINK_COPY.description}
        confirmLabel={DISABLE_LINK_COPY.confirmLabel}
        tone="danger"
        busy={disableBusy}
        onConfirm={() => void confirmDisable()}
        onCancel={() => setDisableFor(null)}
      />

      <ProovraSheet visible={revealing !== null} title="Reveal recipient contact?" onClose={closeReveal}>
        {revealed ? (
          <ProovraCard>
            <ProovraText variant="label" color={theme.color.ink.muted}>
              Revealed, and recorded
            </ProovraText>
            <ProovraText variant="bodySm" mono selectable>
              {[revealed.email, revealed.phone].filter(Boolean).join("  ") || "No contact on file"}
            </ProovraText>
          </ProovraCard>
        ) : (
          <>
            {/* Said BEFORE the tap, not discovered in an audit log afterwards. */}
            <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
              {INTAKE_REVEAL_CONSEQUENCE}
            </ProovraText>
            <ProovraFormField label="Why do you need it?">
              <ProovraInput
                value={revealReason}
                onChangeText={setRevealReason}
                placeholder="Recorded with the disclosure"
                autoCapitalize="sentences"
                accessibilityLabel="Reason for revealing the contact"
              />
            </ProovraFormField>
            <ProovraButton
              label="Reveal and record"
              variant="danger"
              loading={revealBusy}
              disabled={revealReason.trim().length < 3}
              onPress={() => void reveal()}
            />
          </>
        )}
      </ProovraSheet>

      {deliveryFor && teamId ? (
        <IntakeDeliveryHistory visible teamId={teamId} linkId={deliveryFor} onClose={() => setDeliveryFor(null)} />
      ) : null}
    </ProovraScreen>
  );
}
