"use client";

/**
 * B3B-F-104 (Free-user audit 0ea0, owner directive) — Intake Links in
 * MANAGE-ONLY mode.
 *
 * The page loads for an operator whose workspace plan no longer includes
 * intake (navigation still hides the entry: routeRegistry
 * `navPlanFeature: "intakeIncluded"`), so the standing links they kept stay
 * listed, inspectable, disable-able and archivable under the API's own object
 * and actor rules (A1-06). CREATING a link is the plan's: the primary action,
 * the empty-state starters, the `?new=1` deep link and the wizard are offered
 * only while `planFeatures.intakeIncluded` is KNOWN true (fail-closed while
 * the projection is unknown), and the page says why creation is unavailable.
 * The API refuses creation and resend on the plan regardless.
 */

import Link from "next/link";
import * as React from "react";

import {
  usePlanFeatureGate,
  usePlatformContext,
} from "../../../../lib/platform-context";

export function useIntakeCreation(canManage: boolean): {
  canCreate: boolean;
  manageOnly: boolean;
} {
  const { envelope } = usePlatformContext();
  const included = usePlanFeatureGate("intakeIncluded");
  return {
    canCreate: canManage && included,
    manageOnly: Boolean(envelope) && canManage && !included,
  };
}

export function ManageOnlyNotice({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div className="app-page-header__actions" role="note" data-intake-links-manage-only="true">
      <p className="app-hint">
        <strong>New intake links aren&apos;t included in your current plan.</strong>{" "}
        You can still review, disable and archive the links you already have. To
        create links again, change plan in <Link href="/billing">Billing</Link>.
      </p>
    </div>
  );
}
