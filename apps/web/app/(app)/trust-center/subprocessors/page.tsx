"use client";

/**
 * Subprocessor registry surface — 2026-07-18 canonical redesign.
 *
 * The authenticated registry now renders inside the ONE canonical
 * legal-document shell (same hero family, page background, reading
 * width, table typography as the public /legal/[slug] pages). The
 * legacy inline admin header/table styles are deleted. Behavior
 * (refresh, canonical re-seed, degraded/error states, data-* markers)
 * is unchanged.
 */

import { useCallback, useEffect, useState } from "react";

import type { SubprocessorProjection } from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../../lib/api";
import { formatUserDate } from "../../../../lib/date";
import { LegalDocumentShell } from "../../../../components/legal/LegalDocumentShell";

export default function SubprocessorsPage() {
  return (
    <PageRouteGate routeId="workspace.trust_center">
      <Shell />
    </PageRouteGate>
  );
}

function Shell() {
  const [rows, setRows] = useState<ReadonlyArray<SubprocessorProjection>>([]);
  const [reason, setReason] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function degradedMessage(code: string) {
    switch (code) {
      case "SCHEMA_NOT_READY":
        return "The Subprocessor Registry is temporarily degraded because the required backend schema is not ready yet.";
      case "DB_UNAVAILABLE":
        return "The Subprocessor Registry is temporarily degraded because the database is unavailable.";
      case "SUBPROCESSOR_AUTO_SEED_FAILED":
        return "The Subprocessor Registry is temporarily degraded because the canonical vendor seed could not be prepared.";
      case "SUBPROCESSOR_READ_FAILED":
      default:
        return "The Subprocessor Registry is temporarily degraded because subprocessors could not be loaded safely.";
    }
  }

  const refresh = useCallback(async () => {
    setBusy(true);
    setFailed(null);
    try {
      const res = await apiFetch("/v1/trust/subprocessors", { method: "GET" });
      if ((res as { degraded?: boolean } | null)?.degraded) {
        setRows([]);
        setReason(
          String(
            (res as { reason?: string | null } | null)?.reason ??
              "SUBPROCESSOR_READ_FAILED",
          ),
        );
        return;
      }
      setReason(null);
      setRows((res?.subprocessors ?? []) as ReadonlyArray<SubprocessorProjection>);
    } catch {
      setRows([]);
      setReason(null);
      setFailed("Subprocessors could not be loaded. Press Refresh to try again.");
    } finally {
      setBusy(false);
    }
  }, []);

  const seedDefaults = useCallback(async () => {
    setBusy(true);
    setFailed(null);
    try {
      await apiFetch("/v1/trust/subprocessors/seed", { method: "POST" });
      await refresh();
    } catch {
      setFailed("The canonical subprocessor seed could not be applied.");
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const buttonClasses =
    "rounded-lg border px-3 py-1.5 text-[12px] font-semibold disabled:opacity-60";

  return (
    <div data-subprocessors-page>
      <LegalDocumentShell
        label="Trust documentation"
        title="Subprocessor Registry"
        summary="Authoritative list of vendors that may process customer data. Every entry is versioned; every change writes an audit row."
        scope="ACCOUNT"
        backHref="/trust"
        backLabel="Open public Trust Center"
        relatedLinks={[
          { label: "Subprocessors (full document)", href: "/settings/legal/subprocessors" },
          { label: "Data Processing Agreement", href: "/settings/legal/dpa" },
          { label: "Data Retention Policy", href: "/settings/legal/data-retention" },
        ]}
      >
        <div className="mb-6 flex flex-wrap gap-2">
          <button
            type="button"
            data-subprocessors-refresh
            onClick={() => void refresh()}
            disabled={busy}
            className={`${buttonClasses} border-[#0F172A] bg-[#0F172A] text-white hover:opacity-90`}
          >
            {busy ? "Loading…" : "Refresh"}
          </button>
          <button
            type="button"
            data-subprocessors-seed
            onClick={() => void seedDefaults()}
            disabled={busy}
            className={`${buttonClasses} border-[#DDE6F2] bg-white text-[#0F172A] hover:border-[#94A3B8]`}
          >
            Re-seed defaults
          </button>
        </div>

        {reason ? (
          <div
            data-subprocessors-phase="degraded"
            data-subprocessors-reason={reason}
            className="mb-4 grid gap-1.5 rounded-lg border border-[rgba(148,163,184,0.28)] bg-[rgba(148,163,184,0.10)] px-4 py-3 text-[0.9rem] text-[#334155]"
          >
            <div>{degradedMessage(reason)}</div>
            <div>
              Reason: <code>{reason}</code>
            </div>
          </div>
        ) : null}
        {failed ? (
          <div
            data-subprocessors-phase="error"
            role="alert"
            className="mb-4 rounded-lg border border-[rgba(185,28,28,0.20)] bg-[rgba(185,28,28,0.06)] px-4 py-3 text-[0.9rem] text-[#7f1d1d]"
          >
            {failed}
          </div>
        ) : null}

        {/* Aligned onto the canonical legal-table system (2026-07-20):
            same scroll region, card chrome, min-column widths, edge
            padding, and wide-table breakout as every markdown table —
            without routing this live data through markdown. Cell
            typography still comes from the shell's article chain. */}
        <div className="legal-table-wrapper">
          <table data-subprocessors-table className="legal-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Vendor</th>
                <th>Purpose</th>
                <th>Region</th>
                <th>Data categories</th>
                <th>State</th>
                <th>Version</th>
                <th>Effective</th>
                <th>Docs</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !reason && !failed ? (
                <tr>
                  <td colSpan={9}>No subprocessors registered.</td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr
                    key={r.id}
                    data-subprocessor-row={r.slug}
                    data-subprocessor-state={r.state}
                  >
                    <td>
                      <strong>{r.name}</strong>
                    </td>
                    <td>{r.vendor}</td>
                    <td>{r.purpose}</td>
                    <td>{r.region}</td>
                    <td>
                      {r.dataCategories.map((c) => (
                        <code key={c} className="mb-1 mr-1 inline-block">
                          {c}
                        </code>
                      ))}
                    </td>
                    <td>{r.state}</td>
                    <td>v{r.version}</td>
                    <td>{formatUserDate(r.effectiveAtUtc)}</td>
                    <td>
                      {r.documentationUrl ? (
                        <a
                          href={r.documentationUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="legal-link"
                        >
                          Vendor documentation
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </LegalDocumentShell>
    </div>
  );
}
