"use client";

import type { ReactNode } from "react";
import { PageHeader, PageShell } from "../ui";
import { dashboardStyles } from "./styles";

/**
 * The frame for the two usage pages (Batch Analysis, Usage & Quotas).
 *
 * It used to paint its own hero in near-white and mint for the retired dark
 * page, which left the heading almost invisible on the light content plane. It
 * now composes the canonical PageShell and PageHeader, so these pages carry
 * the same header as every other authenticated page.
 */
export default function DashboardShell({
  eyebrow,
  title,
  highlight,
  description,
  action,
  children,
}: {
  eyebrow: string;
  title: string;
  highlight?: string;
  description: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <PageShell>
      <PageHeader
        eyebrow={eyebrow}
        title={highlight ? `${title} ${highlight}` : title}
        subtitle={description}
        primaryAction={action}
      />
      <div style={dashboardStyles.pageGrid}>{children}</div>
    </PageShell>
  );
}
