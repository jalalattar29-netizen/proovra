"use client";

/**
 * External Intake Links — the management surface.
 *
 * WHAT THIS ROUTE IS
 * ---------------------------------------------------------------------------
 * Workspace admins create secure, expiring links that let someone OUTSIDE the
 * workspace upload evidence without an account, then track what happened to
 * each one: was the message delivered, did the contributor open it, did they
 * submit, is the link still live.
 *
 * ARCHITECTURE
 * ---------------------------------------------------------------------------
 * This file is the ORCHESTRATOR and nothing else — gate, workspace resolution,
 * the two reads, the mutations, the filter state and which state renders. Every
 * pixel lives elsewhere:
 *
 *   lib/intake-links/state-model  three orthogonal state axes + KPI predicates
 *   lib/intake-links/vocabulary   wire → label → tone → explanation, once
 *   lib/intake-links/catalog      request purposes, channels, kinds, limits
 *   _lib/filters                  the pure filter / sort / paginate pipeline
 *   _lib/rowModel                 ONE row mapping, two renderers
 *   _lib/wizardState              the creation state machine
 *   _components/*                 presentation over the canonical app-* system
 *   intake-links.css              this route's own layout
 *
 * PRIVACY
 * ---------------------------------------------------------------------------
 * The raw token exists in the browser for exactly one dialog and is never
 * persisted or re-fetched. The list projection never carries it, which is why
 * no row offers a "copy link" action — a button that cannot do what it says is
 * worse than an absent one.
 */

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { PageShell } from "../../../components/ui";
import { useConfirmAction } from "../../../components/ui/ConfirmActionModal";
import { apiFetch } from "../../../lib/api";
import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";
import {
  useCan,
  useOwningContextLabel,
  usePlatformContext,
} from "../../../lib/platform-context";
import { computeIntakeKpis } from "../../../lib/intake-links/state-model";
import { DISABLE_LINK_COPY } from "../../../lib/intake-links/vocabulary";

import "./intake-links.css";

import { FilterToolbar } from "./_components/FilterToolbar";
import { KpiGrid } from "./_components/KpiGrid";
import { Pagination } from "./_components/Pagination";
import { RecordsSurface } from "./_components/RecordsSurface";
import {
  EmptyState,
  ErrorState,
  FeatureUnavailableState,
  InlineMutationError,
  LoadingState,
  NoMatchState,
  RefreshingNotice,
  RestrictedState,
} from "./_components/States";
import { DeliveryHistoryDrawer } from "./_components/DeliveryHistoryDrawer";
import { DetailsDrawer } from "./_components/DetailsDrawer";
import { SubmissionsDrawer } from "./_components/SubmissionsDrawer";
import { LinkCreatedDialog } from "./_components/LinkCreatedDialog";
import { CreateLinkWizard } from "./_components/wizard/CreateLinkWizard";
import { IconLink, IconPlus } from "./_components/icons";
import {
  DEFAULT_FILTERS,
  anyFilterActive,
  applyFilters,
  filtersFromQuery,
  filtersToQuery,
  type FilterState,
  type TabParam,
} from "./_lib/filters";
import type {
  CreatedIntakeLink,
  IntakeLinkListItem,
  WorkflowTemplateRow,
} from "./_lib/types";

export default function IntakeLinksPage() {
  return (
    <PageRouteGate routeId="workspace.intake_links">
      <IntakeLinksManagement />
    </PageRouteGate>
  );
}

/** Stable empty array so a non-ready load never invalidates the memos below. */
const NO_ITEMS: IntakeLinkListItem[] = [];

/** What the list read resolved to. Every non-ready value is a real state. */
type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; items: IntakeLinkListItem[] }
  | { kind: "error"; message: string }
  | { kind: "restricted"; reason: "forbidden" | "no_envelope" }
  | { kind: "feature_disabled" };

