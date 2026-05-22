"use client";

/**
 * Phase EMERGENCY-RECOVERY — Workspace recovery panel.
 *
 * Rendered when `envelope.recoveryActions` is non-empty (i.e. the
 * server couldn't assemble a healthy workspace). NEVER renders a
 * blank shell — every recovery state surfaces:
 *
 *   - A title explaining what's wrong.
 *   - A bounded explanation.
 *   - Structured CTAs (server-provided) that lead the user to a
 *     working state (create personal workspace / create team /
 *     open settings / retry context reload).
 *   - The `requestId` so support can correlate logs.
 *
 * The panel is intentionally minimal — no third-party UI, no
 * decoration, no fake metrics.
 */

import React from "react";
import Link from "next/link";

import { usePlatformContext } from "./PlatformContextProvider";

export function WorkspaceRecoveryPanel() {
  const { envelope, state, refresh } = usePlatformContext();
  const actions = envelope?.recoveryActions ?? [];
  const requestId = envelope?.diagnostics?.requestId ?? null;
  const message =
    state.name === "FAILED"
      ? state.message
      : "Workspace setup is required to continue. Pick an option below or retry the request.";

  return (
    <main
      className="cc-page"
      data-workspace-recovery-panel
      style={{ maxWidth: 720, margin: "0 auto" }}
    >
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Workspace setup required</div>
          <h1 className="cc-title">Let's get you back into the product</h1>
          <p className="cc-subtitle">{message}</p>
        </div>
      </header>

      <section className="cc-section" data-workspace-recovery-actions>
        <header className="cc-section-header">
          <h2 className="cc-section-title">Choose a path</h2>
        </header>
        <div
          style={{
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          {actions.map((action) => {
            if (action.id === "retry") {
              return (
                <button
                  key={action.id}
                  type="button"
                  className="cases-filter-chip is-active"
                  data-workspace-recovery-action={action.id}
                  onClick={() => void refresh()}
                >
                  {action.label}
                </button>
              );
            }
            if (!action.href) return null;
            return (
              <Link
                key={action.id}
                href={action.href}
                className="cases-filter-chip"
                data-workspace-recovery-action={action.id}
              >
                {action.label}
              </Link>
            );
          })}
        </div>
      </section>

      {requestId ? (
        <section className="cc-section" data-workspace-recovery-diagnostics>
          <small style={{ opacity: 0.7 }}>
            Request ID: <code>{requestId}</code>
          </small>
        </section>
      ) : null}
    </main>
  );
}
