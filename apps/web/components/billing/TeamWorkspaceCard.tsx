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

export function TeamWorkspaceCard({
  workspace,
  onSelectForCheckout,
  onCancelSubscription,
  busy,
}: Props) {
  const hasActiveSubscription =
    workspace.subscription?.status &&
    workspace.subscription.status !== "CANCELED";

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
              {" · "}
              Billing status: <strong>{workspace.billingStatus ?? "INACTIVE"}</strong>
            </div>
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
              {workspace.storage?.usedLabel ?? "—"} / {workspace.storage?.limitLabel ?? "—"}
            </div>
            <div className="mt-1 text-[0.85rem] text-[#5d6d71]">
              Remaining: {workspace.storage?.remainingLabel ?? "—"}
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
          This workspace is used for <strong>TEAM</strong> billing flows. Select it in checkout to
          start or manage a recurring team subscription with the correct ownership context.
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