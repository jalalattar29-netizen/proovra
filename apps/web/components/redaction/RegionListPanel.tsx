"use client";

/**
 * PHASE 12B (Evidence Operations) — Redaction region list + removal.
 *
 * Product consumer for `DELETE /v1/redaction/regions/:id`
 * (services/api/src/routes/redaction.routes.ts). Before this panel the
 * operator could DRAW regions but never see or remove them, so the
 * delete op had no reachable caller.
 *
 * Contract:
 *   * The region rows come from the SERVER projection
 *     (`GET /v1/redaction/projects/:id` → versions[].regions), never
 *     from client-held state. After a removal the parent re-reads the
 *     projection; the panel never optimistically mutates the list.
 *   * ZERO client policy authority. The panel disables removal when the
 *     server says the version is out of DRAFT (`versionLocked`), but the
 *     server re-checks `redaction.region.author` + DRAFT state and is the
 *     only decider — a bypassed control still gets a bounded denial.
 *   * Workspace binding + stale-context rejection are inherited from the
 *     parent page, which re-reads under `useTenantGuard`; the removal
 *     itself is guarded here so a workspace switch mid-request never
 *     surfaces another tenant's outcome as this tenant's banner.
 *   * Removal is destructive-ish and irreversible for that region, so it
 *     goes through an explicit confirm step rather than a bare button.
 */

import { useCallback, useState } from "react";

import { apiFetch } from "../../lib/api";
import { formatUserDateTime } from "../../lib/date";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { useTenantGuard } from "../../lib/platform-context";

export type RedactionRegionRow = {
  id: string;
  kind: string;
  method: string;
  geometry: Record<string, unknown>;
  createdAtUtc: string;
  rationale: string | null;
  sourceDetectionId: string | null;
  sourceProvider: string | null;
  authoredByUserId: string;
};

