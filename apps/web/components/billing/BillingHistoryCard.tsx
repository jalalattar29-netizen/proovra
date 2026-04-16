"use client";

import { Card } from "../../components/ui";
import type { BillingPaymentSummary } from "./types";

type Props = {
  items: BillingPaymentSummary[];
};

function formatMoney(amountCents: number, currency: string) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amountCents / 100);
}

function formatDate(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function toneForStatus(status: string) {
  const normalized = status.trim().toUpperCase();

  if (normalized === "SUCCEEDED") {
    return {
      color: "#2b6a55",
      background: "rgba(127,189,180,0.16)",
      border: "1px solid rgba(127,189,180,0.20)",
    };
  }

  if (normalized === "FAILED") {
    return {
      color: "#8b3e3e",
      background: "rgba(194,78,78,0.10)",
      border: "1px solid rgba(194,78,78,0.16)",
    };
  }

  if (normalized === "REFUNDED") {
    return {
      color: "#7a624d",
      background: "rgba(183,157,132,0.12)",
      border: "1px solid rgba(183,157,132,0.18)",
    };
  }

  return {
    color: "#415257",
    background: "rgba(79,112,107,0.08)",
    border: "1px solid rgba(79,112,107,0.12)",
  };
}

export function BillingHistoryCard({ items }: Props) {
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
        <div className="mb-2 text-[1.1rem] font-semibold tracking-[-0.02em] text-[#21353a]">
          Recent Payments
        </div>

        <div className="mb-5 text-[0.9rem] leading-[1.7] text-[#5d6d71]">
          Review recent billing activity across personal and team workspace payments.
        </div>

        {items.length === 0 ? (
          <div className="text-[0.94rem] leading-[1.7] text-[#5d6d71]">
            No billing payments recorded yet.
          </div>
        ) : (
          <div className="grid gap-3">
            {items.map((item) => {
              const tone = toneForStatus(item.status);

              return (
                <div
                  key={item.id}
                  className="rounded-[18px] border px-4 py-4"
                  style={{
                    border: "1px solid rgba(79,112,107,0.10)",
                    background:
                      "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
                  }}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-[0.96rem] font-semibold text-[#21353a]">
                        {item.provider} · {formatMoney(item.amountCents, item.currency)}
                      </div>
                      <div className="mt-1 text-[0.85rem] leading-[1.7] text-[#5d6d71]">
                        Created: {formatDate(item.createdAt)}
                        {" · "}
                        {item.teamId ? "Team payment" : "Personal payment"}
                      </div>
                      <div className="mt-1 break-all text-[0.80rem] text-[#7a878a]">
                        Provider payment ID: {item.providerPaymentId}
                      </div>
                    </div>

                    <div
                      className="rounded-full px-3 py-1.5 text-[0.76rem] font-semibold"
                      style={{
                        color: tone.color,
                        background: tone.background,
                        border: tone.border,
                      }}
                    >
                      {item.status}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}