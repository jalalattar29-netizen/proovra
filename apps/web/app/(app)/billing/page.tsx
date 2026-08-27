"use client";

/**
 * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the Billing page, rebuilt
 * around the billing ACCOUNT.
 *
 * What the page this replaces did
 * ---------------------------------------------------------------------------
 * It rendered nine full-width panels in one flat column, spanning every payer
 * the viewer touched at once: a four-card summary strip that summed ACROSS
 * accounts, a Teams card whose "Current usage: N of M" compared a Collaboration
 * Team membership count against the account's Owned Workspace cap, an
 * always-expanded Checkout Console with three separate workspace pickers, a
 * personal card showing storage five different ways, one card per owned
 * workspace printing internal resolver outputs ("Effective capability view",
 * "Billing ownership: Not assigned"), and a payment list merging personal and
 * workspace payments together.
 *
 * What it does now
 * ---------------------------------------------------------------------------
 * ONE account at a time, chosen in a selector that only appears when there is
 * more than one to choose. Everything below it — plan, usage, collaboration,
 * add-ons, history, actions — comes from a single account-scoped server
 * projection, so the sections cannot disagree about who is paying. Checkout is
 * a drawer that opens on intent.
 *
 * The browser renders; it does not decide. Every capability, limit, price and
 * lifecycle state on this page was resolved by the server for THIS viewer on
 * THIS account.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { PageShell, PageHeader, PageSection, Skeleton, useToast } from "../../../components/ui";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";
import { EmptyState } from "../../../components/ui/EmptyState";
import { useConfirmAction } from "../../../components/ui/ConfirmActionModal";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { captureException } from "../../../lib/sentry";
import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";
import { useTenantGuard } from "../../../lib/platform-context";
import {
  listBillingAccounts,
  readBillingAccount,
  readBillingHistory,
  requestCancellation,
  restorePurchases,
  type BillingAccountProjection,
  type BillingAccountRef,
  type BillingHistoryEntry,
} from "../../../lib/api/billing-accounts";
import { AccountSelector } from "./_sections/AccountSelector";
import {
  ActionRequiredBanner,
  CollaborationUsageCard,
  EnterpriseContractCard,
  PlanSummaryCard,
  UsageAndLimits,
} from "./_sections/PlanAndUsage";
import {
  BillingHistorySection,
  StorageAddonsSection,
} from "./_sections/StorageAndHistory";
import { CheckoutDrawer, type CheckoutIntent } from "./_sections/CheckoutDrawer";
import { formatDate } from "./_sections/format";
import { apiFetch } from "../../../lib/api";
import {
  buildBillingHref,
  parseBillingWorkspaceLocator,
  type BillingWorkspaceLocator,
} from "../../../lib/navigation/billingWorkspaceLocator";

/**
 * The URL names the selected account through the CANONICAL billing locator —
 * the same `?workspace=` vocabulary Pricing and the team pages already build
 * with `buildBillingHref`. A private `?account=` param would have been a second
 * parser for one question, which is exactly what that module exists to prevent.
 */
function toLocator(a: BillingAccountRef): BillingWorkspaceLocator {
  if (a.type === "WORKSPACE") return { kind: "team", teamId: a.id };
  if (a.type === "ORGANIZATION") return { kind: "organization", organizationId: a.id };
  return { kind: "personal" };
}

/**
 * Resolve a locator against the accounts the SERVER said this viewer may see.
 *
 * A locator naming an account that is not in that list resolves to `null` and
 * the page falls back to the first one: a URL can name a subject, but it can
 * never grant one.
 */
function accountFromLocator(
  locator: BillingWorkspaceLocator,
  accounts: BillingAccountRef[],
): BillingAccountRef | null {
  if (locator.kind === "personal") {
    return accounts.find((a) => a.type === "PERSONAL") ?? null;
  }
  if (locator.kind === "organization") {
    return (
      accounts.find(
        (a) => a.type === "ORGANIZATION" && a.id === locator.organizationId,
      ) ?? null
    );
  }
  if (!locator.teamId) return null;
  return (
    accounts.find((a) => a.type === "WORKSPACE" && a.id === locator.teamId) ?? null
  );
}

export default function BillingPage() {
  return (
    <PageRouteGate routeId="account.billing">
      <BillingPageInner />
    </PageRouteGate>
  );
}

