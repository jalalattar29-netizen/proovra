"use client";

/**
 * Phase A1 (UI) — Runtime AI capability disclosure table.
 *
 * Renders the backend-computed capability statuses (GET /v1/workspaces/ai-policy
 * → capabilities[]). Status is NEVER inferred client-side; a stub is shown as a
 * stub, previews as previews. No secrets, no prompts.
 */
import { useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";
import { useActiveWorkspaceId } from "../../lib/platform-context";

type Capability = {
  capability: string;
  provider: string;
  purpose: string;
  dataCategory: string;
  rawContent: boolean;
  defaultState: string;
  workspaceOptInRequired: boolean;
  workspacePolicyState: string;
  operationalStatus: string;
  region: string;
  transferMechanism: string;
  trainingMode: string;
  retentionMode: string;
  lastVerifiedAtUtc: string;
  note: string;
};

const STATUS_STYLE: Record<string, string> = {
  AVAILABLE: "app-chip--ok",
  ENABLED_FOR_THIS_WORKSPACE: "app-chip--ok",
  CONFIGURED: "",
  DISABLED_BY_WORKSPACE_POLICY: "app-chip--warn",
  DISABLED_BY_PLATFORM_CONFIGURATION: "app-chip--warn",
  NOT_CONFIGURED: "",
  PREVIEW: "app-chip--warn",
  PLANNED: "",
  STUB_NOT_OPERATIONAL: "app-chip--warn",
  RETIRED: "",
};

function statusLabel(s: string): string {
  return s.replaceAll("_", " ").toLowerCase();
}

export function AiCapabilityStatusTable() {
  const teamId = useActiveWorkspaceId();
  const [caps, setCaps] = useState<Capability[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!teamId) return;
    (async () => {
      try {
        const res = (await apiFetch(`/v1/workspaces/ai-policy?teamId=${teamId}`)) as { capabilities?: Capability[] };
        if (!cancelled) setCaps(res.capabilities ?? []);
      } catch {
        if (!cancelled) setError("Live capability status is unavailable right now.");
      }
    })();
    return () => { cancelled = true; };
  }, [teamId]);

  if (!teamId) return null;

  return (
    <section className="app-card" style={{ marginBottom: 16 }} aria-label="Live AI capability status">
      <h3 style={{ marginTop: 0 }}>Live AI capability status (this workspace)</h3>
      <p style={{ fontSize: 13, opacity: 0.75, marginTop: 4 }}>
        Computed from the actual platform configuration and this workspace&apos;s AI policy —
        never inferred from the existence of code or a provider key. Stubs and previews are
        labelled as such.
      </p>
      {error ? <div className="app-alert">{error}</div> : null}
      {!caps && !error ? <p style={{ opacity: 0.6 }}>Loading live status…</p> : null}
      {caps ? (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", opacity: 0.7 }}>
                <th style={{ padding: "6px 8px" }}>Capability</th>
                <th style={{ padding: "6px 8px" }}>Provider</th>
                <th style={{ padding: "6px 8px" }}>Data</th>
                <th style={{ padding: "6px 8px" }}>Default</th>
                <th style={{ padding: "6px 8px" }}>Opt-in</th>
                <th style={{ padding: "6px 8px" }}>Status</th>
                <th style={{ padding: "6px 8px" }}>Training / retention</th>
              </tr>
            </thead>
            <tbody>
              {caps.map((c) => (
                <tr key={c.capability} style={{ borderTop: "1px solid var(--app-border,#eee)" }}>
                  <td style={{ padding: "6px 8px" }}>
                    <div>{c.capability}</div>
                    <div style={{ fontSize: 11, opacity: 0.6 }}>{c.purpose}</div>
                  </td>
                  <td style={{ padding: "6px 8px" }}>
                    <div>{c.provider}</div>
                    <div style={{ fontSize: 11, opacity: 0.6 }}>{c.region} · {c.transferMechanism}</div>
                  </td>
                  <td style={{ padding: "6px 8px" }}>
                    <span className={`app-chip ${c.rawContent ? "app-chip--warn" : ""}`}>
                      {c.dataCategory.replaceAll("_", " ").toLowerCase()}
                    </span>
                  </td>
                  <td style={{ padding: "6px 8px" }}>{c.defaultState}</td>
                  <td style={{ padding: "6px 8px" }}>{c.workspaceOptInRequired ? "required" : "—"}</td>
                  <td style={{ padding: "6px 8px" }}>
                    <span className={`app-chip ${STATUS_STYLE[c.operationalStatus] ?? ""}`}>
                      {statusLabel(c.operationalStatus)}
                    </span>
                  </td>
                  <td style={{ padding: "6px 8px", fontSize: 12, opacity: 0.8 }}>
                    <div>{c.trainingMode}</div>
                    <div style={{ opacity: 0.7 }}>{c.retentionMode}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {caps && caps.length > 0 ? (
        <p style={{ fontSize: 11, opacity: 0.6, marginTop: 8 }}>
          Last verified {new Date(caps[0]!.lastVerifiedAtUtc).toLocaleString()} · statuses refresh on load.
        </p>
      ) : null}
    </section>
  );
}
