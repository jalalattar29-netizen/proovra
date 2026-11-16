"use client";

/**
 * An "Upgrade" link that only points at `/billing` when the viewer pays for
 * the ACTIVE workspace (Free-user audit 0ea0: B3A-F-004, B2A-F-23).
 *
 * `/billing` selects among the viewer's OWN billing accounts. A member of a
 * workspace somebody else pays for would land on their personal plan and be
 * offered a purchase that does not lift the workspace's limit. There, this
 * renders who manages billing instead of a link. While the answer is unknown
 * (an organization's billing-account list still loading) it renders nothing.
 */
import Link from "next/link";
import type { ReactNode } from "react";

import { useActiveSpaceBillingAuthority } from "../../lib/billing/active-space-billing";

export function WorkspaceUpgradeLink({
  className,
  testId,
  ariaLabel,
  title,
  children,
}: {
  className?: string;
  testId?: string;
  ariaLabel?: string;
  title?: string;
  children: ReactNode;
}) {
  const authority = useActiveSpaceBillingAuthority();
  if (authority.canManage === null) return null;
  if (!authority.canManage) {
    return (
      <span
        role="note"
        data-testid={testId ? `${testId}-ask-owner` : undefined}
        data-billing-managed-elsewhere={authority.payer.kind}
        style={{ color: "#475467", fontSize: 13 }}
      >
        {authority.askCopy}
      </span>
    );
  }
  return (
    <Link href="/billing" className={className} data-testid={testId} aria-label={ariaLabel} title={title}>
      {children}
    </Link>
  );
}
