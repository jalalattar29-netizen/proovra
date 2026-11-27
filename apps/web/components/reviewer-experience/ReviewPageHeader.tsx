"use client";

/**
 * ReviewPageHeader — THE ONE HEADER FOR EVERY TEAM REVIEW PAGE.
 *
 * TEAM-UI-SPEC (structure round): the review pages read as the same product
 * as Evidence Library / Evidence Detail. Each one now renders the canonical
 * `PageHeader` with the canonical title treatment — the `.app-title-row` /
 * `.app-title-icon` pair /evidence, /cases and /notifications use — carrying
 * the SAME lucide glyph the sidebar shows for Review (`workspace.review` in
 * lib/navigation/routeIcons.ts), a plain subtitle and NO eyebrow/kicker.
 *
 * `back` renders a back link ABOVE the title, where Evidence Detail places
 * its "← Evidence Library / Evidence Record" breadcrumb: an `app-ghost-action`
 * with an ArrowLeft glyph inside a labelled breadcrumb landmark.
 *
 * `backToHub` is the resolver-gated variant of `back` for a page that also
 * opens OUTSIDE the review hub's plan (External review is on Pro): the
 * "← Review" link renders only where /review opens for this actor, never a
 * link into a refusal.
 *
 * Header actions ride PageHeader's own wrapping actions row, so they wrap on
 * narrow screens instead of overflowing (AUD-0060).
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";

import { AssistantInlineEntry } from "../ai/AssistantInlineEntry";
import { PageHeader } from "../ui/PageShell";
import { useReviewDestination } from "./reviewDestination";
import { routeIconFor } from "../../lib/navigation/routeIcons";
import "./review-surfaces.css";

export type ReviewPageHeaderBack = { href: string; label: string };

export interface ReviewPageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Badges / identity strip under the subtitle (inspector). */
  contextStrip?: ReactNode;
  primaryAction?: ReactNode;
  secondaryActions?: ReactNode;
  back?: ReviewPageHeaderBack | null;
  /** "← Review" to /review, only where the review hub opens (resolver). */
  backToHub?: boolean;
  className?: string;
  /**
   * F-23 (review remediation 2026-11-27) — the assistant's inline entry in
   * the header actions, which replaces the floating launcher on Review pages
   * (it covered form fields and actions). Default on; `false` opts out.
   */
  assistantEntry?: boolean;
}

/** The hub's own back target for the advanced tool pages. */
export const REVIEW_HUB_BACK: ReviewPageHeaderBack = { href: "/review", label: "Review" };

function BackLink({ back }: { back: ReviewPageHeaderBack }) {
  return (
    <nav className="review-page-header__back" aria-label="Breadcrumb">
      <Link href={back.href} className="app-ghost-action" data-review-back-link>
        <ArrowLeft size={14} strokeWidth={2.2} aria-hidden="true" />
        {back.label}
      </Link>
    </nav>
  );
}

function HubBackLink() {
  const destination = useReviewDestination("review.queue", { label: REVIEW_HUB_BACK.label });
  if (!destination || destination.kind !== "link") return null;
  return <BackLink back={{ href: destination.href, label: destination.label }} />;
}

const ReviewIcon = routeIconFor("workspace.review");

export function ReviewPageHeader({
  title,
  subtitle,
  contextStrip,
  primaryAction,
  secondaryActions,
  back,
  backToHub,
  className,
  assistantEntry = true,
}: ReviewPageHeaderProps) {
  return (
    <div
      className={["review-page-header", className].filter(Boolean).join(" ")}
      data-review-page-header
    >
      {back ? <BackLink back={back} /> : backToHub ? <HubBackLink /> : null}
      <PageHeader
        title={
          <span className="app-title-row">
            <span aria-hidden="true" className="app-title-icon">
              <ReviewIcon strokeWidth={1.75} data-review-title-icon />
            </span>
            <span data-review-page-title>{title}</span>
          </span>
        }
        subtitle={subtitle}
        contextStrip={contextStrip}
        primaryAction={primaryAction}
        secondaryActions={
          assistantEntry ? (
            <>
              {secondaryActions}
              <AssistantInlineEntry />
            </>
          ) : (
            secondaryActions
          )
        }
      />
    </div>
  );
}

export default ReviewPageHeader;
