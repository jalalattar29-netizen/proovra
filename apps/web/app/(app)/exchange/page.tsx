"use client";

/**
 * PHASE 12B (Evidence Operations) deltas:
 *
 *   - POST /v1/exchange/packages/:id/deliveries and
 *     POST /v1/exchange/deliveries/:id/download are now wired here as a
 *     real, ordered operator journey: record a delivery to a recipient,
 *     then take an AUTHORIZED download of it.
 *   - The download is AUDITED FIRST and fails closed: the short-lived
 *     signed link is only minted after
 *     POST /v1/exchange/deliveries/:id/download has recorded
 *     `downloadedAtUtc` and emitted the PACKAGE_DOWNLOADED webhook. A
 *     failed audit write means no link.
 *   - The signed link is NEVER placed in React state, in the DOM, or in
 *     an `href`. It is handed straight to the browser and dropped. The
 *     previous `<pre>{signResult.url}</pre>` dump (a bearer-token URL
 *     rendered into the page) is removed — only the expiry is shown.
 *   - Workspace context: the exchange routes resolve the tenant from
 *     `user.currentWorkspaceId` server-side, so the page sends no teamId.
 *     It re-loads on a workspace switch and DISCARDS in-flight responses
 *     whose workspace generation changed.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../lib/api";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../components/identity-security/StepUpModal";
import { formatUserDate, formatUserDateTime } from "../../../lib/date";
import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";
import { usePlatformContext } from "../../../lib/platform-context";

type PermissionDenialState = { denial: string; tier: string } | null;

interface ExchangePackage {
  id: string;
  kind: string;
  evidenceIds: string[];
  state: string;
  /**
   * The projection carries the persisted signed URL. It is intentionally
   * NOT read or rendered by this page — only the expiry is. See the
   * PHASE 12B note at the top of the file.
   */
  signedUrlExpiresAtUtc?: string | null;
  /** Projection field is `createdAt` (services/api exchange projection). */
  createdAt: string;
  /** Server-side total number of recorded deliveries. */
  deliveryCount?: number;
}

const PACKAGE_KINDS = ["SHARE", "EXPORT", "LEGAL_PRODUCTION", "INTERNAL_TRANSFER"] as const;

function applyDenial(err: unknown, setDenial: (v: PermissionDenialState) => void): void {
  const e = err as { statusCode?: number; details?: Record<string, unknown> };
  const denial =
    e?.details && typeof e.details["denial"] === "string" ? e.details["denial"] : null;
  const tier =
    e?.details && typeof e.details["requiredTier"] === "string"
      ? (e.details["requiredTier"] as string)
      : "DELEGATED_ADMIN";
  if (
    e?.statusCode === 403 &&
    (denial === "ENTITLEMENT_REQUIRED" || denial === "DELEGATED_ADMIN_REQUIRED")
  ) {
    setDenial({ denial: denial as string, tier });
    return;
  }
  if (err instanceof ApiError) {
    const d =
      err.details && typeof err.details["denial"] === "string"
        ? (err.details["denial"] as string)
        : null;
    const t =
      err.details && typeof err.details["requiredTier"] === "string"
        ? (err.details["requiredTier"] as string)
        : "DELEGATED_ADMIN";
    if (
      err.statusCode === 403 &&
      (d === "ENTITLEMENT_REQUIRED" || d === "DELEGATED_ADMIN_REQUIRED")
    ) {
      setDenial({ denial: d, tier: t });
    }
  }
}

export default function ExchangePage() {
  return (
    <PageRouteGate routeId="workspace.exchange">
      <Shell />
    </PageRouteGate>
  );
}

