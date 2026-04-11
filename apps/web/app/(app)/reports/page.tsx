"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Card,
  ListRow,
  useToast,
  EmptyState,
  Skeleton,
  Button,
} from "../../../components/ui";
import { useLocale } from "../../providers";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";

type ReportItem = {
  id: string;
  title: string;
  type: string;
  status: string;
  createdAt: string;
  itemCount: number;
  displaySubtitle: string;
};

export default function ReportsPage() {
  const { t } = useLocale();
  const { addToast } = useToast();

  const [items, setItems] = useState<ReportItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isUuid = (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    );

  useEffect(() => {
    setLoading(true);
    setError(null);

    apiFetch("/v1/evidence?scope=active")
      .then((data: { items?: ReportItem[] }) => {
        setItems(Array.isArray(data?.items) ? data.items : []);
      })
      .catch((err: Error | unknown) => {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to load reports";
        setError(errorMessage);
        setItems([]);
        captureException(err, { feature: "reports_page_list" });
        addToast(errorMessage, "error");
      })
      .finally(() => setLoading(false));
  }, [addToast]);

  const withReports = items.filter(
    (item) => item.status === "REPORTED" || item.status === "SIGNED"
  );

  const outerCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(79,112,107,0.16)",
        boxShadow:
          "0 18px 38px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.48)",
      }) as const,
    []
  );

  const heroButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(79,112,107,0.22)",
        color: "#eef3f1",
        background:
          "linear-gradient(180deg, rgba(58,92,95,0.96) 0%, rgba(20,38,42,0.98) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 34px rgba(18,40,44,0.22)",
        textShadow: "0 1px 0 rgba(0,0,0,0.22)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }) as const,
    []
  );

  const primaryButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(79,112,107,0.22)",
        color: "#eef3f1",
        background:
          "linear-gradient(180deg, rgba(58,92,95,0.96) 0%, rgba(20,38,42,0.98) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 34px rgba(18,40,44,0.22)",
        textShadow: "0 1px 0 rgba(0,0,0,0.22)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }) as const,
    []
  );

  const rowCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(79,112,107,0.10)",
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
        borderRadius: 24,
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.42), 0 12px 26px rgba(0,0,0,0.06)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }) as const,
    []
  );

const reportReadyBadgeStyle = useMemo(
  () =>
    ({
      color: "#2d5b59",
      background:
        "linear-gradient(180deg, rgba(191,232,223,0.24) 0%, rgba(255,255,255,0.56) 100%)",
      border: "1px solid rgba(79,112,107,0.14)",
      boxShadow:
        "inset 0 1px 0 rgba(255,255,255,0.56), 0 6px 14px rgba(41,83,85,0.05)",
    }) as const,
  []
);