function IntakeLinksManagement() {
  const { envelope } = usePlatformContext();
  const { workspaceName } = useOwningContextLabel();
  const canManage = useCan("INTAKE_LINKS_MANAGE");
  const { confirm } = useConfirmAction();
  const router = useRouter();
  const searchParams = useSearchParams();

  // ---- Workspace ---------------------------------------------------------
  // `activeSpace` is the canonical post-tenant-model source of truth and the
  // API projects it unconditionally. Both PERSONAL and ORGANIZATION spaces are
  // valid here: a personal workspace is a Team row with the user as OWNER, so
  // the backend membership lookup works identically for both.
  const activeSpace = envelope?.activeSpace ?? null;
  const teamId = activeSpace?.id ?? null;
  const teamName =
    activeSpace?.type === "PERSONAL"
      ? "Personal Space"
      : (activeSpace?.displayName ?? workspaceName ?? "Workspace");

  // ---- Reads -------------------------------------------------------------
  const [load, setLoad] = React.useState<LoadState>({ kind: "loading" });
  const [refreshing, setRefreshing] = React.useState(false);
  const [templates, setTemplates] = React.useState<WorkflowTemplateRow[]>([]);
  const [mutationError, setMutationError] = React.useState<string | null>(null);

  const fetchLinks = React.useCallback(
    async (workspaceId: string, mode: "initial" | "refresh") => {
      if (mode === "refresh") setRefreshing(true);
      try {
        const res = (await apiFetch(
          // `archiveScope=all` so the Archived filter has rows to match; the
          // backend default hides them and every tab then filters in memory
          // off the same array, which is what keeps the KPI counts and the
          // table honest with each other.
          `/v1/workflow/intake-links?teamId=${encodeURIComponent(workspaceId)}&archiveScope=all`,
          { method: "GET" },
        )) as { items?: IntakeLinkListItem[] };
        setLoad({ kind: "ready", items: res.items ?? [] });
      } catch (err) {
        const e = err as { code?: string; statusCode?: number; message?: string };
        if (e?.statusCode === 503 || e?.code === "FEATURE_DISABLED") {
          setLoad({ kind: "feature_disabled" });
          return;
        }
        // 404 is the API's anti-enumeration answer to "not yours" — it means
        // restricted, not missing, and must not offer a retry.
        if (e?.statusCode === 403 || e?.statusCode === 404) {
          setLoad({ kind: "restricted", reason: "forbidden" });
          return;
        }
        setLoad({
          kind: "error",
          message: toSafeUserError(e, {
            message: "Unable to load intake links.",
          }).message,
        });
      } finally {
        setRefreshing(false);
      }
    },
    [],
  );

  React.useEffect(() => {
    if (!teamId) return;
    // Drop the prior tenant's rows before re-fetching so a workspace switch
    // never flashes another workspace's intake links.
    setLoad({ kind: "loading" });
    setTemplates([]);
    void fetchLinks(teamId, "initial");
  }, [teamId, fetchLinks]);

  React.useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    apiFetch(`/v1/workflow/templates?teamId=${encodeURIComponent(teamId)}`, {
      method: "GET",
    })
      .then((res) => {
        if (cancelled) return;
        setTemplates((res as { templates?: WorkflowTemplateRow[] }).templates ?? []);
      })
      .catch(() => {
        // A failed template fetch must not block the page: the built-in
        // request catalog resolves server-side without it.
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  // ---- Filters (URL-backed) ---------------------------------------------
  const [filters, setFilters] = React.useState<FilterState>(() =>
    filtersFromQuery(new URLSearchParams(searchParams?.toString() ?? "")),
  );

  const writeQuery = React.useCallback(
    (next: FilterState) => {
      const qs = filtersToQuery(next).toString();
      // `replace`, not `push`: the back button must not step through every
      // keystroke of a search.
      router.replace(qs ? `?${qs}` : "?", { scroll: false });
    },
    [router],
  );

  const patchFilters = React.useCallback(
    (patch: Partial<FilterState>) => {
      setFilters((prev) => {
        // Any narrowing returns to page 1 — otherwise a filter can strand the
        // operator on a page that no longer exists.
        const resetsPage =
          "q" in patch ||
          "tab" in patch ||
          "channel" in patch ||
          "lifecycle" in patch ||
          "delivery" in patch ||
          "pageSize" in patch;
        const next = { ...prev, ...patch, ...(resetsPage ? { page: 1 } : {}) };
        writeQuery(next);
        return next;
      });
    },
    [writeQuery],
  );

  const clearFilters = React.useCallback(() => {
    setFilters(() => {
      writeQuery(DEFAULT_FILTERS);
      return DEFAULT_FILTERS;
    });
  }, [writeQuery]);

  // A KPI is a whole view, so it clears the secondary dropdowns too: leaving a
  // stale delivery filter behind is how "Submitted (19)" opens an empty table.
  const selectKpi = React.useCallback(
    (tab: TabParam) => {
      patchFilters({ tab, channel: "", lifecycle: "", delivery: "" });
    },
    [patchFilters],
  );

  // ---- Panels ------------------------------------------------------------
  const [wizard, setWizard] = React.useState<{ initialSlug?: string } | null>(
    null,
  );
  const [created, setCreated] = React.useState<{
    result: CreatedIntakeLink;
    intakeUrl: string;
  } | null>(null);
  const [detailsId, setDetailsId] = React.useState<string | null>(null);
  const [deliveryId, setDeliveryId] = React.useState<string | null>(null);
  const [submissionsId, setSubmissionsId] = React.useState<string | null>(null);
  const [archivePendingId, setArchivePendingId] = React.useState<string | null>(
    null,
  );

  const openWizard = React.useCallback((initialSlug?: string) => {
    setMutationError(null);
    setWizard({ initialSlug });
  }, []);

  // Home's "Request & collect" widget deep-links here to OPEN a flow, not just
  // to navigate. Applied once on mount so a manual close is not re-triggered.
  const deepLinkApplied = React.useRef(false);
  React.useEffect(() => {
    if (deepLinkApplied.current || !searchParams) return;
    if (searchParams.get("new") === "1") {
      deepLinkApplied.current = true;
      openWizard();
      return;
    }
    const linkId = searchParams.get("linkId");
    if (linkId) {
      deepLinkApplied.current = true;
      setDeliveryId(linkId);
    }
  }, [searchParams, openWizard]);

  // ---- Mutations ---------------------------------------------------------
  const refresh = React.useCallback(() => {
    if (teamId) void fetchLinks(teamId, "refresh");
  }, [teamId, fetchLinks]);

  const disableLink = React.useCallback(
    async (linkId: string) => {
      const ok = await confirm({
        title: DISABLE_LINK_COPY.title,
        description: DISABLE_LINK_COPY.description,
        confirmLabel: DISABLE_LINK_COPY.confirmLabel,
        tone: "danger",
        testId: "intake-link-revoke",
      });
      if (!ok) return;
      setMutationError(null);
      try {
        await apiFetch(
          `/v1/workflow/intake-links/${encodeURIComponent(linkId)}/revoke`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reason: null }),
          },
        );
        refresh();
      } catch (err) {
        setMutationError(
          toSafeUserError(err, {
            message: "Couldn't disable that link.",
          }).message,
        );
      }
    },
    [confirm, refresh],
  );

  const archiveLink = React.useCallback(
    async (linkId: string, archived: boolean) => {
      // Guarded at the handler so a double-click cannot fire two mutations.
      if (archivePendingId) return;
      setArchivePendingId(linkId);
      setMutationError(null);
      try {
        await apiFetch(
          `/v1/workflow/intake-links/${encodeURIComponent(linkId)}/${
            archived ? "unarchive" : "archive"
          }`,
          { method: "POST" },
        );
        refresh();
      } catch (err) {
        setMutationError(
          toSafeUserError(err, {
            message: archived
              ? "Couldn't restore that link from the archive."
              : "Couldn't archive that link.",
          }).message,
        );
      } finally {
        setArchivePendingId(null);
      }
    },
    [archivePendingId, refresh],
  );

  // ---- Derived -----------------------------------------------------------
  // Memoised so the KPI and filter passes below are not recomputed on every
  // unrelated render (a fresh `[]` literal would change identity each time).
  const items = React.useMemo(
    () => (load.kind === "ready" ? load.items : NO_ITEMS),
    [load],
  );
  const kpis = React.useMemo(() => computeIntakeKpis(items), [items]);
  const result = React.useMemo(
    () => applyFilters(items, filters),
    [items, filters],
  );
  const detailsItem = detailsId
    ? (items.find((i) => i.link.id === detailsId) ?? null)
    : null;

  // The canonical internal page header (icon + title + subtitle + one primary
  // action), rendered through PageShell exactly as the other migrated internal
  // surfaces do.
  const header = (
    <div className="app-page-header" data-testid="intake-links-header">
      <div className="app-page-header__lead">
        <span className="app-page-header__icon" aria-hidden="true">
          <IconLink size={21} />
        </span>
        <div className="app-page-header__text">
          <h1 className="app-page-header__title">External intake links</h1>
          <p className="app-page-header__subtitle">
            Secure links that let people outside your workspace upload photos,
            videos, audio, or documents — without an account.
          </p>
          {/* Truthful, and only when it adds something: WHICH workspace this
              list belongs to. The kind is deliberately NOT repeated after the
              name — the previous banner rendered "Personal Space · Personal
              Space", which said the same thing twice and looked like a bug. */}
          {teamName ? (
            <p className="ilk-context" data-intake-links-context>
              <span>Links in</span>
              <strong data-context-workspace>{teamName}</strong>
            </p>
          ) : null}
        </div>
      </div>
      {canManage && teamId ? (
        <div className="app-page-header__actions">
          <button
            type="button"
            className="app-primary-action"
            onClick={() => openWizard()}
            data-intake-links-new-cta="true"
          >
            <IconPlus size={16} />
            <span>New intake link</span>
          </button>
        </div>
      ) : null}
    </div>
  );

  // Fail CLOSED: no envelope, or a projection that does not grant the
  // capability, renders the restricted panel — never the management surface.
  const restricted = !envelope
    ? ({ kind: "restricted", reason: "no_envelope" } as const)
    : !canManage
      ? ({ kind: "restricted", reason: "forbidden" } as const)
      : null;

  const effective: LoadState =
    restricted ?? (teamId ? load : { kind: "loading" });

  return (
    <PageShell className="ilk-page" header={header} data-testid="intake-links-page">
      {mutationError ? (
        <InlineMutationError
          message={mutationError}
          onDismiss={() => setMutationError(null)}
        />
      ) : null}

      {effective.kind === "loading" ? <LoadingState /> : null}

      {effective.kind === "feature_disabled" ? <FeatureUnavailableState /> : null}

      {effective.kind === "restricted" ? (
        <RestrictedState reason={effective.reason} />
      ) : null}

      {effective.kind === "error" ? (
        <ErrorState
          message={effective.message}
          onRetry={() => {
            if (teamId) {
              setLoad({ kind: "loading" });
              void fetchLinks(teamId, "initial");
            }
          }}
        />
      ) : null}

      {effective.kind === "ready" && items.length === 0 ? (
        <EmptyState
          canCreate={canManage}
          onCreate={() => openWizard()}
          onPickPurpose={(slug) => openWizard(slug)}
        />
      ) : null}

      {effective.kind === "ready" && items.length > 0 ? (
        <>
          {refreshing ? <RefreshingNotice /> : null}

          <KpiGrid kpis={kpis} currentTab={filters.tab} onSelect={selectKpi} />

          <FilterToolbar
            filters={filters}
            onChange={patchFilters}
            onClear={clearFilters}
            showClear={anyFilterActive(filters)}
            resultSummary={
              result.matched.length === 1
                ? "1 link"
                : `${result.matched.length} links`
            }
            pageSummary={
              result.pageCount > 1
                ? `Page ${result.page} of ${result.pageCount}`
                : null
            }
          />

          {result.matched.length === 0 ? (
            <NoMatchState onClear={clearFilters} />
          ) : (
            <RecordsSurface
              items={result.visible}
              handlers={{
                onOpenDetails: setDetailsId,
                onOpenDelivery: setDeliveryId,
                onOpenSubmissions: setSubmissionsId,
                onDisable: (id) => void disableLink(id),
                onArchive: (id, archived) => void archiveLink(id, archived),
                pendingArchiveId: archivePendingId,
              }}
            />
          )}

          {result.pageCount > 1 ? (
            <Pagination
              page={result.page}
              pageCount={result.pageCount}
              pageSize={filters.pageSize}
              onPage={(page) => patchFilters({ page })}
              onPageSize={(pageSize) => patchFilters({ pageSize })}
            />
          ) : null}

          <p className="ilk-note" data-intake-links-safety-note="true">
            Contributors submit files without ever accessing this workspace. You
            control the channel, expiry, accepted file types, and whether a link
            stays live.
          </p>
        </>
      ) : null}

      {wizard && teamId && canManage ? (
        <CreateLinkWizard
          team={{ id: teamId, name: teamName }}
          templates={templates}
          initialSlug={wizard.initialSlug}
          onClose={() => setWizard(null)}
          onCreated={(res) => {
            setWizard(null);
            const base =
              typeof window !== "undefined" && window.location
                ? `${window.location.protocol}//${window.location.host}`
                : "";
            setCreated({
              result: res,
              intakeUrl: `${base}/intake/${encodeURIComponent(res.rawToken)}`,
            });
            refresh();
          }}
        />
      ) : null}

      {created ? (
        <LinkCreatedDialog
          created={created.result}
          intakeUrl={created.intakeUrl}
          onClose={() => setCreated(null)}
        />
      ) : null}

      {detailsItem ? (
        <DetailsDrawer
          item={detailsItem}
          onClose={() => setDetailsId(null)}
          onOpenDelivery={() => {
            setDetailsId(null);
            setDeliveryId(detailsItem.link.id);
          }}
          onOpenSubmissions={() => {
            setDetailsId(null);
            setSubmissionsId(detailsItem.link.id);
          }}
          onDisable={() => {
            setDetailsId(null);
            void disableLink(detailsItem.link.id);
          }}
          onArchive={() =>
            void archiveLink(
              detailsItem.link.id,
              Boolean(detailsItem.link.archivedAtUtc),
            )
          }
          archivePending={archivePendingId === detailsItem.link.id}
        />
      ) : null}

      {deliveryId && teamId ? (
        <DeliveryHistoryDrawer
          linkId={deliveryId}
          teamId={teamId}
          onClose={() => setDeliveryId(null)}
        />
      ) : null}

      {submissionsId ? (
        <SubmissionsDrawer
          linkId={submissionsId}
          onClose={() => setSubmissionsId(null)}
        />
      ) : null}
    </PageShell>
  );
}
