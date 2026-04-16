"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Button, useToast, Skeleton } from "../../../components/ui";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";
import { PersonalWorkspaceCard } from "../../../components/billing/PersonalWorkspaceCard";
import { TeamWorkspaceCard } from "../../../components/billing/TeamWorkspaceCard";
import { CheckoutPanel } from "../../../components/billing/CheckoutPanel";
import { BillingHistoryCard } from "../../../components/billing/BillingHistoryCard";
import { StorageAddonsPanel } from "../../../components/billing/StorageAddonsPanel";
import type {
  BillingOverviewResponse,
  PersonalWorkspaceSummary,
  TeamWorkspaceSummary,
  BillingPaymentSummary,
  CheckoutPlan,
  CheckoutTargetType,
  WorkspaceStorageAddonSummary,
} from "../../../components/billing/types";

function readInitialWorkspace(value: string | null): CheckoutTargetType {
  return value?.toLowerCase() === "team" ? "TEAM" : "PERSONAL";
}

function readInitialPlan(value: string | null): CheckoutPlan | null {
  if (value === "PAYG" || value === "PRO" || value === "TEAM") return value;
  return null;
}

function readStorageAddons(
  data: BillingOverviewResponse
): WorkspaceStorageAddonSummary[] {
  const raw = (data as BillingOverviewResponse & {
    storageAddons?:
      | WorkspaceStorageAddonSummary[]
      | {
          all?: WorkspaceStorageAddonSummary[];
          personal?: WorkspaceStorageAddonSummary[];
          teams?: WorkspaceStorageAddonSummary[];
        }
      | null;
  }).storageAddons;

  if (Array.isArray(raw)) {
    return raw;
  }

  if (raw && Array.isArray(raw.all)) {
    return raw.all;
  }

  const personal = raw?.personal ?? [];
  const teams = raw?.teams ?? [];
  return [...personal, ...teams];
}

