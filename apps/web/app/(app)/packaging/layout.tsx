"use client";

/**
 * Phase IA-self-serve-simplification — ENTERPRISE-tier route group
 * gate. Re-exports the shared `EnterpriseSurfaceLayout` so every page
 * in this directory inherits the surface-tier visibility check. Non-
 * eligible users hitting this URL directly are redirected (or 404'd
 * per the rule table) by `SurfaceGate` before the page renders.
 */

export { default } from "../../../components/surface/EnterpriseSurfaceLayout";