const signedBadgeStyle = useMemo(
  () =>
    ({
      color: "#2f625d",
      background:
        "linear-gradient(180deg, rgba(213,237,230,0.88) 0%, rgba(255,255,255,0.66) 100%)",
      border: "1px solid rgba(93,148,138,0.16)",
      boxShadow:
        "inset 0 1px 0 rgba(255,255,255,0.62), 0 6px 14px rgba(41,83,85,0.05)",
    }) as const,
  []
);

  return (
    <div className="section app-section reports-page-shell">
      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title app-page-title" style={{ marginBottom: 0 }}>
            <div style={{ maxWidth: 780 }}>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.72rem",
                  borderRadius: 999,
                  border: "1px solid rgba(255,255,255,0.10)",
                  background: "rgba(255,255,255,0.04)",
                  padding: "8px 16px",
                  fontSize: "0.68rem",
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.28em",
                  color: "#afbbb7",
                  boxShadow: "0 10px 24px rgba(0,0,0,0.08)",
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: "#b79d84",
                    opacity: 0.95,
                    display: "inline-block",
                    flexShrink: 0,
                  }}
                />
                Reports
              </div>

              <h1
                className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]"
                style={{ margin: "20px 0 0" }}
              >
                Verifiable reports and{" "}
                <span style={{ color: "#c3ebe2" }}>custody timelines</span>.
              </h1>

              <p
                style={{
                  marginTop: 20,
                  maxWidth: 720,
                  fontSize: "0.95rem",
                  lineHeight: 1.8,
                  letterSpacing: "-0.006em",
                  color: "#aab5b2",
                }}
              >
                Review evidence that already has a{" "}
                <span style={{ color: "#cfd8d5" }}>generated report</span>, move
                into signed records quickly, and keep your{" "}
                <span style={{ color: "#d9ccbf" }}>verification flow</span> easy to
                scan.
              </p>
            </div>

            <div className="flex shrink-0">
              <Link href="/evidence">
                <Button
                  className="rounded-[999px] border px-6 py-3 text-[0.95rem] font-semibold"
                  style={heroButtonStyle}
                >
                  Open Evidence
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </div>

      <div
        className="app-body app-body-full pt-8 md:pt-10"
        style={{
          position: "relative",
          overflow: "hidden",
          background:
            "linear-gradient(180deg, rgba(239,241,238,0.96) 0%, rgba(234,237,234,0.98) 100%)",
        }}
      >
        <div className="pointer-events-none absolute inset-0 z-0" aria-hidden="true">
          <img
            src="/images/landing-network-bg.png"
            alt=""
            className="absolute inset-0 h-full w-full object-cover object-top opacity-[0.12] saturate-[0.55] brightness-[1.02] contrast-[0.94]"
          />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.08)_0%,rgba(255,255,255,0.03)_22%,rgba(255,255,255,0.03)_78%,rgba(255,255,255,0.08)_100%)]" />
          <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.10)_0%,rgba(255,255,255,0.03)_12%,rgba(255,255,255,0.00)_24%,rgba(255,255,255,0.00)_76%,rgba(255,255,255,0.03)_88%,rgba(255,255,255,0.10)_100%)]" />
        </div>

        <div
          className="container relative z-10"
          style={{ display: "grid", gap: 16, paddingBottom: 72 }}
        >
          {loading ? (
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ ...rowCardStyle, padding: 20 }}>
                <Skeleton width="100%" height="56px" />
              </div>
              <div style={{ ...rowCardStyle, padding: 20 }}>
                <Skeleton width="100%" height="56px" />
              </div>
              <div style={{ ...rowCardStyle, padding: 20 }}>
                <Skeleton width="100%" height="56px" />
              </div>
            </div>
          ) : error ? (
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={{ ...outerCardStyle, border: "1px solid rgba(220,120,120,0.22)" }}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,244,244,0.86)_0%,rgba(248,232,232,0.96)_100%)]" />
              <div className="relative z-10 p-6 text-[#b42318]">{error}</div>
            </Card>
          ) : withReports.length === 0 ? (
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={outerCardStyle}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.24)_0%,rgba(248,249,246,0.34)_42%,rgba(239,241,238,0.42)_100%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_12%,rgba(255,255,255,0.34),transparent_28%)] opacity-90" />

              <div className="relative z-10 p-6 md:p-7">
                <EmptyState
                  title="No reports yet"
                  subtitle="Capture evidence and complete signing to generate verifiable reports."
                  action={() => {}}
                  actionLabel=""
                />
                <div className="mt-4">
                  <Link href="/capture">
                    <Button
                      className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                      style={primaryButtonStyle}
                    >
                      {t("ctaCapture")}
                    </Button>
                  </Link>
                </div>
              </div>
            </Card>
          ) : (
            withReports.map((item) => (
              <Card
                key={item.id}
                className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
                style={outerCardStyle}
              >
                <div className="absolute inset-0">
                  <img
                    src="/images/panel-silver.webp.png"
                    alt=""
                    className="h-full w-full object-cover object-center"
                  />
                </div>
                <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.24)_0%,rgba(248,249,246,0.34)_42%,rgba(239,241,238,0.42)_100%)]" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_12%,rgba(255,255,255,0.34),transparent_28%)] opacity-90" />

                <div className="relative z-10 p-2">
                  {isUuid(item.id) ? (
                    <Link
                      href={`/evidence/${item.id}`}
                      style={{ display: "block", textDecoration: "none" }}
                    >
                      <div style={{ ...rowCardStyle, padding: 6 }}>
                        <ListRow
                          title={item.title || "Digital Evidence Record"}
                          subtitle={item.displaySubtitle}
badge={
  item.status === "SIGNED" ? (
    <span
      className="inline-flex min-h-[28px] items-center justify-center rounded-full px-3 py-[5px] text-[10.5px] font-semibold uppercase tracking-[0.12em]"
      style={signedBadgeStyle}
    >
      {t("statusSigned")}
    </span>
  ) : item.status === "REPORTED" ? (
    <span
      className="inline-flex min-h-[28px] items-center justify-center rounded-full px-3 py-[5px] text-[10.5px] font-semibold uppercase tracking-[0.12em]"
      style={reportReadyBadgeStyle}
    >
      Report Ready
    </span>
  ) : (
    <span
      className="inline-flex min-h-[28px] items-center justify-center rounded-full px-3 py-[5px] text-[10.5px] font-semibold uppercase tracking-[0.12em]"
      style={reportReadyBadgeStyle}
    >
      {t("statusReady")}
    </span>
  )
}
                        />
                      </div>
                    </Link>
                  ) : (
                    <div style={{ ...rowCardStyle, padding: 6 }}>
                      <ListRow
                        title={item.title || "Digital Evidence Record"}
                        subtitle={item.displaySubtitle}
badge={
  item.status === "SIGNED" ? (
    <span
      className="inline-flex min-h-[28px] items-center justify-center rounded-full px-3 py-[5px] text-[10.5px] font-semibold uppercase tracking-[0.12em]"
      style={signedBadgeStyle}
    >
      {t("statusSigned")}
    </span>
  ) : (
    <span
      className="inline-flex min-h-[28px] items-center justify-center rounded-full px-3 py-[5px] text-[10.5px] font-semibold uppercase tracking-[0.12em]"
      style={reportReadyBadgeStyle}
    >
      {item.status === "REPORTED" ? "Report Ready" : t("statusReady")}
    </span>
  )
}
                      />
                    </div>
                  )}
                </div>
              </Card>
            ))
          )}
        </div>
      </div>
    </div>
  );
}