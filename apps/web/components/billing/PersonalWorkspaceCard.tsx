"use client";

import type { PersonalWorkspaceSummary } from "./types";

type Props = {
  workspace: PersonalWorkspaceSummary | null | undefined;
};

function featureValue(value?: boolean) {
  return value ? "Included" : "Not included";
}

function formatSubscriptionStatus(status?: string | null) {
  const normalized = String(status ?? "").trim().toUpperCase();
  if (!normalized) return "None";

  if (normalized === "ACTIVE") return "Active";
  if (normalized === "PAST_DUE") return "Past due";
  if (normalized === "TRIALING") return "Pending / trialing";
  if (normalized === "CANCELED") return "Canceled";

  return normalized;
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

export function PersonalWorkspaceCard({ workspace }: Props) {
  const addonCount = workspace?.activeStorageAddonSummary?.count ?? 0;
  const extraStorageBytes =
    workspace?.activeStorageAddonSummary?.totalExtraStorageBytes ?? "0";

  return (
    <div className="cases-panel" style={{ overflow: "hidden" }}>
      <div className="relative z-10 p-6 md:p-7">
        <div className="mb-5 text-[1.1rem] font-semibold tracking-[-0.02em] text-[#172033]">
          Personal Workspace
        </div>

        <div className="cases-inner px-5 py-5">
          <div className="text-[12px] font-bold uppercase tracking-[0.14em] text-[#5F6878]">
            Current personal plan
          </div>

          <div className="mt-3 text-[1.9rem] font-bold tracking-[-0.05em] text-[#172033]">
            {workspace?.plan ?? "FREE"}
          </div>

          <div className="mt-3 grid gap-2 text-[0.95rem] leading-[1.7] text-[#475569]">
            <div>
              Usage credits:{" "}
              <strong style={{ color: "#172033" }}>
                {workspace?.credits ?? 0}
              </strong>
            </div>

            <div>
              Storage used:{" "}
              <strong style={{ color: "#172033" }}>
                {workspace?.storage?.usedLabel ?? "—"}
              </strong>
            </div>

            <div>
              Storage remaining:{" "}
              <strong style={{ color: "#172033" }}>
                {workspace?.storage?.remainingLabel ?? "—"}
              </strong>
            </div>

            <div>
              Storage limit:{" "}
              <strong style={{ color: "#172033" }}>
                {workspace?.storage?.limitLabel ?? "—"}
              </strong>
            </div>

            <div>
              Storage add-ons:{" "}
              <strong style={{ color: "#172033" }}>{addonCount}</strong>
            </div>

            <div>
              Extra add-on bytes:{" "}
              <strong style={{ color: "#172033" }}>
                {formatBytesCompact(extraStorageBytes)}
              </strong>
            </div>

            <div>
              Subscription provider:{" "}
              <strong style={{ color: "#172033" }}>
                {workspace?.subscription?.provider ?? "None"}
              </strong>
            </div>

            <div>
              Subscription status:{" "}
              <strong style={{ color: "#172033" }}>
                {formatSubscriptionStatus(workspace?.subscription?.status)}
              </strong>
            </div>
          </div>
        </div>

        <div className="cases-inner mt-4 px-4 py-4 text-[0.88rem] leading-[1.75] text-[#475569]">
          Use the checkout console above for <strong>PAYG</strong> one-time
          purchases or a recurring <strong>PRO</strong> subscription tied to
          your personal workspace. Extra storage is now purchased as a
          <strong> one-time top-up</strong> from the billing page and does not
          create a second monthly storage subscription.
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <div className="cases-inner px-4 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#5F6878]">
              PDF Reports
            </div>
            <div className="mt-2 text-[0.94rem] font-semibold text-[#172033]">
              {featureValue(workspace?.features?.reportsIncluded)}
            </div>
          </div>

          <div className="cases-inner px-4 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#5F6878]">
              Verification Package
            </div>
            <div className="mt-2 text-[0.94rem] font-semibold text-[#172033]">
              {featureValue(workspace?.features?.verificationPackageIncluded)}
            </div>
          </div>

          <div className="cases-inner px-4 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#5F6878]">
              Public Verify
            </div>
            <div className="mt-2 text-[0.94rem] font-semibold text-[#172033]">
              {featureValue(workspace?.features?.publicVerifyIncluded)}
            </div>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div className="cases-inner px-4 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#5F6878]">
              Evidence count
            </div>
            <div className="mt-2 text-[0.94rem] font-semibold text-[#172033]">
              {workspace?.counts?.evidence ?? 0}
            </div>
          </div>

          <div className="cases-inner px-4 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#5F6878]">
              Storage usage
            </div>
            <div className="mt-2 text-[0.94rem] font-semibold text-[#172033]">
              {workspace?.storage?.usagePercent ?? 0}%
            </div>
          </div>

          <div className="cases-inner px-4 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#5F6878]">
              Workspace health
            </div>
            <div className="mt-2 text-[0.88rem] leading-[1.7] text-[#172033]">
              Near limit: {workspace?.workspaceHealth?.storageNearLimit ? "Yes" : "No"}
              <br />
              Limit reached: {workspace?.workspaceHealth?.storageLimitReached ? "Yes" : "No"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}