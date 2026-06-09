"use client";

/**
 * Phase IA-surface-tier — ENTERPRISE-tier route group gate.
 *
 * Re-exports the shared `EnterpriseSurfaceLayout` so every page in
 * this directory inherits the surface-tier visibility check. Non-
 * eligible users hitting this URL directly get 404'd by `SurfaceGate`
 * via Next.js `notFound()`.
 */

export { default } from "../../../components/surface/EnterpriseSurfaceLayout";
