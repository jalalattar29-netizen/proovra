"use client";

/**
 * Reusable enterprise setup checklist.
 *
 * Renders per-criterion completion derived from the SAME reads the wizard
 * performs (see `deriveChecklist`). It never fetches on its own — the
 * caller passes already-derived criteria so the org detail page and the
 * wizard stay in lock-step. Each row optionally deep-links to the wizard
 * step that satisfies it.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import {
  checklistProgress,
  type ChecklistCriterion,
} from "./wizardModel";

export function SetupChecklist({
  criteria,
  setupHref,
  compact = false,
}: {
  criteria: ReadonlyArray<ChecklistCriterion>;
  /** Base href of the wizard, e.g. `/organizations/:id/setup`. Rows link
   * to `${setupHref}#${stepId}` so a click resumes at the right step. */
  setupHref?: string;
  compact?: boolean;
}) {
  const { done, total } = checklistProgress(criteria);

  return (
    <section
      data-section="setup-checklist"
      data-checklist-done={done}
      data-checklist-total={total}
      style={{
        padding: compact ? "0.85rem 1rem" : "1rem 1.1rem",
        border: "1px solid rgba(127,127,127,0.3)",
        borderRadius: 8,
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          marginBottom: "0.6rem",
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>Setup checklist</h2>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>
            {done} of {total} complete
          </div>
        </div>
        {setupHref ? (
          <Link
            href={setupHref}
            data-action="checklist-open-setup"
            style={{
              padding: "0.35rem 0.7rem",
              border: "1px solid currentColor",
              borderRadius: 4,
              fontSize: 13,
              fontWeight: 600,
              background: "rgba(99,102,241,0.12)",
              color: "inherit",
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            {done === total ? "Review setup →" : "Continue setup →"}
          </Link>
        ) : null}
      </header>

      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
        {criteria.map((c) => (
          <li
            key={c.id}
            data-checklist-criterion={c.id}
            data-checklist-state={
              c.done === null ? "loading" : c.done ? "done" : "todo"
            }
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              fontSize: 13.5,
            }}
          >
            <StatusDot done={c.done} />
            <span style={{ flex: "1 1 auto", opacity: c.done === false ? 0.9 : 1 }}>
              {c.label}
            </span>
            {setupHref && c.done !== true ? (
              <Link
                href={`${setupHref}#${c.stepId}`}
                data-action="checklist-goto-step"
                data-checklist-goto={c.stepId}
                style={{ fontSize: 12, whiteSpace: "nowrap" }}
              >
                {c.done === null ? "" : "Do this →"}
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function StatusDot({ done }: { done: boolean | null }): ReactNode {
  const bg =
    done === null
      ? "rgba(148,163,184,0.4)"
      : done
        ? "rgba(34,197,94,0.9)"
        : "transparent";
  const border =
    done === true ? "rgba(34,197,94,0.9)" : "rgba(127,127,127,0.55)";
  return (
    <span
      aria-hidden
      style={{
        width: 16,
        height: 16,
        borderRadius: 999,
        border: `1.5px solid ${border}`,
        background: bg,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#fff",
        fontSize: 11,
        flex: "0 0 auto",
      }}
    >
      {done === true ? "✓" : ""}
    </span>
  );
}
