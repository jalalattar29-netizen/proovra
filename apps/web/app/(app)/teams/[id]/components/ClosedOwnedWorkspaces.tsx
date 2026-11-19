"use client";

/**
 * PRO-T1-01 / PRO-NA-02 — the door back into a CLOSED workspace.
 *
 * A completed closure revokes every membership, the owner's included, so the
 * closed workspace leaves the switcher and `GET /v1/teams/:id` refuses it; the
 * only Reopen control lived behind that read. `GET /v1/teams` now also lists
 * `closedOwned` — the workspaces the caller owns of record that are closed now —
 * and each renders the canonical closure card (whose closure read the server
 * answers for a closed workspace's owner of record).
 *
 * An older API omits `closedOwned`: this renders nothing, exactly as before.
 */
import { useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { formatUserDate } from "../../../../../lib/date";
import { WorkspaceClosureCard } from "./WorkspaceClosureCard";

type ClosedOwned = { id: string; name: string | null; closedAtUtc: string | null };

export function ClosedOwnedWorkspaces() {
  const [rows, setRows] = useState<ClosedOwned[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = (await apiFetch("/v1/teams")) as { closedOwned?: unknown };
        const list = Array.isArray(res.closedOwned) ? (res.closedOwned as ClosedOwned[]) : [];
        if (!cancelled) setRows(list.filter((r) => typeof r?.id === "string"));
      } catch {
        if (!cancelled) setRows([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (rows.length === 0) return null;
  return (
    <section className="app-section-stack" data-closed-owned-workspaces>
      <h3 className="app-panel__title" style={{ margin: 0 }}>
        Closed workspaces you own
      </h3>
      {rows.map((row) => (
        <div key={row.id} data-closed-owned-workspace={row.id}>
          <p className="app-table__muted" style={{ margin: "0 0 6px" }}>
            {row.name ?? "Workspace"}
            {row.closedAtUtc ? ` — closed ${formatUserDate(row.closedAtUtc)}` : ""}
          </p>
          <WorkspaceClosureCard teamId={row.id} />
        </div>
      ))}
    </section>
  );
}
