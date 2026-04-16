"use client";

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
};

export function PricingComparisonTable({ free, payg, pro, team }: Props) {
  const rows = [
    {
      label: "Evidence records",
      values: [
        `${free?.maxEvidenceRecords ?? 3} total`,
        "Pay only when you complete evidence",
        "Unlimited",
        "Unlimited across team workspace",
      ],
    },
    {
      label: "Storage included",
      values: [
        free?.storageLabel ?? "250 MB",
        payg?.storageLabel ?? "5 GB",
        pro?.storageLabel ?? "100 GB",
        team?.storageLabel ?? "500 GB",
      ],
    },
    {
      label: "Storage add-ons",
      values: [
        "Not available",
        "Selected personal top-ups",
        "One-time personal top-ups",
        "One-time team top-ups",
      ],
    },
    {
      label: "PDF reports",
      values: ["Not included", "Included", "Included", "Included"],
    },
    {
      label: "Verification package",
      values: ["Not included", "Included", "Included", "Included"],
    },
    {
      label: "Public verification page",
      values: ["Included", "Included", "Included", "Included"],
    },
    {
      label: "Workspace type",
      values: ["Personal", "Personal", "Personal", "Team workspace"],
    },
    {
      label: "Included seats",
      values: ["—", "—", "—", `${team?.seats ?? 5} seats included`],
    },
    {
      label: "Billing model",
      values: [
        "Free",
        "One-time purchase",
        "Recurring monthly",
        "Recurring monthly",
      ],
    },
  ];

  return (
    <div
      className="rounded-[28px] border p-5 md:p-6"
      style={{
        border: "1px solid rgba(79,112,107,0.14)",
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.66) 0%, rgba(243,245,242,0.96) 100%)",
      }}
    >
      <div className="mb-2 text-[1.08rem] font-semibold tracking-[-0.02em] text-[#21353a]">
        Compare plans
      </div>

      <div className="mb-4 text-[0.9rem] leading-[1.7] text-[#5d6d71]">
        Use this table to compare evidence limits, storage, reports,
        subscriptions, one-time add-ons, and team capacity before moving into checkout.
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
          <thead>
            <tr>
              <th style={thStyle}>Capability</th>
              <th style={thStyle}>Free</th>
              <th style={thStyle}>Pay-Per-Evidence</th>
              <th style={thStyle}>Pro</th>
              <th style={thStyle}>Team</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <td style={tdLabelStyle}>{row.label}</td>
                {row.values.map((value, index) => (
                  <td key={`${row.label}-${index}`} style={tdStyle}>
                    {value}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "12px 14px",
  borderBottom: "1px solid rgba(79,112,107,0.12)",
  color: "#21353a",
  fontSize: 13,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.14em",
};

const tdStyle: React.CSSProperties = {
  padding: "14px",
  borderBottom: "1px solid rgba(79,112,107,0.08)",
  color: "#415257",
  fontSize: 14,
  lineHeight: 1.7,
  verticalAlign: "top",
};

const tdLabelStyle: React.CSSProperties = {
  ...tdStyle,
  color: "#21353a",
  fontWeight: 700,
  minWidth: 190,
};