type Phase =
  | { kind: "LOADING" }
  | { kind: "NO_ACCOUNTS" }
  | { kind: "READY" }
  | { kind: "ERROR"; title: string; message: string };

function BillingPageInner() {
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const { stamp, isStale } = useTenantGuard();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [phase, setPhase] = useState<Phase>({ kind: "LOADING" });
  const [accounts, setAccounts] = useState<BillingAccountRef[]>([]);
  const [selected, setSelected] = useState<BillingAccountRef | null>(null);
  const [projection, setProjection] = useState<BillingAccountProjection | null>(null);

  const [history, setHistory] = useState<BillingHistoryEntry[]>([]);
  const [historyState, setHistoryState] =
    useState<"LOADING" | "READY" | "DENIED" | "ERROR">("LOADING");

  const [checkout, setCheckout] = useState<CheckoutIntent | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelAddonBusy, setCancelAddonBusy] = useState<string | null>(null);
  const [recheckBusy, setRecheckBusy] = useState(false);

  const requestedLocator = useMemo(
    () => parseBillingWorkspaceLocator(searchParams),
    [searchParams],
  );

  // ---- Accounts ----------------------------------------------------------
  useEffect(() => {
    const captured = stamp();
    let cancelled = false;

    listBillingAccounts()
      .then((list) => {
        if (cancelled || isStale(captured)) return;
        setAccounts(list);
        if (list.length === 0) {
          setPhase({ kind: "NO_ACCOUNTS" });
          return;
        }
        setSelected(accountFromLocator(requestedLocator, list) ?? list[0]!);
        setPhase({ kind: "READY" });
      })
      .catch((err) => {
        if (cancelled || isStale(captured)) return;
        captureException(err, { feature: "billing_accounts" });
        const safe = toSafeUserError(err, {
          message: "Billing could not be loaded just now.",
        });
        setPhase({ kind: "ERROR", title: safe.title, message: safe.message });
      });

    return () => {
      cancelled = true;
    };
    // `requestedLocator` intentionally excluded: it seeds the INITIAL
    // selection only. Re-running on every URL change would fight the selector.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, isStale]);

  // ---- The selected account's projection ----------------------------------
  const loadProjection = useCallback(
    async (account: BillingAccountRef) => {
      const captured = stamp();
      setProjection(null);
      try {
        const next = await readBillingAccount({
          type: account.type,
          id: account.id,
        });
        if (isStale(captured)) return;
        setProjection(next);
      } catch (err) {
        if (isStale(captured)) return;
        captureException(err, { feature: "billing_account_projection" });
        const safe = toSafeUserError(err, {
          message: "This billing account could not be loaded.",
        });
        setPhase({ kind: "ERROR", title: safe.title, message: safe.message });
      }
    },
    [stamp, isStale],
  );

  const loadHistory = useCallback(
    async (account: BillingAccountRef) => {
      const captured = stamp();
      setHistoryState("LOADING");
      try {
        const items = await readBillingHistory({
          type: account.type,
          id: account.id,
        });
        if (isStale(captured)) return;
        setHistory(items);
        setHistoryState("READY");
      } catch (err) {
        if (isStale(captured)) return;
        const status = (err as { statusCode?: number })?.statusCode;
        // A missing capability is a DENIAL, never an empty list — otherwise it
        // reads as "you have no payments".
        setHistoryState(status === 403 ? "DENIED" : "ERROR");
        if (status !== 403) {
          captureException(err, { feature: "billing_account_history" });
        }
      }
    },
    [stamp, isStale],
  );

  useEffect(() => {
    if (!selected) return;
    void loadProjection(selected);
    void loadHistory(selected);
  }, [selected, loadProjection, loadHistory]);

  const selectAccount = useCallback(
    (account: BillingAccountRef) => {
      setSelected(account);
      // The ONE sanctioned builder for a billing link that names a subject.
      router.replace(buildBillingHref(toLocator(account)), { scroll: false });
    },
    [router],
  );

  const refresh = useCallback(() => {
    if (!selected) return;
    void loadProjection(selected);
    void loadHistory(selected);
  }, [selected, loadProjection, loadHistory]);

  // ---- Cancellation ------------------------------------------------------
  const handleCancel = useCallback(async () => {
    if (!selected || !projection) return;

    // The copy states what the PROVIDER will actually do. The dialog this
    // replaces promised "ends at the current period" while the route called
    // Stripe's immediate DELETE.
    const workspaceId = selected.type === "WORKSPACE" ? selected.id : null;
    const ok = await confirm({
      title: `Cancel the subscription for ${selected.displayName}?`,
      description:
        "We will ask your payment provider to stop renewing it. Where the provider supports it you keep access until the end of the period you have already paid for, and we will tell you the exact date. Nothing is charged again.",
      confirmLabel: "Cancel subscription",
      cancelLabel: "Keep subscription",
      tone: "danger",
      testId: "billing-cancel-subscription",
    });
    if (!ok) return;

    setCancelBusy(true);
    try {
      const outcome = await requestCancellation({ teamId: workspaceId });
      const ends = formatDate(outcome.accessEndsAtUtc);
      addToast(
        outcome.mode === "PERIOD_END" && ends
          ? `Cancelled. You keep access until ${ends}.`
          : "Cancelled with your payment provider.",
        "success",
      );
      refresh();
    } catch (err) {
      captureException(err, { feature: "billing_cancel" });
      const safe = toSafeUserError(err, {
        message:
          "We could not reach your payment provider. Nothing has changed — please try again shortly.",
      });
      addToast(safe.message, "error");
    } finally {
      setCancelBusy(false);
    }
  }, [selected, projection, confirm, addToast, refresh]);

  const handleCancelAddon = useCallback(
    async (addonId: string) => {
      const ok = await confirm({
        title: "Cancel this storage add-on?",
        description:
          "It stops renewing at your provider. Evidence already stored is never deleted by cancelling an add-on — but if you are over your remaining capacity you will not be able to record new evidence until you free space or add capacity back.",
        confirmLabel: "Cancel add-on",
        cancelLabel: "Keep add-on",
        tone: "danger",
        testId: "billing-cancel-addon",
      });
      if (!ok) return;

      setCancelAddonBusy(addonId);
      try {
        await apiFetch("/v1/billing/storage-addons/cancel", {
          method: "POST",
          body: JSON.stringify({ addonId }),
        });
        addToast("Storage add-on cancelled", "success");
        refresh();
      } catch (err) {
        captureException(err, { feature: "billing_cancel_addon" });
        const safe = toSafeUserError(err, {
          message: "We could not cancel that add-on. Nothing has changed.",
        });
        addToast(safe.message, "error");
      } finally {
        setCancelAddonBusy(null);
      }
    },
    [confirm, addToast, refresh],
  );

  const header = useMemo(
    () => (
      <PageHeader
        title={
          <h1 className="cc-title" data-billing-title>
            Billing
          </h1>
        }
        subtitle={
          <span className="cc-subtitle" data-billing-subtitle>
            Your plan, what you have used, and what you have paid.
          </span>
        }
        primaryAction={
          <Link href="/pricing" className="app-header-primary-action" data-billing-view-pricing>
            <span>View pricing</span>
          </Link>
        }
      />
    ),
    [],
  );

  if (phase.kind === "LOADING") {
    return (
      <PageShell data-billing-page header={header}>
        <PageSection>
          <div style={{ display: "grid", gap: 16 }}>
            <Skeleton width="100%" height="180px" />
            <Skeleton width="100%" height="160px" />
          </div>
        </PageSection>
      </PageShell>
    );
  }

  if (phase.kind === "ERROR") {
    return (
      <PageShell data-billing-page header={header}>
        <PageSection>
          <Card variant="status" tone="risk" role="alert" data-billing-error title={phase.title}>
            <p style={{ margin: 0, color: "var(--text-muted, #475569)" }}>{phase.message}</p>
            <div style={{ marginTop: 14 }}>
              <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
                Try again
              </Button>
            </div>
          </Card>
        </PageSection>
      </PageShell>
    );
  }

  if (phase.kind === "NO_ACCOUNTS" || !selected) {
    // A managed enterprise identity has no personal account and may hold no
    // billing authority anywhere. Saying so plainly beats an empty page.
    return (
      <PageShell data-billing-page header={header}>
        <PageSection>
          <div data-billing-no-accounts>
            <EmptyState
              framed
              title="Billing is managed for you"
              purpose="Your organization looks after billing for this account. Your administrator can make changes."
            />
          </div>
        </PageSection>
      </PageShell>
    );
  }

  return (
    <PageShell data-billing-page header={header}>
      {accounts.length > 1 ? (
        <PageSection>
          <AccountSelector
            accounts={accounts}
            selected={selected}
            onSelect={selectAccount}
          />
        </PageSection>
      ) : null}

      {!projection ? (
        <PageSection>
          <Skeleton width="100%" height="200px" />
        </PageSection>
      ) : (
        <>
          <PageSection>
            <ActionRequiredBanner projection={projection} />
          </PageSection>

          <PageSection>
            <PlanSummaryCard
              projection={projection}
              onManage={() => setCheckout("PLAN")}
              onCancel={() => void handleCancel()}
              cancelBusy={cancelBusy}
            />
          </PageSection>

          <PageSection>
            <UsageAndLimits projection={projection} />
          </PageSection>

          {projection.actions.canBuyEvidenceCredits ? (
            <PageSection>
              <Card
                variant="summary"
                title="Evidence credits"
                subtitle="Record more evidence without changing your plan. Credits do not expire."
                headerAction={
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setCheckout("CREDITS")}
                    data-billing-buy-credits
                  >
                    Buy credits
                  </Button>
                }
                data-billing-credits
              >
                <div style={{ fontSize: "0.95rem", color: "var(--text-strong, #172033)" }}>
                  {projection.wallet?.availableCredits ?? 0} available
                </div>
                {projection.wallet?.hasLedgerHistory ? (
                  <div
                    style={{
                      marginTop: 4,
                      fontSize: "0.85rem",
                      color: "var(--text-muted, #5F6878)",
                    }}
                  >
                    {projection.wallet.purchasedCredits} purchased ·{" "}
                    {projection.wallet.consumedCredits} used
                  </div>
                ) : null}
              </Card>
            </PageSection>
          ) : null}

          <PageSection>
            <CollaborationUsageCard projection={projection} />
          </PageSection>

          <PageSection>
            <StorageAddonsSection
              projection={projection}
              onBuy={() => setCheckout("STORAGE")}
              onCancelAddon={(id) => void handleCancelAddon(id)}
              cancelBusyId={cancelAddonBusy}
            />
          </PageSection>

          <PageSection>
            <BillingHistorySection
              entries={history}
              state={historyState}
              onRetry={() => selected && void loadHistory(selected)}
              recheckBusy={recheckBusy}
              onRecheck={() => {
                void (async () => {
                  setRecheckBusy(true);
                  try {
                    await restorePurchases();
                    addToast("Checked with your payment provider.", "success");
                    refresh();
                  } catch (err) {
                    captureException(err, { feature: "billing_restore" });
                    const safe = toSafeUserError(err, {
                      message:
                        "Your purchases could not be re-checked. Try again in a moment.",
                    });
                    addToast(safe.message, "error");
                  } finally {
                    setRecheckBusy(false);
                  }
                })();
              }}
            />
          </PageSection>

          <PageSection>
            <EnterpriseContractCard projection={projection} />
          </PageSection>

          <PageSection>
            <Card variant="admin" data-billing-support>
              <p
                style={{
                  margin: 0,
                  fontSize: "0.9rem",
                  lineHeight: 1.65,
                  color: "var(--text-muted, #475569)",
                }}
              >
                {projection.actions.contactAccountManager
                  ? "Changes to your agreement go through your account manager."
                  : "Something not right on this page? Your billing records are the ones we act on — get in touch and we will look at them with you."}
              </p>
              <div style={{ marginTop: 12 }}>
                <Link
                  href={
                    projection.actions.contactAccountManager
                      ? "/contact-sales"
                      : "/settings#privacy"
                  }
                  className="app-header-primary-action"
                  data-billing-support-action
                >
                  <span>
                    {projection.actions.contactAccountManager
                      ? "Contact your account manager"
                      : "Get help"}
                  </span>
                </Link>
              </div>
            </Card>
          </PageSection>

          <CheckoutDrawer
            open={checkout !== null}
            intent={checkout ?? "PLAN"}
            projection={projection}
            onClose={() => setCheckout(null)}
            onCompleted={refresh}
            onError={(title, message) => addToast(`${title}: ${message}`, "error")}
          />
        </>
      )}
    </PageShell>
  );
}