function Shell() {
  const { activeWorkspaceId } = usePlatformContext();

  // PHASE 12 POINT 4 — exporting evidence (minting a signed URL, recording a
  // delivery) is step-up gated server-side on PACKAGE_EXPORT_HIGH_RISK. The
  // canonical hook owns detection, challenge start/verify, the challenge
  // header and the single retry; the challenge is bound to this workspace.
  const stepUp = useStepUpAction({ teamId: activeWorkspaceId });
  // Stale-context rejection — every async read/write captures the
  // workspace generation it was issued under and drops its result when
  // the operator has switched workspace in the meantime.
  const activeWorkspaceRef = useRef<string | null>(activeWorkspaceId);
  useEffect(() => {
    activeWorkspaceRef.current = activeWorkspaceId;
  }, [activeWorkspaceId]);

  const [packages, setPackages] = useState<ExchangePackage[]>([]);
  const [busy, setBusy] = useState(false);
  const [denial, setDenial] = useState<PermissionDenialState>(null);

  // Create form state
  const [kind, setKind] = useState<string>(PACKAGE_KINDS[0]);
  const [evidenceIds, setEvidenceIds] = useState("");
  const [creating, setCreating] = useState(false);

  // Signed-link state. Deliberately does NOT hold the URL — only the
  // expiry the operator needs to see. See the header note.
  const [signBusy, setSignBusy] = useState<string | null>(null);
  const [signResult, setSignResult] = useState<{
    id: string;
    expiresAtUtc: string;
  } | null>(null);

  // Delivery journey state (PHASE 12B).
  const [deliveryForm, setDeliveryForm] = useState<{
    packageId: string;
    recipientEmail: string;
    recipientOrgSlug: string;
  } | null>(null);
  const [deliveryBusy, setDeliveryBusy] = useState<string | null>(null);
  // PHASE 12B — DURABLE delivery history from
  // GET /v1/exchange/packages/:packageId/deliveries. This survives reload;
  // the previous session-only map did not. `downloadAuthorizedAtUtc` and
  // `downloadedAtUtc` are distinct: the UI must never print "Downloaded"
  // from an authorisation timestamp.
  type DeliveryRow = {
    id: string;
    channel: string;
    recipientEmail: string | null;
    recipientOrgSlug: string | null;
    deliveredAtUtc: string | null;
    downloadAuthorizedAtUtc: string | null;
    downloadedAtUtc: string | null;
    verifiedAtUtc: string | null;
  };
  const [deliveries, setDeliveries] = useState<
    Record<string, { rows: DeliveryRow[]; nextCursor: string | null }>
  >({});
  const [deliveriesBusy, setDeliveriesBusy] = useState<string | null>(null);
  const [deliveriesError, setDeliveriesError] = useState<string | null>(null);
  const [downloadBusy, setDownloadBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  /**
   * Durable delivery history for one package. Stale-context safe: a response
   * that arrives after a workspace switch is discarded rather than painted
   * into the new workspace. `append` drives load-more via the server cursor.
   */
  const loadDeliveries = useCallback(
    async (packageId: string, cursor?: string | null) => {
      const requestWorkspaceId = activeWorkspaceRef.current;
      setDeliveriesBusy(packageId);
      setDeliveriesError(null);
      try {
        const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
        const res = (await apiFetch(
          `/v1/exchange/packages/${packageId}/deliveries${qs}`,
        )) as { deliveries?: DeliveryRow[]; nextCursor?: string | null } | null;
        if (requestWorkspaceId !== activeWorkspaceRef.current) return;
        const rows = res?.deliveries ?? [];
        setDeliveries((prev) => ({
          ...prev,
          [packageId]: {
            rows: cursor ? [...(prev[packageId]?.rows ?? []), ...rows] : rows,
            nextCursor: res?.nextCursor ?? null,
          },
        }));
      } catch (err) {
        if (requestWorkspaceId !== activeWorkspaceRef.current) return;
        setDeliveriesError(
          toSafeUserError(err as { message?: string }, {
            message: "Could not load delivery history.",
          }).message,
        );
      } finally {
        setDeliveriesBusy(null);
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    setBusy(true);
    setDenial(null);
    const requestWorkspaceId = activeWorkspaceRef.current;
    try {
      const res = (await apiFetch("/v1/exchange/packages", {
        method: "GET",
      })) as { packages?: ExchangePackage[] } | null;
      if (requestWorkspaceId !== activeWorkspaceRef.current) return;
      setPackages((res?.packages ?? []) as ExchangePackage[]);
    } catch (err) {
      if (requestWorkspaceId !== activeWorkspaceRef.current) return;
      setPackages([]);
      applyDenial(err, setDenial);
    } finally {
      setBusy(false);
    }
  }, []);

  const create = useCallback(async () => {
    setCreating(true);
    setDenial(null);
    try {
      const ids = evidenceIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      await apiFetch("/v1/exchange/packages", {
        method: "POST",
        body: JSON.stringify({ kind, evidenceIds: ids }),
      });
      setEvidenceIds("");
      await refresh();
    } catch (err) {
      applyDenial(err, setDenial);
    } finally {
      setCreating(false);
    }
  }, [kind, evidenceIds, refresh]);

  /**
   * Mints a short-lived signed link and hands it straight to the browser.
   * The URL is never returned to the caller, stored, or rendered.
   */
  const openSignedLink = useCallback(
    async (id: string): Promise<string | null> => {
    const res = (await stepUp.runStepUpAction(async (headers) =>
      apiFetch(`/v1/exchange/packages/${id}/sign-url`, {
        method: "POST",
        headers,
      }),
    )) as { signedUrl?: string; expiresAtUtc?: string } | null;
    if (!res?.signedUrl) return null;
    if (typeof window !== "undefined") {
      window.open(res.signedUrl, "_blank", "noopener,noreferrer");
    }
    return res.expiresAtUtc ?? null;
    },
    [stepUp],
  );

  const signUrl = useCallback(
    async (id: string) => {
      setSignBusy(id);
      setDenial(null);
      setActionError(null);
      setSignResult(null);
      const requestWorkspaceId = activeWorkspaceRef.current;
      try {
        const expiresAtUtc = await openSignedLink(id);
        if (requestWorkspaceId !== activeWorkspaceRef.current) return;
        if (expiresAtUtc) setSignResult({ id, expiresAtUtc });
      } catch (err) {
        if (requestWorkspaceId !== activeWorkspaceRef.current) return;
        applyDenial(err, setDenial);
        setActionError(
          toSafeUserError(err, {
            message: "The package link could not be created.",
          }).message,
        );
      } finally {
        setSignBusy(null);
      }
    },
    [openSignedLink],
  );

  /** POST /v1/exchange/packages/:id/deliveries — records a recipient. */
  const recordDelivery = useCallback(async () => {
    if (!deliveryForm) return;
    const { packageId, recipientEmail, recipientOrgSlug } = deliveryForm;
    setDeliveryBusy(packageId);
    setDenial(null);
    setActionError(null);
    const requestWorkspaceId = activeWorkspaceRef.current;
    try {
      const body: Record<string, string> = {};
      if (recipientEmail.trim()) body.recipientEmail = recipientEmail.trim();
      if (recipientOrgSlug.trim()) body.recipientOrgSlug = recipientOrgSlug.trim();
      const res = (await stepUp.runStepUpAction(async (headers) =>
        apiFetch(`/v1/exchange/packages/${packageId}/deliveries`, {
          method: "POST",
          body: JSON.stringify(body),
          headers,
        }),
      )) as { deliveryId?: string } | null;
      if (requestWorkspaceId !== activeWorkspaceRef.current) return;
      if (!res?.deliveryId) {
        setActionError("The delivery was not recorded. Try again.");
        return;
      }
      setDeliveryForm(null);
      // Re-read the DURABLE history rather than appending a local guess, so
      // what the operator sees is what the server actually persisted.
      await loadDeliveries(packageId);
      await refresh();
    } catch (err) {
      if (requestWorkspaceId !== activeWorkspaceRef.current) return;
      applyDenial(err, setDenial);
      setActionError(
        toSafeUserError(err, {
          message: "The delivery could not be recorded.",
        }).message,
      );
    } finally {
      setDeliveryBusy(null);
    }
    // `loadDeliveries` is memoised with an empty dep array (workspace safety is
    // handled inside it via activeWorkspaceRef), so listing it is stable.
  }, [deliveryForm, refresh, loadDeliveries, stepUp]);

  /**
   * Authorized download of a recorded delivery.
   *
   * Order is deliberate and fail-closed:
   *   1. POST /v1/exchange/deliveries/:id/download — the audit write
   *      (stamps downloadedAtUtc, emits PACKAGE_DOWNLOADED).
   *   2. only then mint the short-lived signed link and hand it to the
   *      browser.
   * If step 1 fails there is no link, so an unaudited download is
   * impossible.
   */
  const downloadDelivery = useCallback(
    async (packageId: string, deliveryId: string) => {
      setDownloadBusy(deliveryId);
      setDenial(null);
      setActionError(null);
      setSignResult(null);
      const requestWorkspaceId = activeWorkspaceRef.current;
      try {
        await apiFetch(`/v1/exchange/deliveries/${deliveryId}/download`, {
          method: "POST",
        });
        if (requestWorkspaceId !== activeWorkspaceRef.current) return;
        // Do NOT stamp a client-side "downloaded" time — the client has no
        // transfer-completion knowledge. Re-read the server's durable record
        // so the row reflects authorisation, which is all that just happened.
        await loadDeliveries(packageId);
        if (requestWorkspaceId !== activeWorkspaceRef.current) return;
        const expiresAtUtc = await openSignedLink(packageId);
        if (requestWorkspaceId !== activeWorkspaceRef.current) return;
        if (expiresAtUtc) setSignResult({ id: packageId, expiresAtUtc });
      } catch (err) {
        if (requestWorkspaceId !== activeWorkspaceRef.current) return;
        applyDenial(err, setDenial);
        setActionError(
          toSafeUserError(err, {
            message:
              "The download could not be authorized, so no link was issued.",
          }).message,
        );
      } finally {
        setDownloadBusy(null);
      }
    },
    [openSignedLink, loadDeliveries],
  );

  useEffect(() => {
    // Re-load whenever the active workspace changes — the packages list is
    // resolved server-side from the current workspace.
    setPackages([]);
    // Workspace switch clears the durable-history cache and its error state.
    setDeliveries({});
    setDeliveriesError(null);
    setSignResult(null);
    setDeliveryForm(null);
    void refresh();
  }, [refresh, activeWorkspaceId]);

  return (
    <div
      data-exchange-page
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Evidence Exchange</h1>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          Packages · signed URL distribution · chain transfers.
        </p>
      </header>

      {denial ? (
        <div
          data-permission-denied={denial.denial}
          style={{
            padding: 10,
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            borderRadius: 8,
            fontSize: 12,
            marginBottom: 10,
          }}
        >
          <strong>Permission required:</strong> {denial.tier}
        </div>
      ) : null}

      {actionError ? (
        <div
          role="alert"
          data-exchange-action-error
          style={{
            padding: 10,
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            borderRadius: 8,
            fontSize: 12,
            marginBottom: 10,
          }}
        >
          {actionError}
        </div>
      ) : null}

      {signResult ? (
        <div
          data-exchange-signed-url
          style={{
            padding: 12,
            background: "#f0fdf4",
            border: "2px solid #16a34a",
            borderRadius: 8,
            fontSize: 12,
            marginBottom: 14,
          }}
        >
          <strong style={{ color: "#15803d" }}>
            Package link opened in a new tab (package {signResult.id}).
          </strong>
          <p style={{ margin: "6px 0 4px" }}>
            The link is short-lived and is never displayed or stored in this
            page. If the tab was blocked, use the package action again.
          </p>
          <small>
            Expires: {formatUserDateTime(signResult.expiresAtUtc)}
          </small>
          <br />
          <button
            type="button"
            onClick={() => setSignResult(null)}
            style={{ marginTop: 6, fontSize: 11, cursor: "pointer" }}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {/* Create form */}
      <section
        style={{
          background: "rgba(15,23,42,0.03)",
          border: "1px solid rgba(15,23,42,0.06)",
          borderRadius: 10,
          padding: 14,
          marginBottom: 16,
        }}
      >
        <strong style={{ display: "block", marginBottom: 10, fontSize: 14 }}>
          Create Exchange Package
        </strong>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={labelStyle}>
            Kind
            <select style={inputStyle} value={kind} onChange={(e) => setKind(e.target.value)}>
              {PACKAGE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            Evidence IDs (comma-sep)
            <input
              style={{ ...inputStyle, minWidth: 280 }}
              value={evidenceIds}
              onChange={(e) => setEvidenceIds(e.target.value)}
              placeholder="uuid1, uuid2"
            />
          </label>
          <button
            type="button"
            disabled={creating || !evidenceIds}
            onClick={() => void create()}
            style={primaryButton}
          >
            {creating ? "Creating…" : "Create Package"}
          </button>
        </div>
      </section>

      <button
        type="button"
        disabled={busy}
        onClick={() => void refresh()}
        style={primaryButton}
      >
        {busy ? "Loading…" : "Refresh"}
      </button>

      <section
        style={{
          background: "#fff",
          border: "1px solid rgba(15,23,42,0.08)",
          borderRadius: 10,
          padding: 8,
          marginTop: 12,
          overflowX: "auto",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={th}>Kind</th>
              <th style={th}>Evidence Count</th>
              <th style={th}>State</th>
              <th style={th}>Created</th>
              <th style={th}>Deliveries</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {packages.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ ...td, color: "#475569" }}>
                  No packages.
                </td>
              </tr>
            ) : (
              packages.map((pkg) => (
                <tr key={pkg.id} data-exchange-package-row={pkg.id}>
                  <td style={td}>
                    <code>{pkg.kind}</code>
                  </td>
                  <td style={td}>{pkg.evidenceIds.length}</td>
                  <td style={td}>
                    <strong>{pkg.state}</strong>
                  </td>
                  <td style={td}>{formatUserDate(pkg.createdAt)}</td>
                  <td style={td}>
                    <DeliveryCell
                      packageId={pkg.id}
                      deliveryCount={pkg.deliveryCount}
                      deliveries={deliveries[pkg.id]?.rows ?? []}
                      nextCursor={deliveries[pkg.id]?.nextCursor ?? null}
                      loading={deliveriesBusy === pkg.id}
                      error={deliveriesError}
                      onLoad={() => void loadDeliveries(pkg.id)}
                      onLoadMore={(cursor) => void loadDeliveries(pkg.id, cursor)}
                      downloadBusy={downloadBusy}
                      onDownload={(deliveryId) =>
                        void downloadDelivery(pkg.id, deliveryId)
                      }
                    />
                  </td>
                  <td style={td}>
                    <button
                      type="button"
                      disabled={signBusy === pkg.id}
                      onClick={() => void signUrl(pkg.id)}
                      style={secondaryButton}
                    >
                      {signBusy === pkg.id ? "Opening…" : "Open package"}
                    </button>{" "}
                    <button
                      type="button"
                      data-exchange-record-delivery={pkg.id}
                      disabled={deliveryBusy === pkg.id}
                      onClick={() =>
                        setDeliveryForm({
                          packageId: pkg.id,
                          recipientEmail: "",
                          recipientOrgSlug: "",
                        })
                      }
                      style={secondaryButton}
                    >
                      Record delivery
                    </button>
                    {pkg.signedUrlExpiresAtUtc ? (
                      <span style={{ marginLeft: 8, fontSize: 11, color: "#475569" }}>
                        Link expires:{" "}
                        {formatUserDate(pkg.signedUrlExpiresAtUtc)}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      {deliveryForm ? (
        <RecordDeliveryDialog
          form={deliveryForm}
          busy={deliveryBusy === deliveryForm.packageId}
          onChange={setDeliveryForm}
          onCancel={() => setDeliveryForm(null)}
          onSubmit={() => void recordDelivery()}
        />
      ) : null}

      {/* PHASE 12 POINT 4 — the canonical step-up surface. Exporting evidence
          (minting a signed URL, recording a delivery) is gated server-side on
          PACKAGE_EXPORT_HIGH_RISK; without this the operator would receive a
          bare 401 and the action would simply appear to fail. The modal owns
          the challenge and the single retry — this page adds no challenge
          logic of its own and stores no signed URL. */}
      <StepUpModal control={stepUp} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// PHASE 12B — deliveries + authorized download
// ---------------------------------------------------------------------------

/**
 * The API has no deliveries LIST read, so this cell is explicit about
 * what it can and cannot show: the server-side total from the package
 * projection, plus the deliveries recorded in this session (the only ones
 * whose ids the client legitimately holds).
 */
function DeliveryCell({
  packageId,
  deliveryCount,
  deliveries,
  downloadBusy,
  onDownload,
  nextCursor,
  loading,
  error,
  onLoad,
  onLoadMore,
}: {
  packageId: string;
  deliveryCount?: number;
  deliveries: ReadonlyArray<{
    id: string;
    recipientEmail: string | null;
    recipientOrgSlug: string | null;
    deliveredAtUtc: string | null;
    downloadAuthorizedAtUtc: string | null;
    downloadedAtUtc: string | null;
  }>;
  downloadBusy: string | null;
  onDownload: (deliveryId: string) => void;
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
  onLoad: () => void;
  onLoadMore: (cursor: string) => void;
}) {
  // Load the durable history once the panel is shown.
  useEffect(() => {
    onLoad();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packageId]);

  return (
    <div data-exchange-deliveries={packageId}>
      <span style={{ fontSize: 11, color: "#475569" }}>
        {typeof deliveryCount === "number"
          ? `${deliveryCount} recorded`
          : "Count unavailable"}
      </span>
      {error ? (
        <div
          role="alert"
          data-exchange-deliveries-error
          style={{ fontSize: 11, color: "#b91c1c", marginTop: 4 }}
        >
          {error}
        </div>
      ) : null}
      {loading && deliveries.length === 0 ? (
        <div style={{ fontSize: 11, color: "#475569", marginTop: 4 }}>
          Loading delivery history…
        </div>
      ) : deliveries.length === 0 ? (
        <div style={{ fontSize: 11, color: "#475569", marginTop: 4 }}>
          No deliveries recorded for this package yet.
        </div>
      ) : (
        <ul style={{ margin: "4px 0 0", padding: 0, listStyle: "none" }}>
          {deliveries.map((d) => (
            <li
              key={d.id}
              data-exchange-delivery-row={d.id}
              style={{ marginTop: 4, fontSize: 11 }}
            >
              <div style={{ color: "#0f172a" }}>
                {d.recipientEmail ??
                  d.recipientOrgSlug ??
                  "Recipient not identified"}
              </div>
              {/* PHASE 12B — never print "Downloaded" from an authorisation
                  timestamp. Confirmed transfer is reported only when the
                  server proved it; otherwise we say exactly what we know:
                  a link was authorised, or nothing has happened yet. */}
              <div style={{ color: "#475569" }}>
                {d.downloadedAtUtc
                  ? `Downloaded ${formatUserDateTime(d.downloadedAtUtc)}`
                  : d.downloadAuthorizedAtUtc
                    ? `Download authorized ${formatUserDateTime(d.downloadAuthorizedAtUtc)} · completion not confirmed`
                    : "No download authorized"}
              </div>
              <button
                type="button"
                data-exchange-delivery-download={d.id}
                disabled={downloadBusy === d.id}
                onClick={() => onDownload(d.id)}
                style={secondaryButton}
              >
                {downloadBusy === d.id
                  ? "Authorizing…"
                  : "Download (audited)"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {nextCursor ? (
        <button
          type="button"
          data-exchange-deliveries-more
          disabled={loading}
          onClick={() => onLoadMore(nextCursor)}
          style={secondaryButton}
        >
          {loading ? "Loading…" : "Load more deliveries"}
        </button>
      ) : null}
    </div>
  );
}

function RecordDeliveryDialog({
  form,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  form: { packageId: string; recipientEmail: string; recipientOrgSlug: string };
  busy: boolean;
  onChange: (next: {
    packageId: string;
    recipientEmail: string;
    recipientOrgSlug: string;
  }) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Record package delivery"
      data-exchange-delivery-dialog={form.packageId}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        zIndex: 60,
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 12,
          padding: 16,
          width: "100%",
          maxWidth: 460,
        }}
      >
        <strong style={{ fontSize: 14, display: "block", marginBottom: 4 }}>
          Record delivery
        </strong>
        <p style={{ fontSize: 12, color: "#475569", marginTop: 0 }}>
          Records who this package was delivered to. Provide an email, an
          organization slug, or neither if the recipient is tracked
          elsewhere. Both fields are optional and validated server-side.
        </p>
        <label style={labelStyle}>
          Recipient email
          <input
            style={{ ...inputStyle, minWidth: 0, width: "100%" }}
            type="email"
            data-exchange-delivery-email
            value={form.recipientEmail}
            onChange={(e) =>
              onChange({ ...form, recipientEmail: e.target.value })
            }
          />
        </label>
        <label style={{ ...labelStyle, marginTop: 8 }}>
          Recipient organization slug
          <input
            style={{ ...inputStyle, minWidth: 0, width: "100%" }}
            data-exchange-delivery-org
            value={form.recipientOrgSlug}
            onChange={(e) =>
              onChange({ ...form, recipientOrgSlug: e.target.value })
            }
          />
        </label>
        <div
          style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}
        >
          <button type="button" onClick={onCancel} style={secondaryButton}>
            Cancel
          </button>
          <button
            type="button"
            data-exchange-delivery-submit
            disabled={busy}
            onClick={onSubmit}
            style={primaryButton}
          >
            {busy ? "Recording…" : "Record delivery"}
          </button>
        </div>
      </div>
    </div>
  );
}

const primaryButton = {
  padding: "6px 12px",
  border: "1px solid #0f172a",
  background: "#0f172a",
  color: "#fafafa",
  fontWeight: 600,
  fontSize: 12,
  borderRadius: 8,
  cursor: "pointer",
} as const;
const secondaryButton = {
  padding: "4px 8px",
  border: "1px solid #0f172a",
  background: "#fff",
  color: "#0f172a",
  fontWeight: 600,
  fontSize: 11,
  borderRadius: 6,
  cursor: "pointer",
} as const;
const th = { padding: "6px 8px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" } as const;
const labelStyle = { display: "flex", flexDirection: "column" as const, gap: 2, fontSize: 11, fontWeight: 600 };
const inputStyle = {
  fontSize: 12,
  padding: "4px 6px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "#fff",
  minWidth: 140,
} as const;
