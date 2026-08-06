"use client";

/**
 * PHASE 12B (Evidence Operations) — Detection manifest panel.
 *
 * Product consumer for
 * `GET /v1/redaction/evidence/:evidenceId/detection-manifest`
 * (services/api/src/routes/redaction.routes.ts). The manifest is the
 * bounded, count-only record of WHAT was detected and HOW it was decided
 * for every PUBLISHED version of a record — the same shape the
 * verification package and report ship. Until now it had no product
 * surface: an operator could publish a redaction and never see the
 * detection record that will travel with it.
 *
 * Contract:
 *   * Read-only. Counts + bounded enum codes only — the API never
 *     returns detection text, geometry, or rationale.
 *   * Workspace binding is SERVER-held: the route resolves the workspace
 *     from `currentWorkspaceId`, runs the canonical authorization
 *     primitive, and then gates on `redaction.view`. This component sends
 *     no workspace id and cannot widen the scope.
 *   * Stale-context rejection: a response that lands after a workspace
 *     switch is dropped.
 *   * Denial + error states are the SERVER's decision rendered safely,
 *     never a client-side policy judgement.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";
import { formatUserDateTime } from "../../lib/date";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import {
  useActiveWorkspaceId,
  useTenantGuard,
} from "../../lib/platform-context";

type ManifestEntry = {
  projectId: string;
  evidenceId: string;
  versionId: string;
  versionOrdinal: number;
  publishedAtUtc: string | null;
  totalDetections: number;
  perProvider: Record<string, number>;
  perKind: Record<string, number>;
  perDecision: Record<string, number>;
  perConfidence: Record<string, number>;
  providerProbes: ReadonlyArray<{
    provider: string;
    state: string;
    reason?: string | null;
  }>;
};

type Manifest = {
  schemaVersion: string;
  generatedAtUtc: string;
  teamId: string;
  evidenceId: string;
  entries: ReadonlyArray<ManifestEntry>;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "denied"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; manifest: Manifest };

export function DetectionManifestPanel({
  evidenceId,
}: {
  evidenceId: string;
}) {
  const workspaceId = useActiveWorkspaceId();
  const { stamp, isStale } = useTenantGuard();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const load = useCallback(async () => {
    const captured = stamp();
    setState({ kind: "loading" });
    try {
      const res = await apiFetch(
        `/v1/redaction/evidence/${encodeURIComponent(
          evidenceId,
        )}/detection-manifest`,
        { method: "GET" },
      );
      if (isStale(captured)) return;
      const manifest = res?.manifest as Manifest | undefined;
      if (!manifest || manifest.evidenceId !== evidenceId) {
        setState({
          kind: "denied",
          message:
            "A detection record is not available for this evidence in the workspace you are in.",
        });
        return;
      }
      setState({ kind: "ready", manifest });
    } catch (err) {
      if (isStale(captured)) return;
      const status = (err as { statusCode?: number })?.statusCode;
      const denial = (err as { denial?: string })?.denial;
      if (status === 403 || status === 404 || denial === "NOT_PERMITTED") {
        setState({
          kind: "denied",
          message:
            "You don't have permission to view the detection record for this workspace.",
        });
        return;
      }
      setState({
        kind: "error",
        message: toSafeUserError(err, {
          message: "We couldn't load the detection record.",
        }).message,
      });
    }
  }, [evidenceId, isStale, stamp]);

  useEffect(() => {
    void load();
  }, [load, workspaceId]);

  return (
    <section
      data-redaction-detection-manifest
      data-redaction-detection-manifest-state={state.kind}
      style={sectionStyle}
    >
      <header style={headerStyle}>
        <strong style={{ fontSize: 13 }}>Detection record</strong>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-redaction-detection-manifest-refresh
          onClick={() => void load()}
          disabled={state.kind === "loading"}
          style={subtleButtonStyle}
        >
          {state.kind === "loading" ? "Loading…" : "Refresh"}
        </button>
      </header>
      <p style={mutedStyle}>
        What automated detection found, and what a reviewer decided, for
        each published version. This is the same summary that travels with
        the verification package and the report.
      </p>

      {state.kind === "loading" ? (
        <p data-redaction-detection-manifest-loading style={mutedStyle}>
          Loading the detection record…
        </p>
      ) : null}

      {state.kind === "denied" ? (
        <p data-redaction-detection-manifest-denied style={mutedStyle}>
          {state.message}
        </p>
      ) : null}

      {state.kind === "error" ? (
        <p data-redaction-detection-manifest-error style={errorStyle}>
          {state.message}
        </p>
      ) : null}

      {state.kind === "ready" && state.manifest.entries.length === 0 ? (
        <p data-redaction-detection-manifest-empty style={mutedStyle}>
          Nothing published yet, so there is no detection record for this
          record. It is created when a version is published.
        </p>
      ) : null}

      {state.kind === "ready" && state.manifest.entries.length > 0 ? (
        <div data-redaction-detection-manifest-entries style={{ display: "grid", gap: 10 }}>
          {state.manifest.entries.map((e) => (
            <div
              key={e.versionId}
              data-redaction-detection-manifest-entry={e.versionId}
              style={entryStyle}
            >
              <div style={{ fontSize: 12, fontWeight: 600 }}>
                Version v{e.versionOrdinal}
                {e.publishedAtUtc
                  ? ` · published ${safeDate(e.publishedAtUtc)}`
                  : ""}
              </div>
              <div style={mutedStyle}>
                {e.totalDetections} detection
                {e.totalDetections === 1 ? "" : "s"} reviewed
              </div>
              <CountRow label="By decision" counts={e.perDecision} />
              <CountRow label="By kind" counts={e.perKind} />
              <CountRow label="By detector" counts={e.perProvider} />
              <CountRow label="By confidence" counts={e.perConfidence} />
              {e.providerProbes.length > 0 ? (
                <div style={mutedStyle}>
                  Detector availability at the time:{" "}
                  {e.providerProbes
                    .map((p) => `${p.provider} — ${humanise(p.state)}`)
                    .join(" · ")}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function CountRow({
  label,
  counts,
}: {
  label: string;
  counts: Record<string, number>;
}) {
  const entries = Object.entries(counts ?? {});
  if (entries.length === 0) return null;
  return (
    <div style={mutedStyle}>
      {label}:{" "}
      {entries.map(([k, v]) => `${humanise(k)} ${v}`).join(" · ")}
    </div>
  );
}

function humanise(value: string): string {
  const spaced = value.replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Timestamps route through the ONE shared formatting layer (Global Timestamp
 * Display Policy). `new Date(iso).toLocaleString()` rendered in the machine's
 * locale with an unlabelled offset, so the same instant read differently for
 * every viewer and the zone was never stated. `formatUserDateTime` renders the
 * viewer's IANA zone explicitly and returns its own bounded fallback, so the
 * try/catch and the raw-ISO passthrough are no longer needed.
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
};
const entryStyle: React.CSSProperties = {
  border: "1px solid rgba(15, 23, 42, 0.08)",
  borderRadius: 8,
  padding: 8,
  display: "grid",
  gap: 3,
};
const mutedStyle: React.CSSProperties = {
  color: "#475569",
  fontSize: 11,
  margin: "4px 0 0",
};
const errorStyle: React.CSSProperties = {
  color: "#7f1d1d",
  fontSize: 12,
  margin: "6px 0 0",
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