export default function BillingPage() {
  const { addToast } = useToast();
  const searchParams = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [personal, setPersonal] = useState<PersonalWorkspaceSummary | null>(null);
  const [teams, setTeams] = useState<TeamWorkspaceSummary[]>([]);
  const [payments, setPayments] = useState<BillingPaymentSummary[]>([]);
  const [storageAddons, setStorageAddons] = useState<WorkspaceStorageAddonSummary[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");

  const [cancelBusyTeamId, setCancelBusyTeamId] = useState<string | null>(null);

  const initialTargetType = useMemo(
    () => readInitialWorkspace(searchParams.get("workspace")),
    [searchParams]
  );

  const initialPlan = useMemo(() => {
    const target = readInitialWorkspace(searchParams.get("workspace"));
    const plan = readInitialPlan(searchParams.get("plan"));

    if (target === "TEAM") return "TEAM" satisfies CheckoutPlan;
    return plan ?? "PAYG";
  }, [searchParams]);

  const loadOverview = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const data = (await apiFetch("/v1/billing/overview")) as BillingOverviewResponse;

      const nextPersonal = data?.workspaces?.personal ?? null;
      const nextTeams = Array.isArray(data?.workspaces?.teams)
        ? data.workspaces.teams
        : [];
      const nextPayments = Array.isArray(data?.payments) ? data.payments : [];
      const nextStorageAddons = readStorageAddons(data);

      setPersonal(nextPersonal);
      setTeams(nextTeams);
      setPayments(nextPayments);
      setStorageAddons(nextStorageAddons);

      setSelectedTeamId((current) => {
        const queryTeamId = searchParams.get("team");
        if (queryTeamId && nextTeams.some((team) => team.id === queryTeamId)) {
          return queryTeamId;
        }

        if (!nextTeams.length) return "";
        if (current && nextTeams.some((team) => team.id === current)) {
          return current;
        }
        return nextTeams[0]?.id ?? "";
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load billing overview";
      setError(message);
      captureException(err, { feature: "billing_overview_page" });
    } finally {
      setLoading(false);
    }
  }, [searchParams]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const handleSelectTeamForCheckout = useCallback((teamId: string) => {
    setSelectedTeamId(teamId);
    try {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      window.scrollTo(0, 0);
    }
  }, []);

  const handleCancelSubscription = useCallback(
    async (teamId: string) => {
      try {
        setCancelBusyTeamId(teamId);
        addToast("Cancelling team subscription...", "info");

        await apiFetch("/v1/billing/subscription/cancel", {
          method: "POST",
          body: JSON.stringify({ teamId }),
        });

        addToast("Team subscription cancelled", "success");
        await loadOverview();
      } catch (err) {
        captureException(err, {
          feature: "billing_cancel_team_subscription",
          teamId,
        });
        const message =
          err instanceof Error ? err.message : "Failed to cancel team subscription";
        addToast(message, "error");
      } finally {
        setCancelBusyTeamId(null);
      }
    },
    [addToast, loadOverview]
  );

  const headerButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(58,92,95,0.55)",
        color: "#e6f1ee",
        background:
          "linear-gradient(180deg, rgba(44,74,72,0.95) 0%, rgba(20,38,42,0.98) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 34px rgba(12,30,32,0.35)",
      }) as const,
    []
  );

  const summaryCards = useMemo(() => {
    const personalPlan = personal?.plan ?? "FREE";
    const totalTeams = teams.length;
    const totalPayments = payments.length;
    const activeAddons = storageAddons.filter((item) =>
      ["ACTIVE", "PENDING", "PAST_DUE"].includes(String(item.status ?? "").toUpperCase())
    ).length;

    return [
      {
        label: "Personal plan",
        value: personalPlan,
      },
      {
        label: "Team workspaces",
        value: String(totalTeams),
      },
      {
        label: "Payments",
        value: String(totalPayments),
      },
      {
        label: "Storage add-ons",
        value: String(activeAddons),
      },
    ];
  }, [personal, teams, payments, storageAddons]);

  return (
    <div className="section app-section billing-page-shell">
      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title app-page-title" style={{ marginBottom: 0 }}>
            <div style={{ maxWidth: 820 }}>
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
                Billing Console
              </div>

              <h1
                className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]"
                style={{ margin: "20px 0 0" }}
              >
                Manage personal and team billing
                <span style={{ color: "#c3ebe2" }}>
                  {" "}
                  from one workspace console
                </span>
                .
              </h1>

              <p
                style={{
                  marginTop: 14,
                  color: "#afbbb7",
                  fontSize: 15,
                  lineHeight: 1.8,
                  maxWidth: 760,
                }}
              >
                Review storage, seats, subscriptions, add-ons, and payment
                history in one place. Start checkout for one-time credits or
                recurring plans without leaving the workspace context.
              </p>
            </div>

            <div>
              <Link href="/pricing">
                <Button
                  className="app-responsive-btn min-w-[220px] rounded-[999px] border px-6 py-3 text-[0.92rem] font-semibold"
                  style={headerButtonStyle}
                >
                  View pricing
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </div>

      <div
        className="app-body app-body-full"
        style={{
          position: "relative",
          overflow: "hidden",
          background:
            "linear-gradient(180deg, rgba(239,241,238,0.96) 0%, rgba(234,237,234,0.98) 100%)",
          paddingTop: 40,
        }}
      >
        <div
          className="container relative z-10"
          style={{
            display: "grid",
            gap: 24,
            paddingBottom: 72,
          }}
        >
          {loading ? (
            <div style={{ display: "grid", gap: 16 }}>
              <Skeleton width="100%" height="220px" />
              <Skeleton width="100%" height="220px" />
              <Skeleton width="100%" height="220px" />
            </div>
          ) : error ? (
            <div
              className="rounded-[20px] border px-4 py-4 text-[0.95rem]"
              style={{
                border: "1px solid rgba(194,78,78,0.18)",
                background: "rgba(164,84,84,0.10)",
                color: "#9f3535",
              }}
            >
              {error}
            </div>
          ) : (
            <>
              <div
                style={{
                  display: "grid",
                  gap: 12,
                  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                }}
              >
                {summaryCards.map((item) => (
                  <div
                    key={item.label}
                    className="rounded-[20px] border px-4 py-4"
                    style={{
                      border: "1px solid rgba(79,112,107,0.12)",
                      background:
                        "linear-gradient(180deg, rgba(255,255,255,0.66) 0%, rgba(243,245,242,0.94) 100%)",
                    }}
                  >
                    <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#9b826b]">
                      {item.label}
                    </div>
                    <div className="mt-2 text-[1rem] font-semibold text-[#21353a]">
                      {item.value}
                    </div>
                  </div>
                ))}
              </div>

              <CheckoutPanel
                key={`${initialTargetType}-${initialPlan}-${selectedTeamId || "no-team-selected"}`}
                personal={personal}
                teams={teams}
                initialSelectedTeamId={selectedTeamId}
                initialTargetType={initialTargetType}
                initialPlan={initialPlan}
                onCheckoutCompleted={loadOverview}
              />

              <PersonalWorkspaceCard workspace={personal} />

              {teams.length > 0 ? (
                <div style={{ display: "grid", gap: 20 }}>
                  {teams.map((team) => (
                    <TeamWorkspaceCard
                      key={team.id}
                      workspace={team}
                      onSelectForCheckout={handleSelectTeamForCheckout}
                      onCancelSubscription={handleCancelSubscription}
                      busy={cancelBusyTeamId === team.id}
                    />
                  ))}
                </div>
              ) : (
                <div
                  className="rounded-[20px] border px-4 py-4 text-[0.95rem]"
                  style={{
                    border: "1px solid rgba(79,112,107,0.12)",
                    background:
                      "linear-gradient(180deg, rgba(255,255,255,0.66) 0%, rgba(243,245,242,0.94) 100%)",
                    color: "#5d6d71",
                  }}
                >
                  No team workspaces found yet. Create a team workspace before
                  starting a TEAM checkout flow.
                </div>
              )}

              <StorageAddonsPanel items={storageAddons} />

              <BillingHistoryCard items={payments} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}