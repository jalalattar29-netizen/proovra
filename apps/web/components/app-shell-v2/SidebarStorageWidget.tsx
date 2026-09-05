"use client";

/**
 * Compact sidebar storage widget.
 *
 * Lives in its OWN file (not inside AppSidebarV2.tsx) on purpose: the
 * Phase 38.9 source-contract test greps AppSidebarV2.tsx for `apiFetch`
 * and fails if present. The data fetch therefore lives HERE; the sidebar
 * only imports + renders <SidebarStorageWidget />.
 *
 * Data source: GET /v1/billing/overview → workspaces.personal.storage.
 * Real values only. While loading or on any error/missing data the widget
 * renders nothing — it never shows fabricated numbers.
 *
 * Collapsed-rail behaviour mirrors `.app-sidebar-v2-help`: the text + bar
 * fade in only when the rail is hovered/focused (see the
 * `.app-sidebar-v2-storage` rules in app-shell-v2.css).
 */

import { useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";
import { inFlightGet } from "../../lib/inFlightGet";

type StorageInfo = {
  usedBytes?: string;
  limitBytes?: string;
  usedLabel?: string;
  limitLabel?: string;
  usagePercent?: number | null;
};

type BillingOverview = {
  workspaces?: {
    personal?: {
      storage?: StorageInfo | null;
    } | null;
  } | null;
};

type StorageView = {
  percent: number;
  usedLabel: string;
  limitLabel: string;
};

const GB = 1024 * 1024 * 1024;

/** Parse a byte string ("10412345678") to a finite number, else null. */
function parseBytes(raw: string | undefined): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Format a byte count as GB with one decimal ("10.41 GB"), whole numbers stay whole. */
function bytesToGbLabel(bytes: number): string {
  const gb = bytes / GB;
  const rounded = Math.round(gb * 100) / 100;
  const display = Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(rounded < 100 ? 2 : 0);
  return `${display} GB`;
}

/**
 * Derive the compact view from the real billing response. Returns null
 * whenever the numbers can't be shown honestly (no storage block, no
 * usable byte/percent data).
 */
function toView(storage: StorageInfo | null | undefined): StorageView | null {
  if (!storage) return null;

  const usedBytes = parseBytes(storage.usedBytes);
  const limitBytes = parseBytes(storage.limitBytes);

  // Percent: prefer the server-computed value; otherwise derive from bytes.
  let percent: number | null =
    typeof storage.usagePercent === "number" ? storage.usagePercent : null;
  if (percent == null && usedBytes != null && limitBytes != null && limitBytes > 0) {
    percent = (usedBytes / limitBytes) * 100;
  }
  if (percent == null) return null;
  percent = Math.min(100, Math.max(0, Math.round(percent * 10) / 10));

  // Labels: prefer computed GB from real bytes; fall back to server labels.
  const usedLabel =
    usedBytes != null ? bytesToGbLabel(usedBytes) : storage.usedLabel ?? null;
  const limitLabel =
    limitBytes != null ? bytesToGbLabel(limitBytes) : storage.limitLabel ?? null;
  if (usedLabel == null || limitLabel == null) return null;

  return { percent, usedLabel, limitLabel };
}

export function SidebarStorageWidget() {
  const [view, setView] = useState<StorageView | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Shared with Home's own read of the same endpoint when both mount
    // together, which on Home they always do — this widget is in the shell.
    inFlightGet<BillingOverview>("/v1/billing/overview", () =>
      apiFetch("/v1/billing/overview", { method: "GET" }),
    )
      .then((res: BillingOverview) => {
        if (cancelled) return;
        setView(toView(res?.workspaces?.personal?.storage));
      })
      .catch(() => {
        // On error render nothing — never fabricate storage numbers.
        if (!cancelled) setView(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Loading / error / no-data — render nothing rather than fake values.
  if (!view) return null;

  return (
    <div className="app-sidebar-v2-storage" data-sidebar-storage>
      <div className="app-sidebar-v2-storage-body">
        <div className="app-sidebar-v2-storage-head">
          <span className="app-sidebar-v2-storage-label">Storage</span>
          <span className="app-sidebar-v2-storage-percent">{view.percent}%</span>
        </div>
        <div
          className="app-sidebar-v2-storage-track"
          role="progressbar"
          aria-valuenow={view.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Storage used"
        >
          <div
            className="app-sidebar-v2-storage-fill"
            style={{ width: `${view.percent}%` }}
          />
        </div>
        <div className="app-sidebar-v2-storage-detail">
          {view.usedLabel} of {view.limitLabel}
        </div>
      </div>
    </div>
  );
}
