"use client";

/**
 * Compact sidebar plan meter: storage and, where the plan caps them, records.
 *
 * Lives in its OWN file (not inside AppSidebarV2.tsx) on purpose: the
 * Phase 38.9 source-contract test greps AppSidebarV2.tsx for `apiFetch`
 * and fails if present. The data fetch therefore lives HERE; the sidebar
 * only imports + renders <SidebarStorageWidget />.
 *
 * Data source (Free-user audit 0ea0, B2A-F-01/02/03): the viewer's PERSONAL
 * billing account projection, read through `readPersonalAllowance` — the same
 * read Capture makes. The labels are the SERVER's (`formatBytesHuman`, binary
 * units printed as "MB"/"GB", which is how Pricing states Free's 250 MB); the
 * browser no longer reformats bytes into two-decimal GB, which turned Free's
 * 250 MB into "0.24 GB" and 5 MB into "0 GB".
 *
 * WHOSE METER: only the viewer's own Personal Space is measured by their
 * personal account. In a workspace somebody else pays for (a joined personal
 * workspace, someone else's Owned Workspace, an organization) the meter is
 * not shown at all — the personal figures are not that workspace's, and the
 * API exposes no member-readable usage projection for it yet (CROSS-LANE).
 *
 * FRESHNESS: re-read on a workspace switch, when Capture signals a sealed or
 * discarded record (`USAGE_CHANGED_EVENT`), and on window focus (throttled).
 *
 * Real values only. While loading or on any error/missing data the widget
 * renders nothing — it never shows fabricated numbers.
 *
 * Collapsed-rail behaviour mirrors `.app-sidebar-v2-help`: the text + bar
 * fade in only when the rail is hovered/focused (see the
 * `.app-sidebar-v2-storage` rules in app-shell-v2.css).
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { isOwnPersonalActiveSpace } from "../../lib/billing/active-space-billing";
import {
  readPersonalAllowance,
  recordAllowanceLabel,
  USAGE_CHANGED_EVENT,
  type PersonalAllowance,
} from "../../lib/billing/personal-allowance";
import { useOptionalPlatformContext } from "../../lib/platform-context/PlatformContextProvider";

/** Minimum time between focus-triggered re-reads. */
export const SIDEBAR_METER_FOCUS_REFRESH_MS = 30_000;

export function SidebarStorageWidget() {
  const ctx = useOptionalPlatformContext();
  const envelope = ctx?.envelope ?? null;
  const ownPersonal = isOwnPersonalActiveSpace(envelope);
  const spaceKey = ownPersonal ? envelope?.activeSpace?.id ?? "personal" : null;
  const [view, setView] = useState<PersonalAllowance | null>(null);
  const lastReadRef = useRef(0);

  useEffect(() => {
    setView(null);
    if (!spaceKey) return undefined;
    let alive = true;
    const read = () => {
      lastReadRef.current = Date.now();
      readPersonalAllowance()
        .then((res) => {
          if (alive) setView(res);
        })
        .catch(() => {
          // On error render nothing — never fabricate storage numbers.
          if (alive) setView(null);
        });
    };
    read();
    const onChanged = () => read();
    const onFocus = () => {
      if (Date.now() - lastReadRef.current >= SIDEBAR_METER_FOCUS_REFRESH_MS) read();
    };
    window.addEventListener(USAGE_CHANGED_EVENT, onChanged);
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      window.removeEventListener(USAGE_CHANGED_EVENT, onChanged);
      window.removeEventListener("focus", onFocus);
    };
  }, [spaceKey]);

  // Not the viewer's own space / loading / error / no data — render nothing.
  if (!spaceKey || !view) return null;
  const storage = view.storage;
  const recordsLabel = recordAllowanceLabel(view.records);
  if (!storage && !recordsLabel) return null;
  const recordsExhausted = view.records !== null && view.records.cap !== null && !view.records.nextAllowed;
  const percent = storage ? Math.round(storage.usagePercent * 10) / 10 : null;

  return (
    <div className="app-sidebar-v2-storage" data-sidebar-storage>
      <div className="app-sidebar-v2-storage-body">
        {storage && percent !== null ? (
          <>
            <div className="app-sidebar-v2-storage-head">
              <span className="app-sidebar-v2-storage-label">Storage</span>
              <span className="app-sidebar-v2-storage-percent">{percent}%</span>
            </div>
            <div
              className="app-sidebar-v2-storage-track"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Storage used"
            >
              <div className="app-sidebar-v2-storage-fill" style={{ width: `${percent}%` }} />
            </div>
            <div className="app-sidebar-v2-storage-detail" data-sidebar-storage-detail>
              {storage.usedLabel} of {storage.limitLabel}
            </div>
          </>
        ) : null}
        {recordsLabel ? (
          <div className="app-sidebar-v2-storage-detail" data-sidebar-records={recordsLabel}>
            {recordsLabel}
            {recordsExhausted ? (
              <>
                {" · "}
                <Link href="/billing" data-sidebar-records-limit>
                  Limit reached
                </Link>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
