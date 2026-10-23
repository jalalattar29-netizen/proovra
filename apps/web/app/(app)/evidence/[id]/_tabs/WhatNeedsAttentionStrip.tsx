"use client";

import type { EvidenceAttentionItem } from "@proovra/shared";

import type { EvidenceDetailCtx } from "./_lib";

/**
 * "What needs attention" — ONLY what needs attention (2026-10-23).
 *
 * This strip used to merge the server's reviewer alerts with signals the page
 * derived itself, and render every one as a pill under the same heading:
 * "Review ready" (a positive state), "Imported upload" (provenance), "File
 * timestamp note" (an advisory), "No case assigned" (optional metadata) and
 * "Review not started" (a real workflow step) looked like five equal problems.
 *
 * It now renders the server's classification (`workspace.attention`, from the
 * shared `classifyEvidenceAttention`) and derives nothing:
 *
 *   - the heading appears only when something is ACTION_REQUIRED or
 *     ACTION_RECOMMENDED, and only those items are listed here, each with
 *     its category in words and its one direct action;
 *   - otherwise one calm line says no action is required;
 *   - advisories belong to the rail's Risk Signals, provenance to the
 *     provenance context, optional metadata to the rail — never here.
 */
export function WhatNeedsAttentionStrip({
  ctx,
  onAssignCase,
  onAssignReviewer,
  onGoToArtifacts,
}: {
  ctx: EvidenceDetailCtx;
  onAssignCase: () => void;
  onAssignReviewer: () => void;
  onGoToArtifacts: () => void;
  /** Kept for callers; the strip no longer offers a generic review link. */
  onGoToReview?: () => void;
}) {
  const { workspace } = ctx;
  const attention = workspace.attention;
  if (!attention) return null;
  const items = attention.items.filter((i) => i.placement === "ATTENTION");

  if (attention.headline === "NO_ACTION" || items.length === 0) {
    return (
      <p
        className="evidence-detail-attention-calm"
        role="status"
        data-evidence-attention-strip="no-action"
      >
        No action required
      </p>
    );
  }

  const actionFor = (item: EvidenceAttentionItem) =>
    item.action === "ASSIGN_CASE"
      ? { label: "Assign case", run: onAssignCase }
      : item.action === "START_REVIEW"
        ? { label: "Start review", run: onAssignReviewer }
        : item.action === "OPEN_ARTIFACTS"
          ? { label: "Open artifacts", run: onGoToArtifacts }
          : null;

  return (
    <section
      className="evidence-detail-attention"
      data-evidence-attention-strip={attention.headline}
      aria-labelledby="evidence-attention-title"
    >
      <h2 className="evidence-detail-attention__title" id="evidence-attention-title">
        What needs attention
      </h2>
      <ul className="evidence-detail-attention__items">
        {items.map((item) => {
          const action = actionFor(item);
          return (
            <li
              key={item.code}
              className="evidence-detail-attention__item"
              data-evidence-attention-code={item.code}
              data-evidence-attention-category={item.category}
              data-tone={item.tone}
            >
              {/* The category is WORDS, not only a colour. */}
              <span className="evidence-detail-attention__category">
                {item.category === "ACTION_REQUIRED" ? "Required" : "Recommended"}
              </span>
              <span className="evidence-detail-attention__label" title={item.detail}>
                {item.label}
              </span>
              {action ? (
                <button
                  type="button"
                  className="evidence-detail-attention__action"
                  data-evidence-attention-action={item.action}
                  onClick={action.run}
                >
                  {action.label}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
