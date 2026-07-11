"use client";

import { Badge, type BadgeTone } from "../ui/Badge";
import { formatUserDateTime } from "../../lib/date";
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
  const formatted = formatUserDateTime(value);
  return formatted === "Not available" ? "—" : formatted;
}

// Semantic status tone: paid/succeeded → green (verified), refunded →
// neutral (slate), failed → red (risk); everything else neutral.
function toneForStatus(status: string): BadgeTone {
  const normalized = status.trim().toUpperCase();
  if (normalized === "SUCCEEDED") return "verified";
  if (normalized === "FAILED") return "risk";
  if (normalized === "REFUNDED") return "neutral";
  return "neutral";
}

export function BillingHistoryCard({ items }: Props) {
  return (
    <div className="cases-panel" style={{ overflow: "hidden" }}>
      <div className="relative z-10 p-6 md:p-7">
        <div className="mb-2 text-[1.1rem] font-semibold tracking-[-0.02em] text-[#172033]">
          Recent Payments
        </div>

        <div className="mb-5 text-[0.9rem] leading-[1.7] text-[#475569]">
          Review recent billing activity across personal and workspace payments.
        </div>

        {items.length === 0 ? (
          <div className="cases-empty" data-billing-history-empty>
            <strong>No payments yet</strong>
            <p>Billing payments will appear here after your first checkout.</p>
          </div>
        ) : (
          <div className="grid gap-3">
            {items.map((item) => (
              <div key={item.id} className="cases-inner px-4 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-[0.96rem] font-semibold text-[#172033]">
                      {item.provider} ·{" "}
                      {formatMoney(item.amountCents, item.currency)}
                    </div>
                    <div className="mt-1 text-[0.85rem] leading-[1.7] text-[#475569]">
                      Created: {formatDate(item.createdAt)}
                      {" · "}
                      {item.teamId ? "Team payment" : "Personal payment"}
                    </div>
                    <div className="mt-1 break-all text-[0.80rem] text-[#5F6878]">
                      Provider payment ID: {item.providerPaymentId}
                    </div>
                  </div>

                  <Badge tone={toneForStatus(item.status)} data-payment-status>
                    {item.status}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
