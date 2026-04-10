"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Card,
  ListRow,
  Badge,
  useToast,
  EmptyState,
  Skeleton,
  Button,
} from "../../../components/ui";
import { useLocale } from "../../providers";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";

type ArchiveEvidenceItem = {
  id: string;
  title: string;
  type: string;
  status: string;
  createdAt: string;
  archivedAt: string | null;
  itemCount: number;
  displaySubtitle: string;
};

export default function ArchivePage() {
  const { t } = useLocale();
  const { addToast } = useToast();

  const [items, setItems] = useState<ArchiveEvidenceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isUuid = (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    );

  useEffect(() => {
    setLoading(true);
    setError(null);

    apiFetch("/v1/evidence?scope=archived")
      .then((data) => {
        setItems(data.items ?? []);
      })
      .catch((err) => {
        const errorMessage = err?.message || "Failed to load archived evidence";
        setError(errorMessage);
        setItems([]);
        captureException(err, { feature: "archive_page_list" });
        addToast(errorMessage, "error");
      })
      .finally(() => setLoading(false));
  }, [addToast]);

  const outerCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(183,157,132,0.18)",
        boxShadow:
          "0 22px 42px rgba(0,0,0,0.16), inset 0 1px 0 rgba(255,255,255,0.03)",
      }) as const,
    []
  );

  const primaryButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(158,216,207,0.14)",
        color: "#aebbb6",
        background:
          "linear-gradient(180deg, rgba(62,98,96,0.26) 0%, rgba(14,30,34,0.38) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.04), 0 14px 28px rgba(0,0,0,0.08)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
      }) as const,
    []
  );

  const rowCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(158,216,207,0.14)",
        background:
          "linear-gradient(180deg, rgba(62,98,96,0.24) 0%, rgba(14,30,34,0.36) 100%)",
        borderRadius: 24,
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.04), 0 14px 28px rgba(0,0,0,0.08)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
      }) as const,
    []
  );

  return (
    <div className="section app-section">
      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title app-page-title" style={{ marginBottom: 0 }}>
            <div style={{ maxWidth: 780 }}>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
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
                    width: 4,
                    height: 4,
                    borderRadius: 999,
                    background: "#b79d84",
                    opacity: 0.8,
                    display: "inline-block",
                  }}
                />
                Archived Evidence
              </div>

              <h1
                className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]"
                style={{ margin: "20px 0 0" }}
              >
                Previously archived{" "}
                <span style={{ color: "#c3ebe2" }}>evidence records</span>.
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
                Review evidence moved out of the active workspace while keeping its{" "}
                <span style={{ color: "#cfd8d5" }}>history</span>,{" "}
                <span style={{ color: "#bbc7c3" }}>metadata</span>, and archived state{" "}
                <span style={{ color: "#d9ccbf" }}>easy to inspect</span>.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container" style={{ display: "grid", gap: 16, paddingBottom: 72 }}>
          {loading ? (
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ ...rowCardStyle, padding: 18 }}>
                <Skeleton width="100%" height="40px" />
              </div>
              <div style={{ ...rowCardStyle, padding: 18 }}>
                <Skeleton width="100%" height="40px" />
              </div>
              <div style={{ ...rowCardStyle, padding: 18 }}>
                <Skeleton width="100%" height="40px" />
              </div>
            </div>
          ) : error ? (
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={{ ...outerCardStyle, border: "1px solid rgba(220,120,120,0.22)" }}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/site-velvet-bg.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center scale-[1.12]"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(70,20,20,0.24)_0%,rgba(20,10,10,0.58)_100%)]" />
              <div className="relative z-10 p-6 text-[#ffd7d7]">{error}</div>
            </Card>
          ) : items.length === 0 ? (
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={outerCardStyle}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/site-velvet-bg.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center scale-[1.12]"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(158,216,207,0.05),transparent_28%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_86%_18%,rgba(214,184,157,0.04),transparent_24%)]" />

              <div className="relative z-10 p-6 md:p-7">
                <EmptyState
                  title="No archived evidence"
                  subtitle="When you archive evidence, it will appear here."
                  action={() => (
                    <Link href="/home">
                      <Button
                        className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                        style={primaryButtonStyle}
                      >
                        {t("home")}
                      </Button>
                    </Link>
                  )}
                />
              </div>
            </Card>
          ) : (
            items.map((item) => (
              <Card
                key={item.id}
                className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
                style={outerCardStyle}
              >
                <div className="absolute inset-0">
                  <img
                    src="/images/site-velvet-bg.webp.png"
                    alt=""
                    className="h-full w-full object-cover object-center scale-[1.12]"
                  />
                </div>
                <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(158,216,207,0.05),transparent_28%)]" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_86%_18%,rgba(214,184,157,0.04),transparent_24%)]" />

                <div className="relative z-10 p-2">
                  {isUuid(item.id) ? (
                    <Link
                      href={`/evidence/${item.id}`}
                      style={{ display: "block", textDecoration: "none" }}
                    >
                      <div style={{ ...rowCardStyle, padding: 6 }}>
                        <ListRow
                          title={item.title || "Digital Evidence Record"}
                          subtitle={
                            item.archivedAt
                              ? `${item.displaySubtitle} • Archived ${new Date(
                                  item.archivedAt
                                ).toLocaleString()}`
                              : item.displaySubtitle
                          }
                          badge={<Badge tone="ready">Archived</Badge>}
                        />
                      </div>
                    </Link>
                  ) : (
                    <div style={{ ...rowCardStyle, padding: 6 }}>
                      <ListRow
                        title={item.title || "Digital Evidence Record"}
                        subtitle={item.displaySubtitle}
                        badge={<Badge tone="ready">Archived</Badge>}
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