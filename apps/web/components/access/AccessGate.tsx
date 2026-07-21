"use client";

/**
 * Phase 2.1 — Reusable access-gate UI.
 *
 * Replaces raw 403 / 409 toasts with a structured panel that explains
 * WHY a feature is unavailable AND what the user can do next.
 *
 * Use this when:
 *   * a feature is plan-locked (FREE user clicks "Generate report")
 *   * a feature is role-locked (MEMBER clicks "Remove member")
 *   * a feature requires admin help (user lacks a capability their
 *     admin can grant)
 *   * a feature requires workspace scope (action only works in a
 *     workspace, current scope is personal)
 *
 * Pair with `<AccessGateInline>` for in-flow lock indicators (e.g.
 * inside a button row) and `<AccessGate>` for full-panel takeovers.
 *
 * No PII leak: the gate never reveals "your role is X" if the user
 * doesn't already know — it only states the requirement.
 */

import { type ReactNode } from "react";

import { ProovraDenialState } from "../feedback/ProovraDenialState";
import type {
  SystemStateAction,
  SystemStateKind,
} from "../feedback/ProovraSystemState";

export type AccessGateKind =
  | "PLAN_UPGRADE"
  | "ASK_ADMIN"
  | "REQUEST_ACCESS"
  | "CONTACT_OWNER"
  | "WORKSPACE_REQUIRED"
  | "FEATURE_UNAVAILABLE"
  | "PERMISSION_REQUIRED";

export type AccessGateAction = {
  label: string;
  href?: string;
  onClick?: () => void;
  variant?: "primary" | "secondary";
};

export type AccessGateProps = {
  kind: AccessGateKind;
  /**
   * Short headline — one sentence, operator-readable, no jargon.
   * Defaults are provided per kind.
   */
  headline?: string;
  /**
   * One-paragraph explanation. State the WHY only — never reveal
   * sensitive auth state.
   */
  reason?: string;
  /**
   * Optional list of next-step actions. Defaults are computed per kind.
   * Buttons render in order; first is "primary" variant.
   */
  actions?: AccessGateAction[];
  /**
   * Optional contextual badge (e.g. "Reports", "Team management") so
   * the same gate panel renders distinctly per surface.
   */
  surface?: string;
  /**
   * Inline / full variants. Inline renders without the outer card
   * frame — use it inside an existing surface (e.g. an evidence
   * detail tab) to keep page hierarchy intact.
   */
  variant?: "card" | "inline";
  /**
   * Optional children rendered below the headline / reason. Use for
   * surface-specific guidance (e.g. "Available in TEAM plan + above").
   */
  children?: ReactNode;
  /**
   * Optional test id override. Defaults to `access-gate-{kind-lower}`.
   */
  testid?: string;
};

function defaultsFor(kind: AccessGateKind): {
  headline: string;
  reason: string;
  actions: AccessGateAction[];
} {
  switch (kind) {
    case "PLAN_UPGRADE":
      return {
        headline: "Available on a higher plan",
        reason:
          "This action is not included in your current workspace plan. Upgrading unlocks it for everyone in the workspace.",
        // (2026-07-21) Dropped "Compare features → /pricing" — /pricing is
        // a PUBLIC marketing page; the in-app plan surface is /billing.
        actions: [
          { label: "Review plans", href: "/billing", variant: "primary" },
        ],
      };
    case "ASK_ADMIN":
      return {
        headline: "An admin can enable this",
        reason:
          "Your workspace admin can grant access. Reach out to the person who manages this workspace, or open settings to see who they are.",
        actions: [
          { label: "Open settings", href: "/settings", variant: "primary" },
          { label: "View workspace admins", href: "/workspaces", variant: "secondary" },
        ],
      };
    case "REQUEST_ACCESS":
      return {
        headline: "Request access from your admin",
        reason:
          "Your role doesn't include the permissions this surface needs. An admin can grant access.",
        // (2026-07-21) Dropped "Browse tools → /tools" — /tools is
        // INTERNAL/notFound for non-admins, so it must not be offered as
        // recovery to a user who just hit a permission wall.
        actions: [
          { label: "Open settings", href: "/settings", variant: "primary" },
        ],
      };
    case "CONTACT_OWNER":
      return {
        headline: "Workspace owner action required",
        reason:
          "Only the workspace owner can complete this step. Ask them to take the action, or open the team page to confirm who owns this workspace.",
        actions: [
          { label: "Open team page", href: "/collaboration-teams", variant: "primary" },
        ],
      };
    case "WORKSPACE_REQUIRED":
      return {
        headline: "Switch or create a workspace",
        reason:
          "This feature is only available in workspaces. Create one, or switch into a workspace you already belong to.",
        actions: [
          { label: "Open workspaces", href: "/workspaces", variant: "primary" },
          { label: "Review plans", href: "/billing", variant: "secondary" },
        ],
      };
    case "FEATURE_UNAVAILABLE":
      return {
        headline: "This feature is temporarily unavailable",
        reason:
          "Operators have not yet enabled this for your workspace, or a dependent service is offline. Please retry in a few minutes.",
        actions: [],
      };
    case "PERMISSION_REQUIRED":
      return {
        headline: "Permission required",
        reason:
          "Your role doesn't have permission for this action. An admin can grant it, or you can continue with what's available to you.",
        actions: [
          { label: "Open settings", href: "/settings", variant: "primary" },
        ],
      };
  }
}

