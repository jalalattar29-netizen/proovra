"use client";

type EnterpriseColumn = {
  displayName?: string;
  summary?: string;
};

type Props = {
  free: {
    maxEvidenceRecords?: number | null;
    storageLabel?: string | null;
  } | null;
  payg: {
    storageLabel?: string | null;
  } | null;
  pro: {
    storageLabel?: string | null;
  } | null;
  team: {
    storageLabel?: string | null;
    seats?: number | null;
  } | null;
  enterprise?: EnterpriseColumn | null;
};

export function PricingComparisonTable({
  free,
  payg,
  pro,
  team,
  enterprise,
}: Props) {
  const rows = [
    {
      label: "Evidence records",
      values: [
        `${free?.maxEvidenceRecords ?? 3} total`,
        "Pay only when you complete evidence",
        "Unlimited",
        "Unlimited across team workspace",
        "Custom operational volume",
      ],
    },
    {
      label: "Storage included",
      values: [
        free?.storageLabel ?? "250 MB",
        payg?.storageLabel ?? "5 GB",
        pro?.storageLabel ?? "100 GB",
        team?.storageLabel ?? "500 GB",
        "Custom storage envelope",
      ],
    },
    {
      label: "Storage add-ons",
      values: [
        "Not available",
        "Selected personal top-ups",
        "One-time personal top-ups",
        "One-time team top-ups",
        "Commercial storage planning",
      ],
    },
    {
      label: "PDF reports",
      values: ["Not included", "Included", "Included", "Included", "Included"],
    },
    {
      label: "Verification package",
      values: ["Not included", "Included", "Included", "Included", "Included"],
    },
    {
      label: "Public verification page",
      values: ["Included", "Included", "Included", "Included", "Included"],
    },
    {
      label: "Workspace type",
      values: [
        "Personal",
        "Personal",
        "Personal",
        "Team workspace",
        "Organization-fit deployment",
      ],
    },
    {
      label: "Included seats",
      values: ["—", "—", "—", `${team?.seats ?? 5} included`, "Custom seat volume"],
    },
    {
      label: "Commercial path",
      values: [
        "Self-serve",
        "Self-serve",
        "Self-serve",
        "Self-serve",
        "Sales-led",
      ],
    },
    {
      label: "Best fit",
      values: [
        "Evaluation and low volume",
        "Usage-based professional output",
        "Recurring individual volume",
        "Shared operational team usage",
        "Procurement, governance, or larger rollout",
      ],
    },
  ];

  const columns = [
    "Capability",
    "Free",
    "Pay-Per-Evidence",
    "Pro",
    "Team",
    enterprise?.displayName || "Enterprise",
  ];

  return (
    <div
      className="rounded-[30px] border p-6 md:p-7"
      style={{
        border: "1px solid rgba(79,112,107,0.14)",
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.72) 0%, rgba(243,245,242,0.96) 100%)",
        boxShadow:
          "0 18px 36px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.55)",
      }}
    >
      <div className="mb-2 text-[1.18rem] font-semibold tracking-[-0.025em] text-[#21353a]">
        Compare plans
      </div>

      <div className="mb-5 max-w-[920px] text-[0.94rem] leading-[1.8] text-[#5d6d71]">
        Compare evidence volume, storage, collaboration fit, review outputs, and
        commercial path before choosing a self-serve checkout or an enterprise
        discussion.
      </div>

      <div
        className="overflow-x-auto rounded-[24px] border"
        style={{
          border: "1px solid rgba(79,112,107,0.10)",
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.56) 0%, rgba(243,245,242,0.90) 100%)",
        }}
      >
        <table
          style={{
            width: "100%",
            borderCollapse: "separate",
            borderSpacing: 0,
            minWidth: 1120,
          }}
        >
          <thead>
            <tr>
              {columns.map((column, index) => (
                <th
                  key={column}
                  style={{
                    ...thStyle,
                    color:
                      index === columns.length - 1
                        ? "#8a6a2b"
                        : index === 2
                          ? "#2f6965"
                          : index === 3
                            ? "#8a6e57"
                            : "#21353a",
                  }}
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={row.label}>
                <td
                  style={{
                    ...tdLabelStyle,
                    background:
                      rowIndex % 2 === 0
                        ? "rgba(255,255,255,0.42)"
                        : "rgba(255,255,255,0.18)",
                  }}
                >
                  {row.label}
                </td>

                {row.values.map((value, index) => (
                  <td
                    key={`${row.label}-${index}`}
                    style={{
                      ...tdStyle,
                      background:
                        rowIndex % 2 === 0
                          ? index === row.values.length - 1
                            ? "rgba(201,169,139,0.08)"
                            : "rgba(255,255,255,0.42)"
                          : index === row.values.length - 1
                            ? "rgba(201,169,139,0.05)"
                            : "rgba(255,255,255,0.18)",
                      color:
                        index === row.values.length - 1 ? "#5f574d" : "#415257",
                    }}
                  >
                    {value}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div
        className="mt-5 rounded-[22px] border px-5 py-5"
        style={{
          border: "1px solid rgba(183,157,132,0.16)",
          background:
            "linear-gradient(180deg, rgba(247,242,237,0.92) 0%, rgba(255,255,255,0.72) 100%)",
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.68), 0 12px 24px rgba(92,69,50,0.05)",
        }}
      >
        <div className="text-[0.8rem] font-semibold uppercase tracking-[0.16em] text-[#9b826b]">
          Enterprise clarification
        </div>
        <div className="mt-2 text-[0.97rem] font-semibold tracking-[-0.02em] text-[#23373b]">
          {enterprise?.displayName || "Enterprise"} is not just “more seats”.
        </div>
        <div className="mt-2 max-w-[980px] text-[0.9rem] leading-[1.8] text-[#5d6d71]">
          It is the route for larger organizations that need procurement review,
          governance discussion, retention alignment, shared review rollout, or
          higher-volume operational fit.
        </div>
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "16px 16px",
  borderBottom: "1px solid rgba(79,112,107,0.12)",
  fontSize: 12,
  fontWeight: 800,
  textTransform: "uppercase",
  letterSpacing: "0.16em",
  background:
    "linear-gradient(180deg, rgba(255,255,255,0.78) 0%, rgba(246,248,246,0.94) 100%)",
  position: "sticky",
  top: 0,
  zIndex: 1,
};

const tdStyle: React.CSSProperties = {
  padding: "16px",
  borderBottom: "1px solid rgba(79,112,107,0.08)",
  fontSize: 14,
  lineHeight: 1.75,
  verticalAlign: "top",
};

const tdLabelStyle: React.CSSProperties = {
  ...tdStyle,
  color: "#21353a",
  fontWeight: 700,
  minWidth: 220,
};