"use client";

import type { ReactNode } from "react";
import { dashboardStyles } from "./styles";

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
    <div className="section app-section">
      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title app-page-title" style={{ marginBottom: 0 }}>
            <div style={{ maxWidth: 820 }}>
              <div style={dashboardStyles.heroChip}>
                <span style={dashboardStyles.heroDot} />
                {eyebrow}
              </div>

              <h1 className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]">
                {title}{" "}
                {highlight ? <span className="text-[#c3ebe2]">{highlight}</span> : null}
              </h1>

              <p className="mt-5 max-w-[720px] text-[0.95rem] leading-[1.8] tracking-[-0.006em] text-[#aab5b2]">
                {description}
              </p>
            </div>

            {action ? <div className="flex shrink-0">{action}</div> : null}
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container" style={dashboardStyles.pageGrid}>
          {children}
        </div>
      </div>
    </div>
  );
}