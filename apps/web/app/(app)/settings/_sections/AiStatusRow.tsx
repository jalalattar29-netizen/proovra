"use client";

/**
 * THE EFFECTIVE AI STATUS, ON EVERY AI SETTINGS VIEW.
 *
 * Settings → AI rendered the workspace POLICY ROW — the switches an
 * administrator had set — and nothing else. On a deployment with no AI provider
 * configured it therefore showed "AI assistance" enabled, with green toggles,
 * while every AI request in the product returned unavailable.
 *
 * The one place that DID know the truth was the live capability table, and it
 * rendered for organization administrators only. Personal users and
 * organization members — most of the people who ever open this page — had no
 * way to find out.
 *
 * This row shows the effective answer in every mode. It reasons about nothing:
 * `assistance.status` is resolved by the API from the same evaluator that gates
 * every provider call, so the page cannot reach a different conclusion from the
 * gate that enforces it.
 */

import { AppStatusText } from "../../../../components/app-primitives";
import {
  aiStatusCopy,
  managedByCopy,
  resolveManagedBy,
  type AiAssistanceStatus,
} from "../../../../lib/ai/assistanceStatus";

export function AiStatusRow({
  status,
  enabled,
  workspaceKind,
  canManage,
}: {
  status: AiAssistanceStatus;
  /** The workspace's own switch, independent of platform availability. */
  enabled: boolean;
  workspaceKind: "PERSONAL" | "ORGANIZATION" | null;
  canManage: boolean | null;
}) {
  const copy = aiStatusCopy(status);
  const managedBy = resolveManagedBy({ status, workspaceKind, canManage });

  return (
    <div
      className="set-card"
      data-cc-ai-status={status}
      /*
       * `min-inline-size: 0` because the organization view places this in a
       * CSS grid, and a grid item defaults to `min-width: auto` — it refuses to
       * shrink below its own max-content width. This card's longest sentence is
       * ~800px unbroken, so on a phone the single grid track sized itself to
       * 806px inside a 283px column and every line was clipped at the right
       * edge. The page did not scroll, which made it look like missing text
       * rather than an overflow.
       *
       * Set here rather than on the grid, so a layout the rest of Settings
       * shares is not changed to accommodate one card.
       */
      style={{ minInlineSize: 0 }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-primary, #0f172a)" }}>
          AI assistance
        </span>
        {/*
          The status is a WORD, not a colour. `AppStatusText` always renders its
          text, so the state survives greyscale, a colour-blind reader and a
          screen reader — colour only reinforces it.
        */}
        <AppStatusText tone={copy.tone} size="sm" data-cc-ai-status-label={copy.label}>
          {copy.label}
        </AppStatusText>
      </div>

      <p style={{ margin: "6px 0 0", fontSize: 12.5, lineHeight: 1.5, color: "var(--app-ink-secondary, #667085)" }}>
        {copy.detail}
      </p>

      {/*
        Who to take it up with. A member told only "disabled" learns nothing
        actionable; told who manages it, they know where to ask.

        Suppressed when the platform is down and the workspace switch is on:
        "PROOVRA platform availability" is already what the detail line says,
        and repeating it reads as though two separate things were wrong.
      */}
      {status === "TEMPORARILY_UNAVAILABLE" && enabled ? null : (
        <p
          style={{ margin: "4px 0 0", fontSize: 12, color: "var(--app-ink-secondary, #667085)" }}
          data-cc-ai-managed-by={managedBy}
        >
          {managedByCopy(managedBy)}
        </p>
      )}

      {/*
        The one case where the two facts genuinely differ and both matter: the
        workspace has AI switched on, but the platform cannot serve it. Saying
        only "unavailable" would make an administrator hunt for a setting they
        have already set correctly.
      */}
      {status === "TEMPORARILY_UNAVAILABLE" && enabled ? (
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--app-ink-secondary, #667085)" }}>
          This workspace has AI assistance enabled; the platform is not serving
          AI requests at the moment. No change is needed here.
        </p>
      ) : null}
    </div>
  );
}
