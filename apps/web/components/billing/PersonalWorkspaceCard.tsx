"use client";

import { Card } from "../../components/ui";
import type { PersonalWorkspaceSummary } from "./types";

type Props = {
  workspace: PersonalWorkspaceSummary | null | undefined;
};

function featureValue(value?: boolean) {
  return value ? "Included" : "Not included";
}

export function PersonalWorkspaceCard({ workspace }: Props) {
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
        <div className="mb-5 text-[1.1rem] font-semibold tracking-[-0.02em] text-[#21353a]">
          Personal Workspace
        </div>

        <div
          className="rounded-[24px] border px-5 py-5"
          style={{
            border: "1px solid rgba(79,112,107,0.10)",
            background:
              "linear-gradient(180deg, rgba(255,255,255,0.22) 0%, rgba(247,248,245,0.30) 100%)",
          }}
        >
          <div className="text-[12px] font-bold uppercase tracking-[0.16em] text-[#9b826b]">
            Current personal plan
          </div>

          <div className="mt-3 text-[1.9rem] font-bold tracking-[-0.05em] text-[#1f3438]">
            {workspace?.plan ?? "FREE"}
          </div>

          <div className="mt-3 grid gap-2 text-[0.95rem] leading-[1.7] text-[#5d6d71]">
            <div>
              Usage credits:{" "}
              <strong style={{ color: "#1f3438" }}>{workspace?.credits ?? 0}</strong>
            </div>

            <div>
              Storage used:{" "}
              <strong style={{ color: "#1f3438" }}>
                {workspace?.storage?.usedLabel ?? "—"}
              </strong>
            </div>

            <div>
              Storage remaining:{" "}
              <strong style={{ color: "#1f3438" }}>
                {workspace?.storage?.remainingLabel ?? "—"}
              </strong>
            </div>

            <div>
              Storage limit:{" "}
              <strong style={{ color: "#1f3438" }}>
                {workspace?.storage?.limitLabel ?? "—"}
              </strong>
            </div>

            <div>
              Subscription provider:{" "}
              <strong style={{ color: "#1f3438" }}>
                {workspace?.subscription?.provider ?? "None"}
              </strong>
            </div>

            <div>
              Subscription status:{" "}
              <strong style={{ color: "#1f3438" }}>
                {workspace?.subscription?.status ?? "None"}
              </strong>
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
          Use the checkout console above for <strong>PAYG</strong> one-time purchases or a recurring{" "}
          <strong>PRO</strong> subscription tied to your personal workspace.
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <div
            className="rounded-[18px] border px-4 py-4"
            style={{
              border: "1px solid rgba(79,112,107,0.10)",
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
            }}
          >
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#9b826b]">
              PDF Reports
            </div>
            <div className="mt-2 text-[0.94rem] font-semibold text-[#21353a]">
              {featureValue(workspace?.features?.reportsIncluded)}
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
              Verification Package
            </div>
            <div className="mt-2 text-[0.94rem] font-semibold text-[#21353a]">
              {featureValue(workspace?.features?.verificationPackageIncluded)}
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
              Public Verify
            </div>
            <div className="mt-2 text-[0.94rem] font-semibold text-[#21353a]">
              {featureValue(workspace?.features?.publicVerifyIncluded)}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}