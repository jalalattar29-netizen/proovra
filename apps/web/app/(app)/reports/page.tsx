"use client";

import { useEffect, useState } from "react";
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

  const secondaryActionButtonStyle = {
    borderColor: "rgba(158,216,207,0.14)",
    color: "#dbe2df",
    background:
      "linear-gradient(180deg, rgba(255,255,255,0.045) 0%, rgba(255,255,255,0.018) 100%)",
    boxShadow: "0 10px 22px rgba(0,0,0,0.12)",
  } as const;

  const primaryActionButtonStyle = {
    borderColor: "rgba(158,216,207,0.20)",
    color: "#eef4f2",
    background:
      "linear-gradient(180deg, rgba(68,114,112,0.92) 0%, rgba(29,58,61,0.96) 100%)",
    boxShadow: "0 14px 28px rgba(9,27,28,0.22)",
  } as const;

  return (
    <div className="page landing-page home-page-shell">
      <div className="relative overflow-hidden">
        <div className="absolute inset-0">
          <img
            src="/images/site-velvet-bg.webp.png"
            alt=""
            className="h-full w-full object-cover object-center"
          />
        </div>

        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,18,22,0.84)_0%,rgba(8,18,22,0.74)_38%,rgba(8,18,22,0.68)_68%,rgba(8,18,22,0.74)_100%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_16%,rgba(158,216,207,0.08),transparent_24%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_82%_24%,rgba(214,184,157,0.05),transparent_18%)]" />
        <div className="absolute inset-0 opacity-[0.035] [background:repeating-linear-gradient(0deg,rgba(255,255,255,0.024)_0px,rgba(255,255,255,0.024)_1px,transparent_1px,transparent_4px)]" />

        <div className="relative z-10">
          <section className="mx-auto max-w-7xl px-6 pb-14 pt-10 md:px-8 md:pb-16 md:pt-14">
            <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-[760px]">
                <div className="inline-flex rounded-full border border-white/10 bg-white/[0.055] px-4 py-2 text-[0.74rem] font-medium uppercase tracking-[0.2em] text-[#dce3e0] shadow-[0_10px_24px_rgba(0,0,0,0.10)] backdrop-blur-md">
                  Reports
                </div>

                <h1 className="mt-5 max-w-[700px] text-[1.62rem] font-medium leading-[1.01] tracking-[-0.04em] text-[#dbe2df] md:text-[2.18rem] lg:text-[2.7rem]">
                  Verifiable reports,{" "}
                  <span className="text-[#bfe8df]">ready for review</span>.
                </h1>

                <p className="mt-5 max-w-[690px] text-[0.94rem] font-normal leading-[1.78] tracking-[-0.006em] text-[rgba(211,223,220,0.76)] md:text-[0.98rem]">
                  Access your <span className="text-[#e7ece9]">generated evidence reports</span>,
                  review <span className="text-[#bfe8df]">verification-ready records</span>, and
                  move quickly between <span className="text-[#e6ebe8]">capture</span>,{" "}
                  <span className="text-[#d6b89d]">evidence details</span>, and signed outputs.
                </p>

                <div className="mt-6 flex flex-wrap gap-2.5">
                  <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#d7dfdb] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                    <span className="mr-2 text-[#9dd2ca]">✓</span>
                    Signed and reported records
                  </div>

                  <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#d7dfdb] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                    <span className="mr-2 text-[#9dd2ca]">✓</span>
                    Fast access to report-ready evidence
                  </div>

                  <div className="rounded-full border border-[rgba(214,184,157,0.24)] bg-[linear-gradient(180deg,rgba(183,157,132,0.08)_0%,rgba(255,255,255,0.03)_100%)] px-3.5 py-2 text-[0.78rem] font-normal text-[#e1d4c7] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                    <span className="mr-2 text-[#d6b89d]">✓</span>
                    Custody timelines preserved
                  </div>
                </div>
              </div>

              <div className="flex shrink-0">
                <Link href="/capture">
                  <Button
                    className="min-w-[190px] rounded-[999px] border px-7 py-3 text-[0.95rem] font-semibold transition-all duration-200 hover:-translate-y-[1px] hover:brightness-[1.03]"
                    style={primaryActionButtonStyle}
                  >
                    Capture Evidence
                  </Button>
                </Link>
              </div>
            </div>
          </section>

          <section className="relative px-6 pb-10 md:px-8 md:pb-12">
            <div className="mx-auto max-w-7xl">
              <div className="grid gap-5 xl:grid-cols-[1.08fr_0.92fr]">
                <Card
                  className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
                  style={{
                    border: "1px solid rgba(183,157,132,0.18)",
                    boxShadow:
                      "0 20px 38px rgba(0, 0, 0, 0.14), inset 0 1px 0 rgba(255,255,255,0.03)",
                  }}
                >
                  <div className="absolute inset-0">
                    <img
                      src="/images/site-velvet-bg.webp.png"
                      alt=""
                      className="h-full w-full object-cover object-center scale-[1.12]"
                    />
                  </div>
                  <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(7,18,22,0.72)_0%,rgba(6,16,20,0.74)_100%)]" />
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(158,216,207,0.05),transparent_28%)]" />
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_86%_18%,rgba(214,184,157,0.05),transparent_22%)]" />

                  <div className="relative z-10 p-6 md:p-7">
                    <div className="mb-5 flex items-center justify-between gap-4 flex-wrap">
                      <div className="text-[1rem] font-semibold tracking-[-0.02em] text-[#dbe2df]">
                        Available Reports
                      </div>

                      <span className="home-bronze-status">
                        {withReports.length} record{withReports.length === 1 ? "" : "s"}
                      </span>
                    </div>

                    <div style={{ display: "grid", gap: 12 }}>
                      {loading ? (
                        <div style={{ display: "grid", gap: 12 }}>
                          <div className="rounded-[22px] border border-white/6 bg-white/[0.03] p-4">
                            <Skeleton width="100%" height="20px" />
                          </div>
                          <div className="rounded-[22px] border border-white/6 bg-white/[0.03] p-4">
                            <Skeleton width="100%" height="20px" />
                          </div>
                          <div className="rounded-[22px] border border-white/6 bg-white/[0.03] p-4">
                            <Skeleton width="100%" height="20px" />
                          </div>
                        </div>
                      ) : error ? (
                        <div className="rounded-[20px] border border-[rgba(255,120,120,0.16)] bg-[rgba(120,20,20,0.12)] px-4 py-3 text-[0.92rem] text-[#ffd7d7]">
                          {error}
                        </div>
                      ) : withReports.length === 0 ? (
                        <div className="rounded-[24px] border border-white/6 bg-white/[0.03] p-4">
                          <EmptyState
                            title="No reports yet"
                            subtitle="Capture evidence and complete signing to generate verifiable reports."
                            action={() => (
                              <Link href="/capture">
                                <Button
                                  className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-medium"
                                  style={primaryActionButtonStyle}
                                >
                                  {t("ctaCapture")}
                                </Button>
                              </Link>
                            )}
                          />
                        </div>
                      ) : (
                        withReports.map((item) => {
                          const row = (
                            <div className="rounded-[24px] border border-[rgba(158,216,207,0.10)] bg-[linear-gradient(180deg,rgba(8,23,30,0.78)_0%,rgba(7,18,24,0.84)_100%)] p-1 transition-all duration-200 hover:-translate-y-[1px] hover:border-[rgba(214,184,157,0.18)] hover:shadow-[0_14px_24px_rgba(0,0,0,0.12)]">
                              <ListRow
                                title={item.title || "Digital Evidence Record"}
                                subtitle={item.displaySubtitle}
                                badge={
                                  item.status === "SIGNED" ? (
                                    <Badge tone="signed">{t("statusSigned")}</Badge>
                                  ) : (
                                    <span className="home-bronze-status">Report Ready</span>
                                  )
                                }
                              />
                            </div>
                          );

                          return isUuid(item.id) ? (
                            <Link key={item.id} href={`/evidence/${item.id}`}>
                              {row}
                            </Link>
                          ) : (
                            <div key={item.id}>{row}</div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </Card>

                <Card
                  className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
                  style={{
                    border: "1px solid rgba(183,157,132,0.18)",
                    boxShadow:
                      "0 20px 38px rgba(0, 0, 0, 0.14), inset 0 1px 0 rgba(255,255,255,0.03)",
                  }}
                >
                  <div className="absolute inset-0">
                    <img
                      src="/images/site-velvet-bg.webp.png"
                      alt=""
                      className="h-full w-full object-cover object-center scale-[1.12]"
                    />
                  </div>
                  <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(7,18,22,0.72)_0%,rgba(6,16,20,0.74)_100%)]" />
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(158,216,207,0.05),transparent_28%)]" />
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_86%_18%,rgba(214,184,157,0.05),transparent_22%)]" />

                  <div className="relative z-10 p-6 md:p-7">
                    <div className="mb-5 text-[1rem] font-semibold tracking-[-0.02em] text-[#dbe2df]">
                      Quick Actions
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Link href="/capture">
                        <Button
                          className="w-full rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium transition-all duration-200 hover:-translate-y-[1px] hover:brightness-[1.03]"
                          style={primaryActionButtonStyle}
                          onClick={() => addToast("Opening capture...", "info")}
                        >
                          New Capture
                        </Button>
                      </Link>

                      <Link href="/home">
                        <Button
                          variant="secondary"
                          className="w-full rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium transition-all duration-200 hover:-translate-y-[1px]"
                          style={secondaryActionButtonStyle}
                          onClick={() => addToast("Opening dashboard...", "info")}
                        >
                          Dashboard
                        </Button>
                      </Link>

                      <Link href="/archive">
                        <Button
                          variant="secondary"
                          className="w-full rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium transition-all duration-200 hover:-translate-y-[1px]"
                          style={secondaryActionButtonStyle}
                          onClick={() => addToast("Opening archive...", "info")}
                        >
                          Archived Evidence
                        </Button>
                      </Link>

                      <Link href="/billing">
                        <Button
                          variant="secondary"
                          className="w-full rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium transition-all duration-200 hover:-translate-y-[1px]"
                          style={secondaryActionButtonStyle}
                          onClick={() => addToast("Opening billing...", "info")}
                        >
                          Billing
                        </Button>
                      </Link>

                      <Link href="/cases">
                        <Button
                          variant="secondary"
                          className="w-full rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium transition-all duration-200 hover:-translate-y-[1px]"
                          style={secondaryActionButtonStyle}
                          onClick={() => addToast("Loading cases...", "info")}
                        >
                          View Cases
                        </Button>
                      </Link>

                      <Link href="/settings">
                        <Button
                          variant="secondary"
                          className="w-full rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium transition-all duration-200 hover:-translate-y-[1px]"
                          style={secondaryActionButtonStyle}
                          onClick={() => addToast("Opening settings...", "info")}
                        >
                          Manage Settings
                        </Button>
                      </Link>
                    </div>

                    <div
                      className="mt-5 rounded-[24px] border px-4 py-4"
                      style={{
                        border: "1px solid rgba(214,184,157,0.18)",
                        background:
                          "linear-gradient(135deg, rgba(183,157,132,0.08), rgba(158,216,207,0.05))",
                      }}
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className="flex h-10 w-10 items-center justify-center rounded-full text-[1rem] font-semibold"
                          style={{
                            background: "rgba(183,157,132,0.12)",
                            color: "#d9bea3",
                            boxShadow: "0 0 18px rgba(183,157,132,0.08)",
                          }}
                        >
                          ✓
                        </div>

                        <div>
                          <div className="font-bold text-[#dbe2df]">
                            Report-ready evidence
                          </div>
                          <div className="mt-1 text-[12px] text-[rgba(211,223,220,0.72)]">
                            Signed → Reported → Verified
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </Card>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}