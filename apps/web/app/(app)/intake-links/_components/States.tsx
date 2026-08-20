"use client";

/**
 * Intake links — the canonical non-content states.
 *
 * One anatomy (`.app-empty`) for every one of them, differentiated by tone and
 * by which action it offers:
 *
 *   loading      skeleton rows inside the real table surface, never "0 links"
 *   refreshing   the table stays, a polite busy line appears above it
 *   empty        no link has ever existed → create, plus quick-start purposes
 *   noMatch      filters excluded everything → clear filters
 *   error        the service failed → retry
 *   restricted   the caller lacks the capability → NO retry, request access
 *   unavailable  the deployment has not enabled intake → who to contact
 *
 * The distinction that matters: a restricted state must not offer a retry
 * button. Retrying a refusal the server will repeat teaches the operator that
 * the product is broken rather than that they need access.
 */

import * as React from "react";

import type { SafeUserError } from "../../../../lib/feedback/toSafeUserError";

import {
  REQUEST_PURPOSES,
  type RequestPurpose,
} from "../../../../lib/intake-links/catalog";
import { IconLink, IconPlus, RequestPurposeGlyph } from "./icons";

/** Six of the nine purposes; the wizard offers the full catalog. */
const QUICK_START: ReadonlyArray<RequestPurpose> = REQUEST_PURPOSES.slice(0, 6);

export function LoadingState({ rows = 5 }: { rows?: number }) {
  return (
    <div
      className="app-table-surface"
      data-intake-links-loading
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading intake links"
    >
      {Array.from({ length: rows }).map((_, i) => (
        <div className="ilk-skeleton-row" key={i}>
          <div className="app-skeleton ilk-skeleton-bar" data-span="wide" />
          <div className="app-skeleton ilk-skeleton-bar" data-span="mid" />
          <div className="app-skeleton ilk-skeleton-bar" data-span="mid" />
          <div className="app-skeleton ilk-skeleton-bar" data-span="pill" />
        </div>
      ))}
      <span className="app-visually-hidden">Loading intake links…</span>
    </div>
  );
}

export function RefreshingNotice() {
  return (
    <p className="app-alert" role="status" data-intake-links-refreshing>
      Refreshing intake links…
    </p>
  );
}

export function EmptyState({
  onCreate,
  onPickPurpose,
  canCreate,
}: {
  onCreate: () => void;
  onPickPurpose: (slug: string) => void;
  canCreate: boolean;
}) {
  return (
    <div className="app-section-stack" data-intake-links-empty="true">
      <div className="app-empty">
        <span className="app-empty__icon">
          <IconLink size={24} />
        </span>
        <strong>No intake links yet</strong>
        <p>
          Create a secure upload link to request evidence from someone outside
          your workspace — a client, a witness, a contractor. They upload
          without an account and never see your workspace.
        </p>
        {canCreate ? (
          <div className="app-empty__actions">
            <button
              type="button"
              className="app-primary-action"
              onClick={onCreate}
              data-intake-links-empty-create="true"
            >
              <IconPlus size={16} />
              <span>New intake link</span>
            </button>
          </div>
        ) : null}
      </div>

      {canCreate ? (
        <div className="app-panel" data-intake-links-quick-start>
          <div className="app-panel__head">
            <h2 className="app-panel__title">Start from a common request</h2>
          </div>
          <div className="app-panel__body">
            <ul className="ilk-choices" data-columns="2">
              {QUICK_START.map((p) => (
                <li key={p.slug}>
                  <button
                    type="button"
                    className="ilk-choice ilk-choice--button"
                    onClick={() => onPickPurpose(p.slug)}
                    data-intake-links-quick-start-tile={p.slug}
                  >
                    <span className="ilk-choice__icon">
                      <RequestPurposeGlyph icon={p.icon} />
                    </span>
                    <span className="ilk-choice__body">
                      <span className="ilk-choice__title">{p.label}</span>
                      <span className="ilk-choice__desc">{p.description}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function NoMatchState({ onClear }: { onClear: () => void }) {
  return (
    <div className="app-empty" data-intake-links-no-match="true">
      <span className="app-empty__icon">
        <IconLink size={24} />
      </span>
      <strong>No intake links match these filters</strong>
      <p>
        Every link is still here — the current search and filters just exclude
        all of them.
      </p>
      <div className="app-empty__actions">
        <button
          type="button"
          className="app-secondary-action"
          onClick={onClear}
          data-intake-links-empty-clear
        >
          Clear filters
        </button>
      </div>
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      className="app-empty"
      data-tone="danger"
      data-intake-links-error
      role="alert"
    >
      <strong>Couldn&apos;t load intake links</strong>
      <p>{message}</p>
      <div className="app-empty__actions">
        <button type="button" className="app-secondary-action" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}

/**
 * The caller is authenticated but not authorised, or the capability envelope
 * never arrived. Both fail CLOSED to this panel and neither offers a retry.
 */
export function RestrictedState({
  reason,
}: {
  reason: "forbidden" | "no_envelope";
}) {
  return (
    <div
      className="app-empty"
      data-tone="restricted"
      data-intake-links-restricted={reason}
      role="status"
    >
      <strong>You don&apos;t have access to intake links here</strong>
      <p>
        {reason === "forbidden"
          ? "Managing external intake links needs an admin or owner role in this workspace. Ask a workspace owner to grant access."
          : "Your access for this workspace hasn't been confirmed. Reload the page, or ask a workspace owner to check your role."}
      </p>
    </div>
  );
}

/** The deployment has not enabled external intake at all. */
export function FeatureUnavailableState() {
  return (
    <div
      className="app-empty"
      data-tone="restricted"
      data-intake-links-feature-disabled
      data-testid="intake-links-feature-disabled"
      role="status"
    >
      {/* Copy approved in the self-serve completion phase and deliberately
          unchanged by this redesign: it names WHO to contact, and it names no
          environment variable. */}
      <strong>Not enabled yet</strong>
      <p>
        External intake links aren't turned on for your account yet.
        Contact your IT administrator or your PROOVRA support contact to enable
        this feature for your workspace.
      </p>
    </div>
  );
}

/**
 * A mutation that partly succeeded, or failed after the list already loaded.
 *
 * Renders the ACTION that failed alongside the canonical safe sentence. The
 * sentence always comes from `toSafeUserError` — raw server text never reaches
 * this element — but that helper answers "what should I do", not "what did I
 * just fail to do", so the action name is supplied by the caller.
 */
export function InlineMutationError({
  error,
  onDismiss,
}: {
  error: { action: string; safe: SafeUserError };
  onDismiss: () => void;
}) {
  return (
    <div
      className="app-alert app-alert--danger"
      role="alert"
      data-intake-links-mutation-error
    >
      <div className="app-panel__head-row">
        <span>
          <strong data-intake-links-mutation-error-title>
            {error.action}
          </strong>{" "}
          {error.safe.message}
        </span>
        <button
          type="button"
          className="app-ghost-action"
          onClick={onDismiss}
          aria-label="Dismiss error"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
