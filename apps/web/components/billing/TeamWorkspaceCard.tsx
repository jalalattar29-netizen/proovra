"use client";

import { Button, Card } from "../../components/ui";
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

function getDisplayBillingTone(params: {
  billingStatus?: string | null;
  subscriptionStatus?: string | null;
}) {
  const billingNormalized = String(params.billingStatus ?? "")
    .trim()
    .toUpperCase();
  const subscriptionNormalized = String(params.subscriptionStatus ?? "")
    .trim()
    .toUpperCase();

  if (subscriptionNormalized === "TRIALING") {
    return {
      color: "#8a6a2b",
      background: "rgba(201,169,139,0.18)",
      border: "1px solid rgba(201,169,139,0.22)",
      label: "Pending approval",
    } as const;
  }

  if (billingNormalized === "ACTIVE") {
    return {
      color: "#2b6a55",
      background: "rgba(127,189,180,0.16)",
      border: "1px solid rgba(127,189,180,0.20)",
      label: "Active",
    } as const;
  }

  if (billingNormalized === "PAST_DUE") {
    return {
      color: "#8a6a2b",
      background: "rgba(201,169,139,0.18)",
      border: "1px solid rgba(201,169,139,0.22)",
      label: "Past due",
    } as const;
  }

  if (billingNormalized === "CANCELED") {
    return {
      color: "#8b3e3e",
      background: "rgba(194,78,78,0.10)",
      border: "1px solid rgba(194,78,78,0.16)",
      label: "Canceled",
    } as const;
  }

  return {
    color: "#415257",
    background: "rgba(79,112,107,0.08)",
    border: "1px solid rgba(79,112,107,0.12)",
    label: billingNormalized || "Inactive",
  } as const;
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
  const text = String(value ?? "").trim();
  if (!text) return "—";

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return date.toLocaleString();
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
    <Card
      className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
      style={{
        border: "1px solid rgba(79,112,107,0.16)",
        boxShadow:
          "0 18px 38px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.48)",
      }}
    >
      <div className="relative z-10 p-6 md:p-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[1.05rem] font-semibold tracking-[-0.02em] text-[#21353a]">
              {workspace.name}
            </div>

            <div className="mt-2 text-[0.92rem] leading-[1.7] text-[#5d6d71]">
              Workspace plan view: <strong>{displayPlan}</strong>
              <br />
              Effective capability view: <strong>{effectivePlan}</strong>
              <br />
              Billing status: <strong>{billingStatus}</strong>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <div
              className="rounded-full px-3 py-1.5 text-[0.76rem] font-semibold"
              style={{
                color: billingTone.color,
                background: billingTone.background,
                border: billingTone.border,
              }}
            >
              {billingTone.label}
            </div>

            {workspace.overSeatLimit ? (
              <div
                className="rounded-full px-3 py-1.5 text-[0.76rem] font-semibold"
                style={{
                  border: "1px solid rgba(194,78,78,0.20)",
                  background:
                    "linear-gradient(180deg, rgba(164,84,84,0.10) 0%, rgba(130,62,62,0.16) 100%)",
                  color: "#9f3535",
                }}
              >
                Over member limit
              </div>
            ) : null}

            {workspace.workspaceHealth?.storageLimitReached ? (
              <div
                className="rounded-full px-3 py-1.5 text-[0.76rem] font-semibold"
                style={{
                  border: "1px solid rgba(194,78,78,0.20)",
                  background:
                    "linear-gradient(180deg, rgba(164,84,84,0.10) 0%, rgba(130,62,62,0.16) 100%)",
                  color: "#9f3535",
                }}
              >
                Storage full
              </div>
            ) : workspace.workspaceHealth?.storageNearLimit ? (
              <div
                className="rounded-full px-3 py-1.5 text-[0.76rem] font-semibold"
                style={{
                  border: "1px solid rgba(201,169,139,0.22)",
                  background:
                    "linear-gradient(180deg, rgba(201,169,139,0.10) 0%, rgba(170,138,101,0.16) 100%)",
                  color: "#8a6a2b",
                }}
              >
                Storage near limit
              </div>
            ) : null}
          </div>
        </div>

        <div
          className="mt-4 rounded-[18px] border px-4 py-4 text-[0.88rem] leading-[1.75]"
          style={{
            border: "1px solid rgba(79,112,107,0.10)",
            background:
              "linear-gradient(180deg, rgba(255,255,255,0.48) 0%, rgba(243,245,242,0.88) 100%)",
            color: "#5d6d71",
          }}
        >
          {planExplanation}
          <br />
          PRO can support owned team workspaces. TEAM is the higher subscription
          tier for owners who need a larger owned-team limit. Each single team
          still has a hard cap of <strong>5 actual members</strong>.
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div
            className="rounded-[18px] border px-4 py-4"
            style={{
              border: "1px solid rgba(79,112,107,0.10)",
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
            }}
          >
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#9b826b]">
              Storage
            </div>
            <div className="mt-2 text-[0.94rem] font-semibold text-[#21353a]">
              {workspace.storage?.usedLabel ?? "—"} /{" "}
              {workspace.storage?.limitLabel ?? "—"}
            </div>
            <div className="mt-1 text-[0.85rem] text-[#5d6d71]">
              Remaining: {workspace.storage?.remainingLabel ?? "—"}
            </div>
            <div className="mt-1 text-[0.82rem] text-[#7a878a]">
              Usage: {workspace.storage?.usagePercent ?? 0}%
            </div>
          </div>

          <div
            className="rounded-[18px] border px-4 py-4"
            style={{
              border: "1px solid rgba(79,112,107,0.10)",
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
            }}
          >
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#9b826b]">
              Members
            </div>
            <div className="mt-2 text-[0.94rem] font-semibold text-[#21353a]">
              {seatUsed} / {seatLimit}
            </div>
            <div className="mt-1 text-[0.85rem] text-[#5d6d71]">
              Remaining: {seatRemaining}
            </div>
            <div className="mt-1 text-[0.82rem] text-[#7a878a]">
              Hard cap enforced on actual membership, not invites
            </div>
          </div>

          <div
            className="rounded-[18px] border px-4 py-4"
            style={{
              border: "1px solid rgba(79,112,107,0.10)",
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
            }}
          >
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#9b826b]">
              Subscription
            </div>
            <div className="mt-2 text-[0.94rem] font-semibold text-[#21353a]">
              {workspace.subscription?.provider ?? "None"}
            </div>
            <div className="mt-1 text-[0.85rem] text-[#5d6d71]">
              Status: {formatSubscriptionStatusLabel(workspace.subscription?.status)}
            </div>
            <div className="mt-1 text-[0.82rem] text-[#7a878a]">
              Next period:{" "}
              {formatDateLabel(workspace.subscription?.currentPeriodEnd ?? null)}
            </div>
          </div>

          <div
            className="rounded-[18px] border px-4 py-4"
            style={{
              border: "1px solid rgba(79,112,107,0.10)",
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
            }}
          >
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#9b826b]">
              Capabilities
            </div>
            <div className="mt-2 text-[0.88rem] leading-[1.7] text-[#21353a]">
              Reports: {yesNo(workspace.features?.reportsIncluded)}
              <br />
              Package: {yesNo(workspace.features?.verificationPackageIncluded)}
              <br />
              Public verify: {yesNo(workspace.features?.publicVerifyIncluded)}
            </div>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div
            className="rounded-[18px] border px-4 py-4 text-[0.88rem] leading-[1.75]"
            style={{
              border: "1px solid rgba(79,112,107,0.10)",
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.48) 0%, rgba(243,245,242,0.88) 100%)",
              color: "#5d6d71",
            }}
          >
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#9b826b]">
              Evidence count
            </div>
            <div className="mt-2 text-[0.95rem] font-semibold text-[#21353a]">
              {workspace.counts?.evidence ?? 0}
            </div>
          </div>

          <div
            className="rounded-[18px] border px-4 py-4 text-[0.88rem] leading-[1.75]"
            style={{
              border: "1px solid rgba(79,112,107,0.10)",
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.48) 0%, rgba(243,245,242,0.88) 100%)",
              color: "#5d6d71",
            }}
          >
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#9b826b]">
              Active storage add-ons
            </div>
            <div className="mt-2 text-[0.95rem] font-semibold text-[#21353a]">
              {addonCount}
            </div>
            <div className="mt-1 text-[0.82rem] text-[#7a878a]">
              Extra bytes: {formatBytesCompact(extraStorageBytes)}
            </div>
          </div>

          <div
            className="rounded-[18px] border px-4 py-4 text-[0.88rem] leading-[1.75]"
            style={{
              border: "1px solid rgba(79,112,107,0.10)",
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.48) 0%, rgba(243,245,242,0.88) 100%)",
              color: "#5d6d71",
            }}
          >
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#9b826b]">
              Billing ownership
            </div>
            <div className="mt-2 text-[0.95rem] font-semibold text-[#21353a]">
              {workspace.billingOwnerUserId ? "Assigned" : "Not assigned"}
            </div>
          </div>
        </div>

        <div
          className="mt-4 rounded-[18px] border px-4 py-4 text-[0.88rem] leading-[1.75]"
          style={{
            border: "1px solid rgba(79,112,107,0.10)",
            background:
              "linear-gradient(180deg, rgba(255,255,255,0.48) 0%, rgba(243,245,242,0.88) 100%)",
            color: "#5d6d71",
          }}
        >
          Select this workspace below only when you want to start or manage a
          dedicated <strong>TEAM</strong> subscription for it. A team workspace
          may also remain valid because the owner currently has <strong>PRO</strong>.
          Invites do not define the cap. Actual member count does.
        </div>

        <div className="mt-5 flex flex-wrap gap-3">
          <Button
            className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
            style={{
              borderColor: "rgba(79,112,107,0.18)",
              color: "#eef3f1",
              background:
                "linear-gradient(180deg, rgba(62,96,99,0.96) 0%, rgba(24,43,48,0.98) 100%)",
            }}
            onClick={() => onSelectForCheckout(workspace.id)}
          >
            Select for TEAM checkout
          </Button>

          {canCancelSubscription ? (
            <Button
              variant="secondary"
              className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
              style={{
                borderColor: "rgba(194,78,78,0.18)",
                color: "#8b3e3e",
                background:
                  "linear-gradient(180deg, rgba(255,255,255,0.88) 0%, rgba(248,240,240,0.95) 100%)",
              }}
              disabled={busy}
              onClick={() => onCancelSubscription(workspace.id)}
            >
              {busy ? "Cancelling..." : "Cancel Subscription"}
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}