export function RegionListPanel({
  regions,
  versionLocked,
  onChanged,
}: {
  regions: ReadonlyArray<RedactionRegionRow>;
  versionLocked: boolean;
  onChanged: () => void;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { stamp, isStale } = useTenantGuard();

  const remove = useCallback(
    async (regionId: string) => {
      const captured = stamp();
      setPendingId(regionId);
      setNotice(null);
      try {
        await apiFetch(`/v1/redaction/regions/${encodeURIComponent(regionId)}`, {
          method: "DELETE",
        });
        // §10.3 — a workspace switch mid-flight means this outcome is not
        // about the workspace now on screen. Drop it silently.
        if (isStale(captured)) return;
        setConfirmId(null);
        setNotice("Region removed.");
        onChanged();
      } catch (err) {
        if (isStale(captured)) return;
        // Bounded server denial (VERSION_LOCKED / REGION_INVALID /
        // NOT_PERMITTED) — render the server's decision, never our own.
        const denial = (err as { denial?: string })?.denial;
        if (denial === "VERSION_LOCKED") {
          setNotice(
            "This version is no longer a draft, so its regions can't be changed. Create a new version to make further edits.",
          );
          return;
        }
        if (denial === "REGION_INVALID") {
          setNotice("That region no longer exists. Refresh to see the current list.");
          return;
        }
        if (denial === "NOT_PERMITTED") {
          setNotice("You don't have permission to change regions on this project.");
          return;
        }
        setNotice(
          toSafeUserError(err, {
            message: "We couldn't remove that region.",
          }).message,
        );
      } finally {
        if (!isStale(captured)) setPendingId(null);
      }
    },
    [isStale, onChanged, stamp],
  );

  return (
    <section data-redaction-region-list style={sectionStyle}>
      <header style={headerStyle}>
        <strong style={{ fontSize: 13 }}>Regions on this version</strong>
        <span style={{ flex: 1 }} />
        <small style={{ color: "#475569", fontSize: 11 }}>
          {regions.length} region{regions.length === 1 ? "" : "s"}
        </small>
      </header>

      {notice ? (
        <p data-redaction-region-notice style={noticeStyle}>
          {notice}
        </p>
      ) : null}

      {regions.length === 0 ? (
        <p data-redaction-region-empty style={mutedStyle}>
          No regions yet. Draw one on the viewer above, or accept a
          detection suggestion, to mask part of this record in the
          redacted copy.
        </p>
      ) : (
        <table data-redaction-region-table style={tableStyle}>
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={thStyle}>What</th>
              <th style={thStyle}>How it is masked</th>
              <th style={thStyle}>Where it came from</th>
              <th style={thStyle}>Added</th>
              <th style={thStyle} />
            </tr>
          </thead>
          <tbody>
            {regions.map((r) => (
              <tr key={r.id} data-redaction-region-row={r.id}>
                <td style={tdStyle}>{humaniseKind(r.kind)}</td>
                <td style={tdStyle}>{humaniseMethod(r.method)}</td>
                <td style={tdStyle}>
                  {r.sourceProvider
                    ? `Suggested (${r.sourceProvider})`
                    : "Added by a reviewer"}
                </td>
                <td style={tdStyle}>{safeDate(r.createdAtUtc)}</td>
                <td style={tdStyle}>
                  {versionLocked ? (
                    <span style={mutedStyle}>Locked</span>
                  ) : confirmId === r.id ? (
                    <span style={{ display: "flex", gap: 6 }}>
                      <button
                        type="button"
                        data-redaction-region-remove-confirm={r.id}
                        disabled={pendingId === r.id}
                        onClick={() => void remove(r.id)}
                        style={dangerButtonStyle}
                      >
                        {pendingId === r.id ? "Removing…" : "Confirm remove"}
                      </button>
                      <button
                        type="button"
                        data-redaction-region-remove-cancel={r.id}
                        onClick={() => setConfirmId(null)}
                        style={subtleButtonStyle}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      data-redaction-region-remove={r.id}
                      onClick={() => {
                        setNotice(null);
                        setConfirmId(r.id);
                      }}
                      style={subtleButtonStyle}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {versionLocked && regions.length > 0 ? (
        <p data-redaction-region-locked-note style={mutedStyle}>
          This version is no longer a draft, so its regions are fixed.
          Create a new version to change what is masked.
        </p>
      ) : null}
    </section>
  );
}

function humaniseKind(kind: string): string {
  switch (kind) {
    case "BBOX_NORMALIZED":
      return "Area of the image";
    case "PDF_RECT":
      return "Area of a PDF page";
    case "TEXT_SPAN":
      return "Span of text";
    case "AUDIO_RANGE_MS":
      return "Range of audio";
    case "VIDEO_FRAME_RANGE":
      return "Range of video frames";
    default:
      return humanise(kind);
  }
}

function humaniseMethod(method: string): string {
  switch (method) {
    case "BLACKOUT":
      return "Blacked out";
    case "BLUR":
      return "Blurred";
    case "PIXELATE":
      return "Pixelated";
    case "MUTE":
      return "Muted";
    default:
      return humanise(method);
  }
}

function humanise(value: string): string {
  const spaced = value.replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Timestamps route through the ONE shared formatting layer (Global Timestamp
 * Display Policy) — see DetectionManifestPanel for the full rationale.
 */
const safeDate = (iso: string): string => formatUserDateTime(iso);

const sectionStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid rgba(15, 23, 42, 0.08)",
  borderRadius: 10,
  padding: 10,
};
const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 8,
  marginBottom: 6,
};
const noticeStyle: React.CSSProperties = {
  margin: "0 0 8px",
  padding: "6px 10px",
  borderRadius: 8,
  background: "rgba(15, 23, 42, 0.05)",
  fontSize: 12,
};
const mutedStyle: React.CSSProperties = { color: "#475569", fontSize: 12 };
const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 11,
};
const thStyle: React.CSSProperties = {
  padding: "6px 8px",
  borderBottom: "1px solid #e2e8f0",
};
const tdStyle: React.CSSProperties = {
  padding: "6px 8px",
  borderBottom: "1px solid #f1f5f9",
};
const subtleButtonStyle: React.CSSProperties = {
  padding: "3px 8px",
  border: "1px solid #cbd5e1",
  background: "#fff",
  color: "#0f172a",
  fontSize: 10,
  borderRadius: 6,
  cursor: "pointer",
};
const dangerButtonStyle: React.CSSProperties = {
  padding: "3px 8px",
  border: "1px solid #dc2626",
  background: "#fff",
  color: "#dc2626",
  fontSize: 10,
  borderRadius: 6,
  cursor: "pointer",
};
