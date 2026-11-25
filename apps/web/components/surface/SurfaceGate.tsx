"use client";

/**
 * Phase IA-surface-tier — client-side page-level surface gate.
 *
 * Pages that belong to hidden tiers (ENTERPRISE / INTERNAL / plan-gated)
 * wrap their body in `<SurfaceGate>`. At render time the gate:
 *
 *   1. Reads `usePlatformContext()` to learn plan / role / admin flags.
 *   2. Runs `getDirectAccessDecision(ctx, pathname)`.
 *   3. Applies the bounded outcome:
 *        - allow      → renders children.
 *        - redirect   → next/navigation.useRouter().replace(target).
 *        - notFound   → next/navigation.notFound() (renders not-found.tsx).
 *        - forbidden  → renders a bounded 403 affordance.
 *
 * Why client-side: the middleware only has the path. The full plan /
 * role / `isPlatformAdmin` is established at the PlatformContext layer
 * AFTER the JWT round-trips. We need both layers — middleware catches
 * unauthenticated direct hits to INTERNAL surfaces; this component
 * catches authenticated mis-tier hits.
 *
 * NOTE: never call this from a server component — `usePlatformContext`
 * is a client hook.
 */

import { notFound, usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import {
  ANONYMOUS_SURFACE_CONTEXT,
  getDirectAccessDecision,
  ruleEntitlement,
} from "../../lib/surface/access";
import { useSurfaceUserContext } from "../../lib/surface/useSurfaceUserContext";
import { usePlatformContext } from "../../lib/platform-context/PlatformContextProvider";
import { isContextResolving } from "../../lib/platform-context/types";
import { ProovraSystemState } from "../feedback/ProovraSystemState";
import { useActiveSpaceBillingAuthority } from "../../lib/billing/active-space-billing";
import { findSurfaceTierRule } from "../../lib/surface/tiers";
import { PLAN_RANK, type PlanType } from "@proovra/shared-billing";

/**
 * TEAM MEMBERSHIP (2026-11-23) — "switch, don't upgrade".
 *
 * An invitee working in somebody else's workspace is refused a plan-gated page
 * because THAT workspace's plan lacks it, while their OWN plan — which applies
 * to their own Personal Space — includes it. Telling them to "ask the owner to
 * change the plan" (or to upgrade) is wrong: the fix is to switch.
 *
 * This decides only which REMEDY to SUGGEST on a refusal the gate already
 * made; it grants nothing and never changes which plans pass. After the
 * switch the gate re-decides on the server-projected entitlements of the
 * Personal Space. The lowest plan rank that carries each server entitlement
 * mirrors the commercial catalog (packages/shared-billing plan-catalog) and
 * the tier rules' own `forbiddenMessage` wording. A key not listed here never
 * offers a switch (the existing copy stands).
 */
const ENTITLEMENT_MIN_RANK: Partial<Record<string, number>> = {
  externalReviewIncluded: PLAN_RANK.PRO,
  professionalSurfacesIncluded: PLAN_RANK.PRO,
  reviewQueuesIncluded: PLAN_RANK.TEAM,
  reviewerOperationsIncluded: PLAN_RANK.TEAM,
};

function rankOf(plan: string | null | undefined): number | null {
  if (!plan) return null;
  const rank = (PLAN_RANK as Record<string, number | undefined>)[plan as PlanType];
  return typeof rank === "number" ? rank : null;
}

export type SurfaceGateProps = {
  children: ReactNode;
  /**
   * Optional explicit override — when set, the gate uses this pathname
   * instead of `usePathname()`. Useful when wrapping a route group
   * whose canonical path differs from the rendered path (e.g. shared
   * `[id]` segment).
   */
  pathnameOverride?: string;
  /**
   * Optional render override for the forbidden case. Defaults to a
   * minimal bounded message.
   */
  forbiddenFallback?: ReactNode;
};

export function SurfaceGate({
  children,
  pathnameOverride,
  forbiddenFallback,
}: SurfaceGateProps) {
  const pathname = usePathname();
  const router = useRouter();
  const userCtx = useSurfaceUserContext();
  const { state, envelope, switchWorkspace } = usePlatformContext();
  const billingAuthority = useActiveSpaceBillingAuthority();
  const effectivePath = pathnameOverride ?? pathname ?? "/";

  /**
   * PHASE 13 — DO NOT DECIDE BEFORE THE ENVELOPE EXISTS.
   *
   * `useSurfaceUserContext` fails CLOSED while `/v1/platform/context` is in
   * flight: no envelope means `ANONYMOUS_SURFACE_CONTEXT`, which carries
   * `isEnterpriseWorkspace: false`. That is the correct answer for a
   * VISIBILITY consumer — a sidebar link that is briefly hidden becomes
   * visible on the next render — and it is fatal here, because this gate's
   * denial is `notFound()`. Next.js has no path back from a thrown
   * not-found: the boundary renders `(app)/not-found.tsx` and the later
   * READY envelope never gets to change the answer.
   *
   * So EVERY Enterprise-tier page 404'd on first paint for genuinely
   * Enterprise workspaces — governance platform, security center, redaction,
   * intelligence, destruction governance — with the sidebar still linking to
   * them, and the only variable was whether the fetch happened to have
   * resolved. This is the defect behind the largest family of Point-7 browser
   * failures, and it is a real user-facing one, not a harness artifact.
   *
   * The provider's own contract states it: "Bounded state machine.
   * Header/sidebar/pages MUST gate on `name`." This gate never did. Holding
   * the render until the state machine has a READY envelope is not a
   * weakening — an unresolved context still denies, it simply does not do so
   * IRREVERSIBLY before the answer is known.
   *
   * THE STATE MACHINE HAS FIVE STATES AND ONLY ONE OF THEM CAN DECIDE THIS.
   * ---------------------------------------------------------------------------
   * Gating on `LOADING_CONTEXT` alone was not enough, and the three states it
   * missed are each a distinct defect:
   *
   *   IDLE — the state the provider is CONSTRUCTED in (`useState({name:
   *     "IDLE"})`). The fetch is started from a `useEffect`, so the FIRST
   *     paint of every page is IDLE, not LOADING_CONTEXT. A gate that only
   *     held on the latter therefore still 404'd on first paint, which is
   *     exactly what the browser layer observed.
   *
   *   SWITCHING — `usePlatformContext().envelope` deliberately returns the
   *     PREVIOUS envelope here so the shell does not flicker. For a
   *     VISIBILITY consumer that is right; for this gate it would authorize
   *     the NEXT workspace's page against the PREVIOUS workspace's
   *     entitlements. Holding is what makes the switch honest — but ONLY when
   *     the target really is a different workspace. See below.
   *
   *   FAILED — `envelope` returns the retained previous envelope here too. So
   *     a context fetch that FAILED would have kept an Enterprise page open on
   *     a stale answer. That is the one direction a gate must never fail in,
   *     so FAILED is decided against `ANONYMOUS_SURFACE_CONTEXT` rather than
   *     against whatever the provider still happens to be holding.
   *
   * READY is therefore the only state whose envelope may decide, and the
   * `userCtx` projection is used only then.
   */
  /**
   * PHASE 13 (NEW-070) — A SAME-WORKSPACE REFRESH IS NOT A SWITCH.
   *
   * `SWITCHING` covers two different events, and the state itself already tells
   * them apart:
   *
   *   `switchWorkspace(id)` → `targetWorkspaceId: id`, a DIFFERENT workspace.
   *   `refresh()`           → `targetWorkspaceId: prev.envelope.workspace.id`,
   *                           i.e. the workspace already being rendered.
   *
   * Holding on both was too blunt. `refresh()` is what components call after a
   * mutation to re-read the envelope — `CreateWorkspaceCard` calls it on success
   * — so a blanket hold unmounted the whole gated subtree for a same-tenant
   * revalidation, destroying the `role="status"` region the mutation had just
   * written to. Creating a workspace announced nothing, for the same reason
   * NEW-064 made suspending one announce nothing.
   *
   * Narrowing to a genuine workspace CHANGE preserves the security property
   * exactly — the previous envelope may never authorize a DIFFERENT workspace's
   * page — while a refresh of the workspace already on screen keeps rendering
   * against an envelope that describes that same workspace. `targetWorkspaceId`
   * is nullable (switch-to-personal), and `null` correctly compares unequal, so
   * that case still holds.
   */
  const switchingToAnotherWorkspace =
    state.name === "SWITCHING" &&
    state.targetWorkspaceId !== state.previous.workspace.id;

  const resolving = isContextResolving(state);

  // The decision is only meaningful once a READY envelope exists. Computing it
  // unconditionally keeps the hook order below fixed — an early return placed
  // above `useEffect` would change the number of hooks between renders.
  /**
   * The envelope may decide when it is READY, or when it is the retained
   * envelope of the SAME workspace being revalidated (above). `FAILED` retains a
   * previous envelope too and must NOT be trusted with it, so it decides against
   * `ANONYMOUS_SURFACE_CONTEXT` and therefore fails closed.
   */
  const envelopeMayDecide =
    state.name === "READY" ||
    (state.name === "SWITCHING" && !switchingToAnotherWorkspace);

  const decision = resolving
    ? ({ kind: "resolving" } as const)
    : getDirectAccessDecision(
        envelopeMayDecide ? userCtx : ANONYMOUS_SURFACE_CONTEXT,
        effectivePath,
      );

  useEffect(() => {
    if (decision.kind === "redirect") {
      router.replace(decision.to);
    }
  }, [decision, router]);

  if (decision.kind === "resolving") {
    return (
      <div
        data-surface-gate-state="resolving"
        role="status"
        aria-live="polite"
        aria-busy="true"
        style={{ minHeight: "60vh" }}
      >
        <span
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            overflow: "hidden",
            clip: "rect(0 0 0 0)",
            whiteSpace: "nowrap",
          }}
        >
          Checking whether this area is available in your workspace…
        </span>
      </div>
    );
  }

  if (decision.kind === "allow") {
    return <>{children}</>;
  }
  if (decision.kind === "notFound") {
    notFound();
  }
  if (decision.kind === "forbidden") {
    // TEAM MEMBERSHIP (2026-11-23) — switching is the fix: say so, and show
    // no plan / upgrade / ask-the-owner copy. Only on a READY envelope, only
    // for a plan-based rule, only when the caller HAS an allowed Personal
    // Space that is not the active one, and only when their own account plan
    // carries the rule's entitlement.
    const rule = envelopeMayDecide ? findSurfaceTierRule(effectivePath) : null;
    // T-125 — the rule's entitlement is the registry route's requiredPlanFeature.
    const entitlementKey = ruleEntitlement(rule)?.key;
    const minRank = entitlementKey ? ENTITLEMENT_MIN_RANK[entitlementKey] : undefined;
    const accountRank = rankOf(envelope?.account?.accountPlan);
    const personalWorkspaceId = envelope?.contextOptions?.personalSpace?.workspaceId ?? null;
    const active = envelope?.activeSpace ?? null;
    const personalIsActive = active?.type === "PERSONAL" && active.shared !== true;
    const switchFixesIt =
      rule !== null &&
      rule.tier !== "INTERNAL" &&
      typeof minRank === "number" &&
      accountRank !== null &&
      accountRank >= minRank &&
      personalWorkspaceId !== null &&
      envelope?.personalSpaceAllowed !== false &&
      !personalIsActive;
    if (switchFixesIt) {
      const here = active?.displayName ? ` You're working in ${active.displayName}, whose plan doesn't include it.` : "";
      return (
        <ProovraSystemState
          kind="forbidden"
          context="authenticated"
          presentation="full-page"
          minHeight="60vh"
          testId="surface-gate-switch-personal"
          title="Available in your Personal Space"
          message={`Your own plan includes this, in your Personal Space.${here} Switch to your Personal Space to use it.`}
          actions={[
            {
              label: "Switch to your Personal Space",
              variant: "primary",
              testId: "surface-gate-switch-personal-action",
              onClick: () => {
                void switchWorkspace(null);
              },
            },
            { label: "Back to dashboard", href: "/home", variant: "secondary" },
          ]}
        />
      );
    }
    if (forbiddenFallback) return <>{forbiddenFallback}</>;
    // Canonical access-denied — never a bare "Forbidden" heading.
    return (
      <ProovraSystemState
        kind="forbidden"
        context="authenticated"
        presentation="full-page"
        minHeight="60vh"
        testId="surface-gate-forbidden"
        message={
          // B7A-F-007 — a rule may name what is missing; B3A-F-004 — and who
          // can change the plan when the viewer does not pay for it.
          `${decision.message ?? "This workspace or feature may require additional permissions, or isn't included on your current plan. Ask a workspace admin for access, or head back to the dashboard."}${
            billingAuthority.canManage === false ? ` ${billingAuthority.askCopy}` : ""
          }`
        }
        actions={[
          { label: "Back to dashboard", href: "/home", variant: "primary" },
          ...(billingAuthority.canManage === true
            ? [{ label: "View plans", href: "/billing", variant: "secondary" as const }]
            : []),
          // /support is a public page; this forbidden state renders inside
          // the authenticated App Shell, so open it in a new tab (external
          // cue) rather than replacing the app in the current tab.
          { label: "Contact support", href: "/support", variant: "text", external: true },
        ]}
      />
    );
  }
  // redirect case — render nothing while router.replace runs.
  return null;
}
