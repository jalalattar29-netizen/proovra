"use client";

import { Badge, type BadgeTone } from "../ui/Badge";
import { formatUserDate } from "../../lib/date";
import type { TeamWorkspaceSummary } from "./types";

type Props = {
  workspace: TeamWorkspaceSummary;
  onSelectForCheckout: (teamId: string) => void;
  onCancelSubscription: (teamId: string) => void;
  busy?: boolean;
};

function yesNo(value?: boolean | null) {
  return value ? "Included" : "Not included";
}

function hasCancelableSubscription(status?: string | null) {
  const normalized = String(status ?? "").trim().toUpperCase();
  return (
    normalized === "ACTIVE" ||
    normalized === "PAST_DUE" ||
    normalized === "TRIALING"
  );
}

function normalizeLabel(value?: string | null, fallback = "None") {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized || fallback;
}

function formatSubscriptionStatusLabel(status?: string | null) {
  const normalized = String(status ?? "").trim().toUpperCase();

  if (normalized === "ACTIVE") return "Active";
  if (normalized === "PAST_DUE") return "Past due";
  if (normalized === "TRIALING") return "Pending approval";
  if (normalized === "CANCELED") return "Canceled";
  return normalized || "None";
}

// Semantic billing tone → canonical Badge tone. green=active,
// amber=pending/past-due, red=canceled, slate=inactive/neutral.
function getDisplayBillingTone(params: {
  billingStatus?: string | null;
  subscriptionStatus?: string | null;
}): { tone: BadgeTone; label: string } {
  const billingNormalized = String(params.billingStatus ?? "")
    .trim()
    .toUpperCase();
  const subscriptionNormalized = String(params.subscriptionStatus ?? "")
    .trim()
    .toUpperCase();

  if (subscriptionNormalized === "TRIALING") {
    return { tone: "pending", label: "Pending approval" };
  }

  if (billingNormalized === "ACTIVE") {
    return { tone: "verified", label: "Active" };
  }

  if (billingNormalized === "PAST_DUE") {
    return { tone: "pending", label: "Past due" };
  }

  if (billingNormalized === "CANCELED") {
    return { tone: "risk", label: "Canceled" };
  }

  return { tone: "neutral", label: billingNormalized || "Inactive" };
}