/** AccessGate kind → canonical system-state kind. */
const KIND_TO_SYSTEM: Record<AccessGateKind, SystemStateKind> = {
  PLAN_UPGRADE: "forbidden",
  ASK_ADMIN: "forbidden",
  REQUEST_ACCESS: "forbidden",
  CONTACT_OWNER: "forbidden",
  PERMISSION_REQUIRED: "forbidden",
  WORKSPACE_REQUIRED: "workspace-unavailable",
  FEATURE_UNAVAILABLE: "unavailable",
};

/**
 * AccessGate — plan / role / capability / workspace denial affordance.
 *
 * (2026-07-21) Rebuilt onto the canonical `ProovraDenialState` — no more
 * legacy dark gradient card, no public-marketing escapes. The public
 * API (kinds, props, defaults, `classifyAccessError`) is unchanged; only
 * the presentation and two wrong recovery actions changed.
 */
export function AccessGate(props: AccessGateProps) {
  const defaults = defaultsFor(props.kind);
  const headline = props.headline ?? defaults.headline;
  const reason = props.reason ?? defaults.reason;
  const actions = props.actions ?? defaults.actions;
  const testid = props.testid ?? `access-gate-${props.kind.toLowerCase()}`;

  const systemActions: SystemStateAction[] = actions.map((a, i) => ({
    label: a.label,
    href: a.href,
    onClick: a.onClick,
    variant: a.variant ?? (i === 0 ? "primary" : "secondary"),
    testId: "access-gate-action",
  }));

  return (
    <div data-access-gate={testid} data-access-gate-kind={props.kind}>
      <ProovraDenialState
        kind={KIND_TO_SYSTEM[props.kind]}
        presentation="contained"
        statusLabel={props.surface ?? SYSTEM_LABEL[props.kind]}
        title={headline}
        message={reason}
        detail={props.children}
        actions={systemActions}
        testId={testid}
      />
    </div>
  );
}

/** Quiet status label per kind when no explicit surface is provided. */
const SYSTEM_LABEL: Record<AccessGateKind, string> = {
  PLAN_UPGRADE: "Plan",
  ASK_ADMIN: "Access",
  REQUEST_ACCESS: "Access",
  CONTACT_OWNER: "Access",
  PERMISSION_REQUIRED: "Access",
  WORKSPACE_REQUIRED: "Workspace",
  FEATURE_UNAVAILABLE: "Unavailable",
};

/**
 * Classify an apiFetch / fetch failure into the appropriate AccessGate
 * kind. Errors from `apiFetch` carry a numeric HTTP `status` and an
 * optional structured body with `code` / `upgradeUrl` / `feature`.
 *
 * Pass the raw error here; the helper picks the right gate kind. If
 * the error is not a recognised access denial, returns `null` so the
 * caller can fall back to a generic toast.
 */
export function classifyAccessError(error: unknown): AccessGateKind | null {
  if (!error || typeof error !== "object") return null;
  const e = error as { status?: number; code?: string; body?: { code?: string } };
  const status = typeof e.status === "number" ? e.status : null;
  const code =
    typeof e.code === "string"
      ? e.code
      : typeof e.body?.code === "string"
        ? e.body.code
        : null;

  if (code === "LEGAL_REACCEPT_REQUIRED") return "REQUEST_ACCESS";
  if (code === "PLAN_UPGRADE_REQUIRED") return "PLAN_UPGRADE";
  if (code === "WORKSPACE_REQUIRED") return "WORKSPACE_REQUIRED";
  if (code === "FEATURE_DISABLED") return "FEATURE_UNAVAILABLE";

  if (status === 402) return "PLAN_UPGRADE";
  if (status === 403) return "PERMISSION_REQUIRED";
  if (status === 409 && code?.includes("PLAN")) return "PLAN_UPGRADE";

  return null;
}
