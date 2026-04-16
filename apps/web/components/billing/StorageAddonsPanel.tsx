"use client";

import { Card } from "../ui";
import type { WorkspaceStorageAddonSummary } from "./types";

function formatAddonStatus(status?: string | null) {
  const normalized = String(status ?? "").trim().toUpperCase();
  if (!normalized) return "Unknown";
  if (normalized === "ACTIVE") return "Active";
  if (normalized === "PENDING") return "Pending";
  if (normalized === "PAST_DUE") return "Past due";
  if (normalized === "CANCELED") return "Canceled";
  if (normalized === "EXPIRED") return "Expired";
  if (normalized === "FAILED") return "Failed";
  return normalized;
}

function toneForAddonStatus(status?: string | null) {
  const normalized = String(status ?? "").trim().toUpperCase();

  if (normalized === "ACTIVE") {
    return {
      color: "#2b6a55",
      background: "rgba(127,189,180,0.16)",
      border: "1px solid rgba(127,189,180,0.20)",
    } as const;
  }

  if (normalized === "PENDING" || normalized === "PAST_DUE") {
    return {
      color: "#8a6a2b",
      background: "rgba(201,169,139,0.18)",
      border: "1px solid rgba(201,169,139,0.22)",
    } as const;
  }

  if (
    normalized === "FAILED" ||
    normalized === "CANCELED" ||
    normalized === "EXPIRED"
  ) {
    return {
      color: "#8b3e3e",
      background: "rgba(194,78,78,0.10)",
      border: "1px solid rgba(194,78,78,0.16)",
    } as const;
  }

  return {
    color: "#415257",
    background: "rgba(79,112,107,0.08)",
    border: "1px solid rgba(79,112,107,0.12)",
  } as const;
}

function parseMaybeNumber(value: string | number | null | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function formatBytesCompact(value?: string | number | null): string {
  const n = parseMaybeNumber(value);
  if (!Number.isFinite(n) || n == null || n <= 0) return "0 B";

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

export function StorageAddonsPanel({
  items,
}: {
  items: WorkspaceStorageAddonSummary[];
}) {
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
          Storage Add-ons
        </div>

        <div className="mb-5 text-[0.9rem] leading-[1.7] text-[#5d6d71]">
          Review active, pending, and billing-related extra storage attached to
          personal or team workspaces.
        </div>

        {items.length === 0 ? (
          <div className="text-[0.94rem] leading-[1.7] text-[#5d6d71]">
            No storage add-ons recorded yet.
          </div>
        ) : (
          <div className="grid gap-3">
            {items.map((item) => {
              const tone = toneForAddonStatus(item.status);

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
                        {item.addonKey}
                      </div>

                      <div className="mt-1 text-[0.85rem] leading-[1.7] text-[#5d6d71]">
                        {item.teamId ? "Team workspace add-on" : "Personal workspace add-on"}
                        {" · "}
                        {item.billingCycle ?? "—"}
                        {" · "}
                        {item.paymentProvider ?? "Unknown provider"}
                      </div>

                      <div className="mt-1 text-[0.82rem] text-[#7a878a]">
                        Extra storage: {formatBytesCompact(item.extraStorageBytes)}
                      </div>

                      <div className="mt-1 text-[0.82rem] text-[#7a878a]">
                        Current period end: {formatDateLabel(item.currentPeriodEnd)}
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
                      {formatAddonStatus(item.status)}
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