"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Card,
  ListRow,
  useToast,
  EmptyState,
  Skeleton,
} from "../../../components/ui";
import { useLocale } from "../../providers";
import { MarketingHeader } from "../../../components/header";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";

type HomeEvidenceItem = {
  id: string;
  title: string;
  type: string;
  status: string;
  createdAt: string;
  itemCount: number;
  displaySubtitle: string;
};

export default function HomePage() {
  const { t } = useLocale();
  const { addToast } = useToast();

  const [items, setItems] = useState<HomeEvidenceItem[]>([]);
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
      .then((data) => {
        setItems(data.items ?? []);
      })
      .catch((err) => {
        const errorMessage = err?.message || "Failed to load evidence";
        setError(errorMessage);
        captureException(err, { feature: "home_page_evidence_list" });
        addToast(errorMessage, "error");
      })
      .finally(() => setLoading(false));
  }, [addToast]);

  return (
    <div className="page landing-page">
      <div className="relative overflow-hidden">
        <div className="absolute inset-0">
          <img
            src="/images/site-velvet-bg.webp.png"
            alt=""
            className="h-full w-full object-cover object-center"
          />
        </div>

        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,18,22,0.84)_0%,rgba(8,18,22,0.74)_38%,rgba(8,18,22,0.68)_68%,rgba(8,18,22,0.74)_100%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_16%,rgba(158,216,207,0.09),transparent_24%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_82%_24%,rgba(214,184,157,0.06),transparent_18%)]" />
        <div className="absolute inset-0 opacity-[0.04] [background:repeating-linear-gradient(0deg,rgba(255,255,255,0.026)_0px,rgba(255,255,255,0.026)_1px,transparent_1px,transparent_4px)]" />

        <div className="relative z-10">
          <MarketingHeader />

          <section className="mx-auto max-w-7xl px-6 pb-14 pt-10 md:px-8 md:pb-16 md:pt-14">
            <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-[760px]">
                <div className="inline-flex rounded-full border border-white/10 bg-white/[0.055] px-4 py-2 text-[0.74rem] font-medium uppercase tracking-[0.2em] text-[#dce3e0] shadow-[0_10px_24px_rgba(0,0,0,0.10)] backdrop-blur-md">
                  Dashboard
                </div>

                <h1 className="mt-5 max-w-[700px] text-[1.62rem] font-medium leading-[1.01] tracking-[-0.04em] text-[#edf1ef] md:text-[2.18rem] lg:text-[2.7rem]">
                  Your evidence workspace,{" "}
                  <span className="text-[#bfe8df]">ready for action</span>.
                </h1>

                <p className="mt-5 max-w-[690px] text-[0.94rem] font-normal leading-[1.78] tracking-[-0.006em] text-[#c7cfcc] md:text-[0.98rem]">
                  Review your <span className="text-[#e7ece9]">latest evidence</span>, continue active{" "}
                  <span className="text-[#bfe8df]">verification workflows</span>, and move quickly between{" "}
                  <span className="text-[#e6ebe8]">capture</span>,{" "}
                  <span className="text-[#d6b89d]">reports</span>, and custody-ready records.
                </p>

                <div className="mt-6 flex flex-wrap gap-2.5">
                  <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#d7dfdb] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                    <span className="mr-2 text-[#9dd2ca]">✓</span>
                    Active evidence at a glance
                  </div>

                  <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#d7dfdb] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                    <span className="mr-2 text-[#9dd2ca]">✓</span>
                    Fast access to core workflows
                  </div>

                  <div className="rounded-full border border-[rgba(214,184,157,0.24)] bg-[linear-gradient(180deg,rgba(183,157,132,0.08)_0%,rgba(255,255,255,0.03)_100%)] px-3.5 py-2 text-[0.78rem] font-normal text-[#e1d4c7] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                    <span className="mr-2 text-[#d6b89d]">✓</span>
                    Trusted custody status visible
                  </div>
                </div>
              </div>

              <div className="flex shrink-0">
                <Link href="/capture">
                  <Button
                    className="rounded-[16px] border px-6 py-3 text-[0.95rem] font-medium shadow-[0_12px_26px_rgba(0,0,0,0.10)] transition-all duration-200 hover:-translate-y-[1px]"
                    style={{
                      borderColor: "rgba(158,216,207,0.22)",
                      color: "#214648",
                      background:
                        "linear-gradient(180deg, rgba(191,232,223,0.22) 0%, rgba(255,255,255,0.52) 100%)",
                    }}
                  >
                    {t("ctaCapture")}
                  </Button>
                </Link>
              </div>
            </div>
          </section>

          <section className="relative px-6 pb-14 md:px-8 md:pb-16">
            <div className="mx-auto max-w-7xl">
              <div className="grid gap-5 xl:grid-cols-[1.08fr_0.92fr]">
                <Card
                  className="relative overflow-hidden rounded-[28px] border bg-transparent p-0 shadow-none"
                  style={{
                    border: "1px solid rgba(255,255,255,0.42)",
                    boxShadow: "0 16px 32px rgba(0, 0, 0, 0.07), inset 0 1px 0 rgba(255,255,255,0.45)",
                  }}
                >
                  <div className="absolute inset-0">
                    <img
                      src="/images/panel-silver.webp.png"
                      alt=""
                      className="h-full w-full object-cover object-center"
                    />
                  </div>

                  <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.12)_0%,rgba(255,255,255,0.18)_100%)]" />

                  <div className="relative z-10 p-6 md:p-7">
                    <div className="mb-5 text-[1rem] font-semibold tracking-[-0.02em] text-[#23373b]">
                      {t("recentEvidence")}
                    </div>

                    <div style={{ display: "grid", gap: 12 }}>
                      {loading ? (
                        <div style={{ display: "grid", gap: 12 }}>
                          <div className="rounded-[22px] border border-[rgba(36,55,59,0.08)] bg-[rgba(255,255,255,0.36)] p-4">
                            <Skeleton width="100%" height="20px" />
                          </div>
                          <div className="rounded-[22px] border border-[rgba(36,55,59,0.08)] bg-[rgba(255,255,255,0.36)] p-4">
                            <Skeleton width="100%" height="20px" />
                          </div>
                          <div className="rounded-[22px] border border-[rgba(36,55,59,0.08)] bg-[rgba(255,255,255,0.36)] p-4">
                            <Skeleton width="100%" height="20px" />
                          </div>
                        </div>
                      ) : error ? (
                        <div className="rounded-[20px] border border-[rgba(180,35,24,0.12)] bg-[rgba(255,255,255,0.52)] px-4 py-3 text-[0.92rem] text-[#b42318]">
                          {error}
                        </div>
                      ) : items.length === 0 ? (
                        <div className="rounded-[24px] border border-[rgba(36,55,59,0.08)] bg-[rgba(255,255,255,0.34)] p-4">
                          <EmptyState
                            title="No evidence yet"
                            subtitle="Capture your first file to see it here."
                            action={() => (
                              <Link href="/capture">
                                <Button
                                  className="rounded-[14px] border px-5 py-3 text-[0.92rem] font-medium"
                                  style={{
                                    borderColor: "rgba(158,216,207,0.22)",
                                    color: "#214648",
                                    background:
                                      "linear-gradient(180deg, rgba(191,232,223,0.22) 0%, rgba(255,255,255,0.52) 100%)",
                                  }}
                                >
                                  {t("ctaCapture")}
                                </Button>
                              </Link>
                            )}
                          />
                        </div>
                      ) : (
                        items.map((item) => {
                          const row = (
                            <div className="rounded-[22px] border border-[rgba(36,55,59,0.08)] bg-[linear-gradient(180deg,rgba(255,255,255,0.54)_0%,rgba(244,246,244,0.84)_100%)] p-1 transition-all duration-200 hover:-translate-y-[1px] hover:border-[rgba(183,157,132,0.18)] hover:shadow-[0_14px_24px_rgba(0,0,0,0.05)]">
                              <ListRow
                                title={item.title || "Digital Evidence Record"}
                                subtitle={item.displaySubtitle}
                                badge={
                                  item.status === "SIGNED" ? (
                                    <Badge tone="signed">{t("statusSigned")}</Badge>
                                  ) : item.status === "PROCESSING" ? (
                                    <Badge tone="processing">{t("statusProcessing")}</Badge>
                                  ) : (
                                    <Badge tone="ready">{t("statusReady")}</Badge>
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
                  className="relative overflow-hidden rounded-[28px] border bg-transparent p-0 shadow-none"
                  style={{
                    border: "1px solid rgba(255,255,255,0.42)",
                    boxShadow: "0 16px 32px rgba(0, 0, 0, 0.07), inset 0 1px 0 rgba(255,255,255,0.45)",
                  }}
                >
                  <div className="absolute inset-0">
                    <img
                      src="/images/panel-silver.webp.png"
                      alt=""
                      className="h-full w-full object-cover object-center"
                    />
                  </div>

                  <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.12)_0%,rgba(255,255,255,0.18)_100%)]" />

                  <div className="relative z-10 p-6 md:p-7">
                    <div className="mb-5 text-[1rem] font-semibold tracking-[-0.02em] text-[#23373b]">
                      Quick Actions
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Link href="/capture">
                        <Button
                          className="w-full rounded-[18px] border px-5 py-3 text-[0.95rem] font-medium transition-all duration-200 hover:-translate-y-[1px]"
                          style={{
                            borderColor: "rgba(158,216,207,0.22)",
                            color: "#214648",
                            background:
                              "linear-gradient(180deg, rgba(191,232,223,0.22) 0%, rgba(255,255,255,0.52) 100%)",
                          }}
                          onClick={() => addToast("Opening capture...", "info")}
                        >
                          New Capture
                        </Button>
                      </Link>

                      <Link href="/cases">
                        <Button
                          variant="secondary"
                          className="w-full rounded-[18px] border px-5 py-3 text-[0.95rem] font-medium transition-all duration-200 hover:-translate-y-[1px]"
                          style={{
                            borderColor: "rgba(36,55,59,0.10)",
                            color: "#2a3b40",
                            background:
                              "linear-gradient(180deg, rgba(255,255,255,0.54) 0%, rgba(244,246,244,0.84) 100%)",
                          }}
                          onClick={() => addToast("Loading cases...", "info")}
                        >
                          View Cases
                        </Button>
                      </Link>

                      <Link href="/archive">
                        <Button
                          variant="secondary"
                          className="w-full rounded-[18px] border px-5 py-3 text-[0.95rem] font-medium transition-all duration-200 hover:-translate-y-[1px]"
                          style={{
                            borderColor: "rgba(36,55,59,0.10)",
                            color: "#2a3b40",
                            background:
                              "linear-gradient(180deg, rgba(255,255,255,0.54) 0%, rgba(244,246,244,0.84) 100%)",
                          }}
                          onClick={() => addToast("Opening archive...", "info")}
                        >
                          Archived Evidence
                        </Button>
                      </Link>

                      <Link href="/deleted">
                        <Button
                          variant="secondary"
                          className="w-full rounded-[18px] border px-5 py-3 text-[0.95rem] font-medium transition-all duration-200 hover:-translate-y-[1px]"
                          style={{
                            borderColor: "rgba(36,55,59,0.10)",
                            color: "#2a3b40",
                            background:
                              "linear-gradient(180deg, rgba(255,255,255,0.54) 0%, rgba(244,246,244,0.84) 100%)",
                          }}
                          onClick={() => addToast("Opening deleted evidence...", "info")}
                        >
                          Deleted Evidence
                        </Button>
                      </Link>

                      <Link href="/locked">
                        <Button
                          variant="secondary"
                          className="w-full rounded-[18px] border px-5 py-3 text-[0.95rem] font-medium transition-all duration-200 hover:-translate-y-[1px]"
                          style={{
                            borderColor: "rgba(36,55,59,0.10)",
                            color: "#2a3b40",
                            background:
                              "linear-gradient(180deg, rgba(255,255,255,0.54) 0%, rgba(244,246,244,0.84) 100%)",
                          }}
                          onClick={() => addToast("Opening locked evidence...", "info")}
                        >
                          Locked Evidence
                        </Button>
                      </Link>

                      <Link href="/settings">
                        <Button
                          variant="secondary"
                          className="w-full rounded-[18px] border px-5 py-3 text-[0.95rem] font-medium transition-all duration-200 hover:-translate-y-[1px]"
                          style={{
                            borderColor: "rgba(36,55,59,0.10)",
                            color: "#2a3b40",
                            background:
                              "linear-gradient(180deg, rgba(255,255,255,0.54) 0%, rgba(244,246,244,0.84) 100%)",
                          }}
                          onClick={() => addToast("Opening settings...", "info")}
                        >
                          Manage Settings
                        </Button>
                      </Link>
                    </div>

                    <div
                      className="mt-5 rounded-[22px] border px-4 py-4"
                      style={{
                        border: "1px solid rgba(214,184,157,0.20)",
                        background:
                          "linear-gradient(180deg, rgba(214,184,157,0.16) 0%, rgba(255,255,255,0.52) 100%)",
                      }}
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className="flex h-10 w-10 items-center justify-center rounded-full text-[1rem] font-semibold"
                          style={{
                            background: "rgba(214,184,157,0.16)",
                            color: "#8f7257",
                          }}
                        >
                          ✓
                        </div>

                        <div>
                          <div className="font-bold text-[#23373b]">
                            Trusted chain of custody
                          </div>
                          <div className="mt-1 text-[12px] text-[#667174]">
                            Capture → Sign → Report → Share
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