"use client";

/**
 * What survives here: the ACTION-REQUIRED banner and the Enterprise contract
 * card.
 *
 * BILLING REDESIGN (2026-08-30) — the plan summary, the three usage meters and
 * the collaboration card were DELETED from this file, not moved: they were
 * four full-width panels answering one question between them, and they are now
 * one `BillingOverview` surface plus two compact panels beside it. Their
 * former contents — a card whose right half was empty, a usage row whose
 * Evidence column carried a paragraph while its neighbours carried a line, and
 * a page-wide card holding "0 of 2" — are what made the page a column of
 * near-identical rectangles.
 *
 * What was already removed from the surface these replaced, and why:
 *   * "Workspace plan view" / "Effective capability view" / "Billing status" —
 *     three internal resolver outputs printed as customer copy.
 *   * "Billing ownership: Assigned / Not assigned" — a nullable foreign key
 *     rendered as prose, for a field that authorized nothing.
 *   * "Workspace health: Near limit: No / Limit reached: No" — two booleans a
 *     customer cannot act on.
 *   * "Projects" — a metric PROOVRA has no concept of.
 */

import { Button } from "../../../../components/ui/Button";
import { Card } from "../../../../components/ui/Card";
import type { BillingAccountProjection } from "../../../../lib/api/billing-accounts";
import { formatDate } from "./format";

export function ActionRequiredBanner({
  projection,
  onRetryStorageCancellation,
  retryBusy = false,
}: {
  projection: BillingAccountProjection;
  /**
   * BILLING DEPENDENT-CANCELLATION CONVERGENCE (2026-08-27) — retry the
   * outstanding storage add-on cancellations.
   *
   * Passed in rather than derived here: whether there is anything to retry is
   * the server's `dependentStorageCancellation`, and what pressing it does is
   * the page's. This component renders a decision, as it already did for the
   * banner itself.
   */
  onRetryStorageCancellation?: () => void;
  retryBusy?: boolean;
}) {
  const banner = projection.actionRequired;
  const outstanding = projection.dependentStorageCancellation;
  if (!banner) return null;

  return (
    <Card
      variant="status"
      tone={banner.severity === "CRITICAL" ? "risk" : "pending"}
      role="alert"
      data-billing-action-required
      title={banner.title}
    >
      <div style={{ display: "grid", gap: 6 }}>
        {banner.messages.map((m) => (
          <p
            key={m}
            style={{
              margin: 0,
              fontSize: "0.9rem",
              lineHeight: 1.65,
              color: "var(--text-muted, #475569)",
            }}
          >
            {m}
          </p>
        ))}
      </div>
      {banner.reassurance ? (
        <p
          style={{
            margin: "12px 0 0",
            fontSize: "0.85rem",
            color: "var(--text-muted, #5F6878)",
          }}
        >
          {banner.reassurance}
        </p>
      ) : null}

      {outstanding && outstanding.actionAvailable && onRetryStorageCancellation ? (
        <div
          style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap" }}
          data-billing-addon-retry
        >
          <Button
            variant="secondary"
            size="sm"
            onClick={onRetryStorageCancellation}
            loading={retryBusy}
            disabled={retryBusy}
            data-billing-addon-retry-action
          >
            Retry stopping storage add-ons
          </Button>
          {outstanding.supportRequired ? (
            // MANUAL_INTERVENTION. The automatic retries are spent and the
            // add-on may still be charging, so the customer is given a real
            // next step rather than being asked to keep pressing a button.
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                window.location.href = "/settings/support";
              }}
              data-billing-addon-support
            >
              Contact support
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}


export function EnterpriseContractCard({
  projection,
}: {
  projection: BillingAccountProjection;
}) {
  const contract = projection.contract;
  if (!contract) return null;

  const rows: Array<[string, string]> = [];
  const effective = formatDate(contract.effectiveAtUtc);
  const ends = formatDate(contract.endsAtUtc);
  if (effective) rows.push(["Effective from", effective]);
  if (ends) rows.push(["Term ends", ends]);
  if (contract.seatCount !== null) {
    rows.push(["Contracted seats", String(contract.seatCount)]);
  }
  if (contract.storageGb !== null) {
    rows.push(["Contracted storage", `${contract.storageGb} GB`]);
  }
  if (contract.region) rows.push(["Region", contract.region]);

  return (
    <Card variant="summary" title="Agreement" data-billing-contract>
      {contract.derivedFromLegacyFallback ? (
        // Honest rather than confident: this projection was derived, not read
        // from a contract record, so no number here is published as a term.
        <p
          style={{
            margin: "0 0 12px",
            fontSize: "0.9rem",
            lineHeight: 1.65,
            color: "var(--text-muted, #475569)",
          }}
          data-billing-contract-legacy
        >
          We do not have your full agreement on file here. Your account manager
          holds the authoritative terms.
        </p>
      ) : null}

      {rows.length > 0 ? (
        <dl
          style={{
            display: "grid",
            gap: 10,
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            margin: 0,
          }}
        >
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: "var(--text-muted, #5F6878)",
                }}
              >
                {label}
              </dt>
              <dd
                style={{
                  margin: "4px 0 0",
                  fontSize: "0.95rem",
                  color: "var(--text-strong, #172033)",
                }}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </Card>
  );
}
