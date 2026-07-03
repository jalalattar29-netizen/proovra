/**
 * TechnicalAppendixCard — enterprise card shell for one appendix section.
 *
 * Clean bordered card with a header (icon + title + optional badge/subtitle)
 * and a body. Used by every section so the appendix reads as a cohesive
 * responsive card grid, not a debug table.
 */

"use client";

import type { ComponentType, ReactNode } from "react";
import type { LucideProps } from "lucide-react";

export function TechnicalAppendixCard({
  icon: Icon,
  title,
  subtitle,
  badge,
  testId,
  children,
}: {
  icon: ComponentType<LucideProps>;
  title: string;
  subtitle?: ReactNode;
  badge?: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <section className="ta-card" data-testid={testId} data-ta-section={testId}>
      <header className="ta-card-head">
        <span className="ta-card-icon" aria-hidden>
          <Icon size={16} />
        </span>
        <div className="ta-card-titles">
          <h3 className="ta-card-title">{title}</h3>
          {subtitle ? <p className="ta-card-subtitle">{subtitle}</p> : null}
        </div>
        {badge ? <div className="ta-card-badge">{badge}</div> : null}
      </header>
      <div className="ta-card-body">{children}</div>
    </section>
  );
}
