"use client";

/**
 * Phase B — Canonical operational breadcrumb.
 *
 * The audit confirmed PROOVRA had NO canonical breadcrumb component
 * before Phase B. Operators on nested surfaces (Matter Workspace,
 * Evidence detail, Evidence Request inspector, Reviewer Console
 * inspector) had no consistent navigation back up the operational
 * hierarchy.
 *
 * This component is the small, opinionated answer:
 *   * Always anchored in the active workspace (`Workspace name`).
 *   * Always shows the Phase B operational group (`Workspace`,
 *     `Governance`, `Outputs`, `System`).
 *   * Always shows the parent surface (e.g., `Matters`).
 *   * Optionally shows the current entity (e.g., `Matter title`).
 *
 * Hard rules:
 *   * Uses `usePlatformContext()` for active workspace — never re-fetches.
 *   * Falls back to a quiet placeholder when context is loading.
 *   * Vocabulary stays operational. No SaaS-flavoured breadcrumbs.
 *   * Does NOT call apiFetch; pure render component.
 */

import Link from "next/link";

import { usePlatformContext } from "../../lib/platform-context";
import {
  operationalGroupDescriptor,
  type PhaseBOperationalGroup,
} from "../../lib/navigation/phaseBOperationalGroups";

export type BreadcrumbItem = {
  /** Operator-readable label rendered for the crumb. */
  label: string;
  /** Optional href. If omitted, the crumb is non-clickable (last/current). */
  href?: string;
};

export function OperationalBreadcrumb({
  /**
   * The canonical route id for the current page, e.g. `workspace.cases`.
   * Drives the Phase B operational group crumb. Pass `null` only on
   * pages that genuinely have no canonical route id.
   */
  routeId,
  /**
   * Additional crumbs to append AFTER the workspace + group + parent
   * crumbs. Use this to surface the entity title (e.g., "Matter title").
   */
  items = [],
}: {
  routeId: string | null;
  items?: ReadonlyArray<BreadcrumbItem>;
}) {
  const ctx = usePlatformContext();
  const groupDescriptor = routeId ? operationalGroupDescriptor(routeId) : null;

  const workspaceLabel =
    ctx.state.name === "READY"
      ? ctx.state.envelope.workspace?.name ?? "Workspace"
      : "Workspace";

  const groupHrefMap: Record<PhaseBOperationalGroup, string> = {
    WORKSPACE: "/home",
    GOVERNANCE: "/governance",
    OUTPUTS: "/reports",
    SYSTEM: "/settings",
  };

  return (
    <nav
      aria-label="Operational breadcrumb"
      data-operational-breadcrumb
      data-operational-group={groupDescriptor?.id ?? ""}
      style={{
        display: "flex",
        gap: 6,
        alignItems: "center",
        flexWrap: "wrap",
        padding: "0.5rem 0.75rem",
        fontSize: 12.5,
        color: "#475569",
      }}
    >
      <Link
        href="/home"
        data-breadcrumb-workspace
        style={{ color: "inherit", textDecoration: "none", fontWeight: 600 }}
      >
        {workspaceLabel}
      </Link>
      {groupDescriptor ? (
        <>
          <span aria-hidden="true" style={{ opacity: 0.5 }}>
            ›
          </span>
          <Link
            href={groupHrefMap[groupDescriptor.id]}
            data-breadcrumb-group={groupDescriptor.id}
            style={{ color: "inherit", textDecoration: "none" }}
          >
            {groupDescriptor.title}
          </Link>
        </>
      ) : null}
      {items.map((item, idx) => {
        const isLast = idx === items.length - 1;
        return (
          <span
            key={`${idx}:${item.label}`}
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <span aria-hidden="true" style={{ opacity: 0.5 }}>
              ›
            </span>
            {item.href && !isLast ? (
              <Link
                href={item.href}
                data-breadcrumb-item
                style={{ color: "inherit", textDecoration: "none" }}
              >
                {item.label}
              </Link>
            ) : (
              <span
                data-breadcrumb-current={isLast ? "true" : "false"}
                style={{
                  color: isLast ? "#0f172a" : "inherit",
                  fontWeight: isLast ? 600 : 400,
                }}
              >
                {item.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
