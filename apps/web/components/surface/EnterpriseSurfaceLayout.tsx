"use client";

/**
 * Phase IA-surface-tier — reusable layout wrapper for ENTERPRISE
 * route groups.
 *
 * Each ENTERPRISE route directory under `apps/web/app/(app)` exports a
 * `layout.tsx` that simply re-exports `EnterpriseSurfaceLayout` as
 * `default`. The SurfaceGate inside this layout consults the canonical
 * PlatformContext + the static tier table to decide whether the route
 * renders, redirects, or 404s.
 *
 * Why a layout (and not a per-page guard):
 *   - One mount-point covers the root page + every sub-page in the
 *     route directory. No risk of a new sub-page being added without
 *     the gate.
 *   - Hook order on each page is unchanged — the gate decision happens
 *     above the page render boundary.
 *   - Matches the existing pattern at `apps/web/app/(app)/admin/layout.tsx`
 *     which gates the entire admin tree with `PageRouteGate`.
 *
 * Backend RBAC on the underlying API routes remains the authoritative
 * security boundary. This gate is the UX-layer enforcement.
 */

import type { ReactNode } from "react";

import { SurfaceGate } from "./SurfaceGate";

export function EnterpriseSurfaceLayout({ children }: { children: ReactNode }) {
  return <SurfaceGate>{children}</SurfaceGate>;
}

export default EnterpriseSurfaceLayout;
