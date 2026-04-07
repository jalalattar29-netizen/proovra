"use client";

import { useMemo, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../../components/ui";
import { MarketingHeader } from "../../components/header";

function ShieldIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2l7 3v6c0 5.25-3.438 10.125-7 11-3.562-.875-7-5.75-7-11V5l7-3Zm0 2.18L7 6.32V11c0 4.164 2.61 8.11 5 8.95 2.39-.84 5-4.786 5-8.95V6.32l-5-2.14Z"
      />
    </svg>
  );
}

function FingerprintIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 3a6 6 0 0 0-6 6v1a1 1 0 1 0 2 0V9a4 4 0 0 1 8 0v1a1 1 0 1 0 2 0V9a6 6 0 0 0-6-6Zm0 5a1 1 0 0 0-1 1v2a9 9 0 0 0 2.638 6.362l1.655 1.655a1 1 0 1 0 1.414-1.414l-1.655-1.655A7 7 0 0 1 13 11V9a1 1 0 0 0-1-1Zm-4 3a1 1 0 0 0-1 1c0 2.673.948 5.26 2.676 7.296a1 1 0 0 0 1.524-1.296A9.19 9.19 0 0 1 9 12a1 1 0 0 0-1-1Zm8 0a1 1 0 0 0-1 1c0 1.978.77 3.838 2.168 5.236a1 1 0 0 0 1.414-1.414A5.36 5.36 0 0 1 17 12a1 1 0 0 0-1-1Zm-4 4a1 1 0 0 0-.832 1.555l1.6 2.4a1 1 0 1 0 1.664-1.11l-1.6-2.4A1 1 0 0 0 12 15Z"
      />
    </svg>
  );
}

function TimelineIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M7 2a1 1 0 0 1 1 1v1h8V3a1 1 0 1 1 2 0v1h1a2 2 0 0 1 2 2v3H3V6a2 2 0 0 1 2-2h1V3a1 1 0 0 1 1-1Zm14 9v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7h18ZM7 14h4a1 1 0 1 0 0-2H7a1 1 0 1 0 0 2Zm0 4h7a1 1 0 1 0 0-2H7a1 1 0 1 0 0 2Z"
      />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 1 1 6 0v3H9Zm3 3a2 2 0 0 1 1 3.732V18a1 1 0 1 1-2 0v-1.268A2 2 0 0 1 12 13Z"
      />
    </svg>
  );
}

const TRUST_ITEMS = [
  {
    title: "Hash and fingerprint checks",
    description: "Review file-level integrity markers and cryptographic fingerprints.",
    icon: <FingerprintIcon />,
  },
  {
    title: "Signature and custody timeline",
    description: "Inspect signing status, custody events, and evidentiary flow.",
    icon: <TimelineIcon />,
  },
  {
    title: "Timestamp and storage indicators",
    description: "See TSA, OpenTimestamps, and immutability-related storage signals.",
    icon: <LockIcon />,
  },
] as const;

