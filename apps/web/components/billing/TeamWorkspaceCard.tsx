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

function hasSubscriptionLike(status?: string | null) {
  const normalized = String(status ?? "").trim().toUpperCase();
  return (
    normalized === "ACTIVE" ||
    normalized === "PAST_DUE" ||
    normalized === "TRIALING"
  );
}

function toneForBillingStatus(status?: string | null) {
  const normalized = String(status ?? "").trim().toUpperCase();

  if (normalized === "ACTIVE") {
    return {
      color: "#2b6a55",
      background: "rgba(127,189,180,0.16)",
      border: "1px solid rgba(127,189,180,0.20)",
      label: "Active",
    };
  }

  if (normalized === "PAST_DUE") {
    return {
      color: "#8a6a2b",
      background: "rgba(201,169,139,0.18)",
      border: "1px solid rgba(201,169,139,0.22)",
      label: "Past due",
    };
  }

  if (normalized === "CANCELED") {
    return {
      color: "#8b3e3e",
      background: "rgba(194,78,78,0.10)",
      border: "1px solid rgba(194,78,78,0.16)",
      label: "Canceled",
    };
  }

  return {
    color: "#415257",
    background: "rgba(79,112,107,0.08)",
    border: "1px solid rgba(79,112,107,0.12)",
    label: normalized || "Inactive",
  };
}

export function TeamWorkspaceCard({
  workspace,
  onSelectForCheckout,
  onCancelSubscription,
  busy,
}: Props) {
  const hasActiveSubscription = hasSubscriptionLike(workspace.subscription?.status);
  const billingTone = toneForBillingStatus(workspace.billingStatus);
  const addonCount = workspace.activeStorageAddonSummary?.count ?? 0;
  const extraStorageBytes =
    workspace.activeStorageAddonSummary?.totalExtraStorageBytes ?? null;

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
              Plan: <strong>{workspace.plan ?? "FREE"}</strong>
              {workspace.effectivePlan && workspace.effectivePlan !== workspace.plan ? (
                <>
                  {" · "}Effective: <strong>{workspace.effectivePlan}</strong>
                </>
              ) : null}
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
                Over seat limit
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
              Seats
            </div>
            <div className="mt-2 text-[0.94rem] font-semibold text-[#21353a]">
              {workspace.seats?.used ?? 0} / {workspace.seats?.included ?? 0}
            </div>
            <div className="mt-1 text-[0.85rem] text-[#5d6d71]">
              Remaining: {workspace.seats?.remaining ?? 0}
            </div>
            <div className="mt-1 text-[0.82rem] text-[#7a878a]">
              Usage: {workspace.seats?.usagePercent ?? 0}%
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
              Status: {workspace.subscription?.status ?? "None"}
            </div>
            <div className="mt-1 text-[0.82rem] text-[#7a878a]">
              Next period: {workspace.subscription?.currentPeriodEnd ?? "—"}
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
              Extra bytes: {extraStorageBytes ?? "0"}
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
          This workspace is used for <strong>TEAM</strong> billing flows. Select
          it in checkout to start or manage a recurring team subscription with
          the correct ownership context.
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
            Select for Team Checkout
          </Button>

          {hasActiveSubscription ? (
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