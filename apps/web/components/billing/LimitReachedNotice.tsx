"use client";

/**
 * Pricing-hardening — structured plan-limit notice for in-product use.
 *
 * The backend's pricing guards return a structured error with `code`
 * and (for legacy compat) HTTP status. This component renders the
 * canonical user-facing message for the four new codes introduced by
 * the pricing-hardening change set, plus the existing FREE_LIMIT_REACHED
 * code, with a CTA that routes to the right surface (/billing for
 * self-serve upgrades; /contact-sales for Enterprise feature gates).
 *
 * Source of truth for the codes:
 *   - packages/shared/src/collaboration-team-billing-codes.ts
 *   - services/api/src/services/billing-enforcement.service.ts
 *   - services/api/src/middleware/require-enterprise-feature.ts
 */

import Link from "next/link";

export type LimitReachedCode =
  | "FREE_LIMIT_REACHED"
  | "EVIDENCE_RECORD_LIMIT_REACHED"
  | "EVIDENCE_RECORD_MONTHLY_LIMIT_REACHED"
  | "AI_MONTHLY_LIMIT_REACHED"
  | "ENTERPRISE_FEATURE_REQUIRED";

type CopyConfig = {
  title: string;
  body: string;
  ctaLabel: string;
  ctaHref: string;
};

const COPY: Record<LimitReachedCode, CopyConfig> = {
  FREE_LIMIT_REACHED: {
    title: "Free plan record limit reached",
    body:
      "The Free plan includes 3 evidence records. Upgrade to Pro for 100 included records, or contact Sales for higher monthly volume. Your existing records remain accessible.",
    ctaLabel: "View plans",
    ctaHref: "/billing",
  },
  EVIDENCE_RECORD_LIMIT_REACHED: {
    title: "Plan record limit reached",
    body:
      "You've reached the included evidence-record allowance for your current plan. Existing records remain accessible; upgrade to a higher plan or contact Sales for Enterprise volume.",
    ctaLabel: "View plans",
    ctaHref: "/billing",
  },
  EVIDENCE_RECORD_MONTHLY_LIMIT_REACHED: {
    title: "Monthly record limit reached",
    body:
      "You've reached the team's rolling 30-day evidence-record allowance. New creation resumes as older records age past 30 days, or contact Sales for Enterprise operational volume.",
    ctaLabel: "Contact Sales",
    ctaHref: "/contact-sales",
  },
  AI_MONTHLY_LIMIT_REACHED: {
    title: "Monthly AI advisory limit reached",
    body:
      "AI assistance for your plan resets monthly. Upgrade to a higher plan, or talk to Sales about Enterprise AI assistance.",
    ctaLabel: "View plans",
    ctaHref: "/billing",
  },
  ENTERPRISE_FEATURE_REQUIRED: {
    title: "Enterprise feature",
    body:
      "This capability is included with Enterprise plans (SAML SSO, SCIM, MFA enforcement, legal hold, custom retention, organization audit logs, Object Lock). Talk to Sales to enable it for your organization.",
    ctaLabel: "Contact Sales",
    ctaHref: "/contact-sales",
  },
};

export function LimitReachedNotice({
  code,
  detail,
}: {
  code: LimitReachedCode;
  detail?: string;
}): JSX.Element {
  const copy = COPY[code];
  return (
    <div
      data-testid={`limit-reached-${code.toLowerCase()}`}
      className="rounded-2xl border border-[#FECACA] bg-[#FEF2F2] p-4"
    >
      <div className="text-[0.78rem] font-semibold uppercase tracking-[0.14em] text-[#991B1B]">
        {copy.title}
      </div>
      <p className="mt-1.5 text-[0.86rem] leading-[1.55] text-[#7F1D1D]">
        {copy.body}
      </p>
      {detail ? (
        <p className="mt-1 text-[0.78rem] leading-[1.5] text-[#991B1B]/80">
          {detail}
        </p>
      ) : null}
      <Link
        href={copy.ctaHref}
        className="mt-3 inline-flex items-center gap-1 rounded-full bg-[#991B1B] px-3 py-1.5 text-[0.78rem] font-semibold text-white hover:bg-[#7F1D1D]"
      >
        {copy.ctaLabel}
      </Link>
    </div>
  );
}

export default LimitReachedNotice;
