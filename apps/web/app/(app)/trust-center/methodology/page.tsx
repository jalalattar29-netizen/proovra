"use client";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { TrustCenterSectionList } from "../_section-list";

export default function MethodologyPage() {
  return (
    <PageRouteGate routeId="workspace.trust_center">
      <div>
        {/*
          Phase 4A enterprise polish — visible cross-link to the legal
          methodology document. The in-product Methodology Center
          surfaces the implementation-backed sections; the legal
          counterpart at /legal/verification-methodology is the full
          legally-styled methodology document. We LINK only — never
          mirror — so neither surface can drift from the other.
        */}
        <div
          style={{
            maxWidth: 1320,
            margin: "0 auto",
            padding: "16px 20px 0",
            color: "#0f172a",
            fontFamily: "Inter, system-ui, sans-serif",
          }}
        >
          <aside
            data-methodology-legal-callout
            style={{
              padding: 12,
              background: "rgba(15, 23, 42, 0.04)",
              border: "1px solid rgba(15, 23, 42, 0.12)",
              borderRadius: 10,
              fontSize: 12,
              color: "#0f172a",
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <strong style={{ fontSize: 12 }}>Legal counterpart</strong>
            <span style={{ color: "#475569" }}>
              For the full legal methodology document, see{" "}
              <a
                data-methodology-legal-link
                href="/legal/verification-methodology"
                style={{ color: "#0f172a", fontWeight: 600 }}
              >
                Evidence Verification Methodology (legal)
              </a>
              .
            </span>
            <a
              data-methodology-legal-cta
              href="/legal/verification-methodology"
              style={{
                marginLeft: "auto",
                fontSize: 11,
                fontWeight: 600,
                color: "#0f172a",
                padding: "4px 8px",
                border: "1px solid #cbd5e1",
                borderRadius: 6,
                background: "#fff",
                textDecoration: "none",
              }}
            >
              Read full legal methodology →
            </a>
          </aside>
        </div>
        <TrustCenterSectionList
          kind="METHODOLOGY"
          title="Verification Methodology Center"
          description="How verification, hashing, trusted timestamps, OpenTimestamps, provenance, verification packages, trust decisions, redaction, and intelligence work. Sourced from actual implementation."
          anchor="methodology"
        />
      </div>
    </PageRouteGate>
  );
}