function formatBytesCompact(value?: string | number | null): string {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(n) || n <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let size = n;
  let index = 0;

  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }

  const fixed = index === 0 ? 0 : size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(fixed)} ${units[index]}`;
}

function formatDateLabel(value?: string | null): string {
  const formatted = formatUserDate(value);
  return formatted === "Not available" ? "—" : formatted;
}

export function TeamWorkspaceCard({
  workspace,
  onSelectForCheckout,
  onCancelSubscription,
  busy,
}: Props) {
  const canCancelSubscription = hasCancelableSubscription(
    workspace.subscription?.status
  );

  const billingTone = getDisplayBillingTone({
    billingStatus: workspace.billingStatus,
    subscriptionStatus: workspace.subscription?.status,
  });

  const addonCount = workspace.activeStorageAddonSummary?.count ?? 0;
  const extraStorageBytes =
    workspace.activeStorageAddonSummary?.totalExtraStorageBytes ?? null;

  const displayPlan = normalizeLabel(workspace.plan, "FREE");
  const effectivePlan = normalizeLabel(workspace.effectivePlan, displayPlan);
  const billingStatus = normalizeLabel(workspace.billingStatus, "INACTIVE");
  const seatLimit = workspace.seats?.included ?? 0;
  const seatUsed = workspace.seats?.used ?? 0;
  const seatRemaining = workspace.seats?.remaining ?? 0;

  const planExplanation =
    effectivePlan === "TEAM"
      ? "This workspace currently has TEAM-level capability."
      : effectivePlan === "PRO"
        ? "This workspace is currently operating under the owner's PRO entitlement."
        : "This workspace is currently outside active paid team capability.";

  return (
    <div className="cases-panel" style={{ overflow: "hidden" }}>
      <div className="relative z-10 p-6 md:p-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[1.05rem] font-semibold tracking-[-0.02em] text-[#172033]">
              {workspace.name}
            </div>

            <div className="mt-2 text-[0.92rem] leading-[1.7] text-[#475569]">
              Workspace plan view: <strong>{displayPlan}</strong>
              <br />
              Effective capability view: <strong>{effectivePlan}</strong>
              <br />
              Billing status: <strong>{billingStatus}</strong>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Badge tone={billingTone.tone} data-workspace-billing-status>
              {billingTone.label}
            </Badge>

            {workspace.overSeatLimit ? (
              <Badge tone="risk" data-workspace-over-seat-limit>
                Over member limit
              </Badge>
            ) : null}

            {workspace.workspaceHealth?.storageLimitReached ? (
              <Badge tone="risk" data-workspace-storage-full>
                Storage full
              </Badge>
            ) : workspace.workspaceHealth?.storageNearLimit ? (
              <Badge tone="pending" data-workspace-storage-near-limit>
                Storage near limit
              </Badge>
            ) : null}
          </div>
        </div>

        <div className="cases-inner mt-4 px-4 py-4 text-[0.88rem] leading-[1.75] text-[#475569]">
          {planExplanation}
          <br />
          PRO can support owned organization workspaces. TEAM is the higher
          subscription tier for owners who need a larger owned-organization
          limit. Each single workspace still has a hard cap of
          <strong>5 actual members</strong>.
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="cases-inner px-4 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#5F6878]">
              Storage
            </div>
            <div className="mt-2 text-[0.94rem] font-semibold text-[#172033]">
              {workspace.storage?.usedLabel ?? "—"} /{" "}
              {workspace.storage?.limitLabel ?? "—"}
            </div>
            <div className="mt-1 text-[0.85rem] text-[#475569]">
              Remaining: {workspace.storage?.remainingLabel ?? "—"}
            </div>
            <div className="mt-1 text-[0.82rem] text-[#5F6878]">
              Usage: {workspace.storage?.usagePercent ?? 0}%
            </div>
          </div>

          <div className="cases-inner px-4 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#5F6878]">
              Members
            </div>
            <div className="mt-2 text-[0.94rem] font-semibold text-[#172033]">
              {seatUsed} / {seatLimit}
            </div>
            <div className="mt-1 text-[0.85rem] text-[#475569]">
              Remaining: {seatRemaining}
            </div>
            <div className="mt-1 text-[0.82rem] text-[#5F6878]">
              Hard cap enforced on actual membership, not invites
            </div>
          </div>

          <div className="cases-inner px-4 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#5F6878]">
              Subscription
            </div>
            <div className="mt-2 text-[0.94rem] font-semibold text-[#172033]">
              {workspace.subscription?.provider ?? "None"}
            </div>
            <div className="mt-1 text-[0.85rem] text-[#475569]">
              Status: {formatSubscriptionStatusLabel(workspace.subscription?.status)}
            </div>
            <div className="mt-1 text-[0.82rem] text-[#5F6878]">
              Next period:{" "}
              {formatDateLabel(workspace.subscription?.currentPeriodEnd ?? null)}
            </div>
          </div>

          <div className="cases-inner px-4 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#5F6878]">
              Capabilities
            </div>
            <div className="mt-2 text-[0.88rem] leading-[1.7] text-[#172033]">
              Reports: {yesNo(workspace.features?.reportsIncluded)}
              <br />
              Package: {yesNo(workspace.features?.verificationPackageIncluded)}
              <br />
              Public verify: {yesNo(workspace.features?.publicVerifyIncluded)}
            </div>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div className="cases-inner px-4 py-4 text-[0.88rem] leading-[1.75] text-[#475569]">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#5F6878]">
              Evidence count
            </div>
            <div className="mt-2 text-[0.95rem] font-semibold text-[#172033]">
              {workspace.counts?.evidence ?? 0}
            </div>
          </div>

          <div className="cases-inner px-4 py-4 text-[0.88rem] leading-[1.75] text-[#475569]">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#5F6878]">
              Active storage add-ons
            </div>
            <div className="mt-2 text-[0.95rem] font-semibold text-[#172033]">
              {addonCount}
            </div>
            <div className="mt-1 text-[0.82rem] text-[#5F6878]">
              Extra bytes: {formatBytesCompact(extraStorageBytes)}
            </div>
          </div>

          <div className="cases-inner px-4 py-4 text-[0.88rem] leading-[1.75] text-[#475569]">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#5F6878]">
              Billing ownership
            </div>
            <div className="mt-2 text-[0.95rem] font-semibold text-[#172033]">
              {workspace.billingOwnerUserId ? "Assigned" : "Not assigned"}
            </div>
          </div>
        </div>

        <div className="cases-inner mt-4 px-4 py-4 text-[0.88rem] leading-[1.75] text-[#475569]">
          Select this workspace below only when you want to start or manage a
          dedicated <strong>TEAM</strong> subscription for it. A workspace
          may also remain valid because the owner currently has <strong>PRO</strong>.
          Invites do not define the cap. Actual member count does.
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="app-header-primary-action"
            onClick={() => onSelectForCheckout(workspace.id)}
          >
            <span>Select for TEAM checkout</span>
          </button>

          {canCancelSubscription ? (
            <button
              type="button"
              className="cases-remove-action"
              disabled={busy}
              onClick={() => onCancelSubscription(workspace.id)}
            >
              {busy ? "Cancelling..." : "Cancel subscription"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}