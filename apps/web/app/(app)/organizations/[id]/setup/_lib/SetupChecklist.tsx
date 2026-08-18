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

import { Card } from "../../../../../../components/ui/Card";
import { Button } from "../../../../../../components/ui/Button";
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
    <Card
      variant="summary"
      padding={compact ? "compact" : "comfortable"}
      data-section="setup-checklist"
      data-checklist-done={done}
      data-checklist-total={total}
      header={
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 650, color: "var(--ink-primary, #0f172a)" }}>
              Setup checklist
            </h2>
            <div style={{ fontSize: 12, color: "var(--ink-muted, #94a3b8)", marginTop: 2 }}>
              {done} of {total} complete
            </div>
          </div>
          {setupHref ? (
            <Link
              href={setupHref}
              data-action="checklist-open-setup"
              style={{ textDecoration: "none", flexShrink: 0 }}
            >
              <Button variant="primary" size="sm">
                {done === total ? "Review setup →" : "Continue setup →"}
              </Button>
            </Link>
          ) : null}
        </header>
      }
    >
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
            <span
              style={{
                flex: "1 1 auto",
                color: c.done === false ? "var(--ink-primary, #0f172a)" : "var(--ink-secondary, #475569)",
              }}
            >
              {c.label}
            </span>
            {setupHref && c.done !== true ? (
              <Link
                href={`${setupHref}#${c.stepId}`}
                data-action="checklist-goto-step"
                data-checklist-goto={c.stepId}
                style={{
                  fontSize: 12,
                  whiteSpace: "nowrap",
                  color: "var(--enterprise-accent, #7C3AED)",
                  textDecoration: "none",
                }}
              >
                {c.done === null ? "" : "Do this →"}
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function StatusDot({ done }: { done: boolean | null }): ReactNode {
  const bg =
    done === null
      ? "var(--surface-muted, #f1f4f9)"
      : done
        ? "var(--status-verified-solid, #10b981)"
        : "transparent";
  const border =
    done === true
      ? "var(--status-verified-solid, #10b981)"
      : "var(--border-strong, rgba(15,23,42,0.14))";
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
