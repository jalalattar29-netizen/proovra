"use client";

import { useEffect } from "react";

/**
 * PROOVRA V2 — opt-in switch for the redesigned shell chrome.
 *
 * The (app) layout wraps EVERY internal route in the single shared
 * `AppShellV2`. Replacing that shell globally would visually migrate
 * unrelated pages, which this phase explicitly must not do. Instead the
 * migrated surface marks the document while it is mounted and the V2
 * sheet scopes all sidebar/topbar restyling under
 * `:root[data-pv2-surface]`.
 *
 * Semantics:
 *   - presentation only. No route, capability, membership, workspace,
 *     organization, or lifecycle behaviour is touched.
 *   - mount sets the attribute, unmount removes it, so navigating away
 *     from the migrated route restores the previous chrome exactly.
 *   - the attribute VALUE names the surface so future migrations can be
 *     scoped or audited individually.
 *
 * This mirrors the existing `(app)/layout.tsx` convention, which already
 * toggles `has-app-decor` / `is-internal-app` on <body> for the same
 * layout-scoped-styling reason.
 */
export function useProovraV2Surface(surface: string): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const previous = root.getAttribute("data-pv2-surface");
    root.setAttribute("data-pv2-surface", surface);
    return () => {
      if (previous === null) {
        root.removeAttribute("data-pv2-surface");
      } else {
        root.setAttribute("data-pv2-surface", previous);
      }
    };
  }, [surface]);
}
