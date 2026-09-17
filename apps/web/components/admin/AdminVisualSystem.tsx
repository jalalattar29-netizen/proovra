"use client";

/**
 * THE ADMINISTRATIVE VISUAL SYSTEM, AS ONE COMPONENT.
 *
 * The `adm-*` / `apf-*` classes the administrative surfaces are built from are
 * defined in two stylesheets, and most of their rules are scoped under
 * `body.is-admin-console` — so they apply only while that body class is set.
 * The class is ALSO what turns off the product decor (the gradient on
 * `body.has-app-decor` and the photograph on `.app-shell-v2`): an operations
 * table read for hours beside a terminal should not sit on a marketing ground.
 *
 * This used to live inline in `app/(app)/admin/layout.tsx`, which was fine
 * while every administrative page lived under `/admin`. PV-PLACE-001 moved the
 * workspace-administration pages to their tenant homes (`/security-center/*`,
 * `/operations/*`); they were designed and visually verified on this system,
 * and they keep it by rendering inside this component rather than by
 * reimplementing it.
 *
 * Added and removed symmetrically, so leaving an administrative page restores
 * the product ground. It carries no gate and no navigation — only the look.
 */

import { useEffect, type ReactNode } from "react";

import "./admin-console.css";
import "../../app/(app)/admin/admin-system.css";

export function AdminVisualSystem({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.body.classList.add("is-admin-console");
    return () => document.body.classList.remove("is-admin-console");
  }, []);
  return <>{children}</>;
}