export default function VerifyIntroPage() {
  const [token, setToken] = useState("");
  const router = useRouter();

  const trimmedToken = token.trim();
  const canSubmit = trimmedToken.length > 0;

  const ui = useMemo(
    () => ({
      heroShadow: "0 28px 80px rgba(3, 10, 24, 0.42)",
      heroBorder: "1px solid rgba(255, 255, 255, 0.10)",
      panelBorder: "1px solid rgba(15, 23, 42, 0.08)",
      softPanel: "linear-gradient(180deg, rgba(255,255,255,0.96), rgba(245,248,252,0.93))",
      inputShadow: "0 10px 30px rgba(15, 23, 42, 0.08)",
    }),
    []
  );

  const handleVerify = () => {
    if (!canSubmit) return;
    router.push(`/verify/${encodeURIComponent(trimmedToken)}`);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleVerify();
    }
  };

  return (
    <div className="page landing-page">
      <div className="blue-shell">
        <MarketingHeader />

        <div className="container">
          <main
            style={{
              minHeight: "calc(100vh - 92px)",
              display: "grid",
              alignItems: "center",
              paddingTop: 48,
              paddingBottom: 72,
            }}
          >
            <section
              style={{
                maxWidth: 1120,
                width: "100%",
                margin: "0 auto",
                display: "grid",
                gridTemplateColumns: "1.08fr 0.92fr",
                gap: 24,
                borderRadius: 30,
                padding: 24,
                background: "rgba(8, 17, 37, 0.30)",
                backdropFilter: "blur(10px)",
                border: ui.heroBorder,
                boxShadow: ui.heroShadow,
              }}
            >
              <div
                style={{
                  borderRadius: 26,
                  padding: 32,
                  background: ui.softPanel,
                  border: ui.panelBorder,
                  minHeight: 560,
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                }}
              >
                <div style={{ display: "grid", gap: 20 }}>
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 10,
                      width: "fit-content",
                      borderRadius: 999,
                      padding: "10px 14px",
                      background: "rgba(15, 23, 42, 0.08)",
                      color: "#475569",
                      fontSize: 12,
                      fontWeight: 800,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                    }}
                  >
                    <ShieldIcon />
                    Verification portal
                  </div>

                  <div style={{ display: "grid", gap: 14 }}>
                    <h1
                      style={{
                        margin: 0,
                        fontSize: "clamp(2rem, 4vw, 3.15rem)",
                        lineHeight: 1.05,
                        letterSpacing: "-0.03em",
                        color: "#0f172a",
                        fontWeight: 800,
                        maxWidth: 700,
                      }}
                    >
                      Review digital evidence with a clearer trust trail.
                    </h1>

                    <p
                      style={{
                        margin: 0,
                        fontSize: 17,
                        lineHeight: 1.75,
                        color: "#475569",
                        maxWidth: 760,
                      }}
                    >
                      Enter a verification token to inspect integrity materials, signature status,
                      custody history, timestamp evidence, and storage-protection indicators
                      associated with a PROOVRA evidence record.
                    </p>
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                      gap: 14,
                    }}
                  >
                    {TRUST_ITEMS.map((item) => (
                      <div
                        key={item.title}
                        style={{
                          borderRadius: 20,
                          padding: 18,
                          background: "rgba(255,255,255,0.72)",
                          border: "1px solid rgba(15, 23, 42, 0.08)",
                          boxShadow: "0 8px 24px rgba(15, 23, 42, 0.05)",
                          display: "grid",
                          gap: 10,
                        }}
                      >
                        <div
                          style={{
                            width: 40,
                            height: 40,
                            borderRadius: 12,
                            display: "grid",
                            placeItems: "center",
                            background: "rgba(12, 27, 70, 0.08)",
                            color: "#102a5c",
                          }}
                        >
                          {item.icon}
                        </div>

                        <div
                          style={{
                            fontSize: 15,
                            lineHeight: 1.35,
                            fontWeight: 700,
                            color: "#0f172a",
                          }}
                        >
                          {item.title}
                        </div>

                        <div
                          style={{
                            fontSize: 13.5,
                            lineHeight: 1.6,
                            color: "#64748b",
                          }}
                        >
                          {item.description}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div
                  style={{
                    marginTop: 28,
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 10,
                  }}
                >
                  {[
                    "Tamper-evident signals",
                    "Verification timeline",
                    "TSA / OTS visibility",
                    "Storage protection context",
                  ].map((item) => (
                    <span
                      key={item}
                      style={{
                        borderRadius: 999,
                        padding: "10px 14px",
                        background: "rgba(12, 27, 70, 0.07)",
                        border: "1px solid rgba(12, 27, 70, 0.08)",
                        color: "#27416f",
                        fontSize: 13,
                        fontWeight: 700,
                      }}
                    >
                      {item}
                    </span>
                  ))}
                </div>
              </div>

              <div
                style={{
                  borderRadius: 26,
                  padding: 28,
                  background: "linear-gradient(180deg, rgba(8,17,37,0.88), rgba(8,17,37,0.72))",
                  border: "1px solid rgba(148, 163, 184, 0.18)",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center",
                  minHeight: 560,
                }}
              >
                <div style={{ display: "grid", gap: 20 }}>
                  <div style={{ display: "grid", gap: 10 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 800,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                        color: "rgba(186, 200, 220, 0.82)",
                      }}
                    >
                      Open verification
                    </div>

                    <h2
                      style={{
                        margin: 0,
                        fontSize: 30,
                        lineHeight: 1.1,
                        color: "#f8fafc",
                        fontWeight: 800,
                        letterSpacing: "-0.02em",
                      }}
                    >
                      Enter the verification token
                    </h2>

                    <p
                      style={{
                        margin: 0,
                        fontSize: 15,
                        lineHeight: 1.75,
                        color: "rgba(226, 232, 240, 0.76)",
                      }}
                    >
                      Use the token from a PROOVRA report, verification link, or shared evidence
                      record to open the verification view.
                    </p>
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gap: 14,
                      padding: 18,
                      borderRadius: 20,
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid rgba(255,255,255,0.08)",
                    }}
                  >
                    <label
                      htmlFor="verification-token"
                      style={{
                        fontSize: 13,
                        fontWeight: 700,
                        color: "rgba(226, 232, 240, 0.86)",
                      }}
                    >
                      Verification token
                    </label>

                    <input
                      id="verification-token"
                      value={token}
                      onChange={(event) => setToken(event.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="Paste token here"
                      autoComplete="off"
                      spellCheck={false}
                      style={{
                        width: "100%",
                        height: 58,
                        borderRadius: 16,
                        border: "1px solid rgba(148, 163, 184, 0.18)",
                        background: "rgba(255,255,255,0.96)",
                        color: "#0f172a",
                        padding: "0 18px",
                        fontSize: 16,
                        fontWeight: 600,
                        outline: "none",
                        boxShadow: ui.inputShadow,
                      }}
                    />

                    <Button onClick={handleVerify} disabled={!canSubmit}>
                      Open verification
                    </Button>
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gap: 12,
                      paddingTop: 6,
                    }}
                  >
                    {[
                      "Review integrity signals without changing the original record.",
                      "Inspect custody events, signing state, and timestamp-related data.",
                      "Useful for external review, legal handoff, and independent checking.",
                    ].map((item) => (
                      <div
                        key={item}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 10,
                          color: "rgba(226, 232, 240, 0.84)",
                          fontSize: 14,
                          lineHeight: 1.65,
                        }}
                      >
                        <span
                          style={{
                            width: 22,
                            height: 22,
                            borderRadius: 999,
                            display: "inline-grid",
                            placeItems: "center",
                            background: "rgba(96, 165, 250, 0.16)",
                            color: "#cfe0ff",
                            flexShrink: 0,
                            marginTop: 1,
                            fontSize: 12,
                            fontWeight: 800,
                          }}
                        >
                          ✓
                        </span>
                        <span>{item}</span>
                      </div>
                    ))}
                  </div>

                  <div
                    style={{
                      marginTop: 8,
                      borderTop: "1px solid rgba(255,255,255,0.08)",
                      paddingTop: 16,
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 12,
                      flexWrap: "wrap",
                      color: "rgba(186, 200, 220, 0.82)",
                      fontSize: 12.5,
                    }}
                  >
                    <span>Read-only verification flow</span>
                    <span>No account required for inspection</span>
                  </div>
                </div>
              </div>
            </section>
          </main>
        </div>
      </div>
    </div>
  );
}