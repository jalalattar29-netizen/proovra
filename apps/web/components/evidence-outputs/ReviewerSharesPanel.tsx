"use client";

/**
 * SECURE REVIEWER SHARES — the owner's controls for `pvs_` OWNER_SHARE links
 * (ET-PKG-07; disclosure model 2026-10-18).
 *
 * Every finalized record already has its permanent verification page
 * (ManageVerificationPagePanel) — it needs no share from here. A reviewer
 * share is the separate feature: a link for one named reviewer, with an
 * expiry, a use limit and revocation, disclosing what ITS OWN profile allows:
 *
 *   Content preview    (STANDARD) — optionally with an explicit grant to
 *                      download the original files (step-up required);
 *   Verification only  (BASIC)    — the verification result alone.
 *
 * It is an opaque token, never the record's id:
 *
 *   create   name the reviewer, choose expiry / use limit / profile, get it ONCE
 *   copy     only at creation or rotation — the server keeps a hash, not the link
 *   revoke   one share; every other reviewer keeps theirs
 *   rotate   replace one share; the old one stops at once
 *   view     every share with its state and whether it answers right now
 *            (the SERVER's `usable` / `inactiveReason`, never derived here)
 *   legacy   the old record-id link, when the record has one, with its end date
 *
 * Creating a share never publishes anything and never changes what the
 * verification page itself discloses.
 */
import Link from "next/link";
import { Ban, CheckCircle2, Clock, Download, PauseCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { AppListbox, AppStatusBadge, type AppTone } from "../app-primitives";
import { StepUpModal, useStepUpAction } from "../identity-security/StepUpModal";
import { useToast } from "../ui";
import { useConfirmAction } from "../ui/ConfirmActionModal";
import { notifyApiError } from "../../lib/feedback/notify";
import { formatUserDate, formatUserDateTime } from "../../lib/date";
import {
  absoluteVerifyUrl,
  createVerificationLink,
  evidenceVerificationPageHref,
  legacyVerifyLinkInventory,
  listVerificationLinks,
  revokeLegacyVerifyLink,
  revokeVerificationLink,
  renewVerificationLink,
  rotateVerificationLink,
  type CreatedVerificationLink,
  type LegacyVerifyLinkInventory,
  type VerificationLink,
  type VerificationLinkListing,
  type VerificationLinkState,
} from "../../lib/api/verification-links";

const STATE_LABEL: Record<VerificationLinkState, string> = {
  ACTIVE: "Active",
  EXPIRED: "Expired",
  REVOKED: "Revoked",
  EXHAUSTED: "Use limit reached",
};
const STATE_ICON: Record<VerificationLinkState, ReactNode> = {
  ACTIVE: <CheckCircle2 size={12} aria-hidden="true" />,
  EXPIRED: <Clock size={12} aria-hidden="true" />,
  REVOKED: <Ban size={12} aria-hidden="true" />,
  EXHAUSTED: <Clock size={12} aria-hidden="true" />,
};
const STATE_TONE: Record<VerificationLinkState, AppTone> = {
  ACTIVE: "green",
  EXPIRED: "slate",
  REVOKED: "red",
  EXHAUSTED: "slate",
};

// Members audit SEC-08 — a reviewer share lives 7 days by default and at most
// 30; it is renewed on purpose, never left without an expiry.
type ExpiryChoice = "7" | "14" | "30";
const EXPIRY_OPTIONS: ReadonlyArray<{ value: ExpiryChoice; label: string }> = [
  { value: "7", label: "7 days" },
  { value: "14", label: "14 days" },
  { value: "30", label: "30 days (maximum)" },
];
type ProjectionChoice = "STANDARD" | "BASIC";
/** The share's own disclosure profile: STANDARD = content preview, BASIC = verification only. */
export const SHARE_PROFILE_LABEL: Record<ProjectionChoice, string> = {
  STANDARD: "Content preview",
  BASIC: "Verification only",
};
const PROJECTION_OPTIONS: ReadonlyArray<{ value: ProjectionChoice; label: string; description: string }> = [
  {
    value: "STANDARD",
    label: SHARE_PROFILE_LABEL.STANDARD,
    description: "The verification result plus the title, description, item names and previews.",
  },
  {
    value: "BASIC",
    label: SHARE_PROFILE_LABEL.BASIC,
    description: "The verification result only. No title, preview or details.",
  },
];

function profileLabel(projection: string): string {
  return projection === "BASIC" ? SHARE_PROFILE_LABEL.BASIC : SHARE_PROFILE_LABEL.STANDARD;
}

function purposeLabel(link: VerificationLink): string {
  if (link.purpose === "REPORT") {
    return link.reportVersion != null ? `Printed in report version ${link.reportVersion}` : "Printed in a report";
  }
  if (link.purpose === "PACKAGE") return "Carried by a verification package";
  return link.audience ?? "Reviewer share";
}

function revokedNote(link: VerificationLink): string | null {
  if (link.state !== "REVOKED") return null;
  const when = link.revokedAtUtc ? formatUserDateTime(link.revokedAtUtc) : null;
  const on = when ? ` on ${when}` : "";
  switch (link.revocationReason) {
    case "ROTATED":
      return `Replaced by a new link${on}.`;
    case "CREATOR_REMOVED":
      return `Ended${on}: the person who created it left the workspace.`;
    case "CREATOR_SUSPENDED":
      return `Ended${on}: the person who created it was suspended.`;
    case "CREATOR_LOST_AUTHORITY":
      return `Ended${on}: the person who created it can no longer share records.`;
    case "WORKSPACE_CLOSED":
      return `Ended${on}: the workspace was closed.`;
    default:
      return `Revoked${on}.`;
  }
}

export function ReviewerSharesPanel({
  evidenceId,
  teamId,
  onChanged,
}: {
  evidenceId: string;
  /** The record's workspace — the step-up challenge is bound to it. */
  teamId: string | null;
  /** Called after a change the record page summarises (the legacy link). */
  onChanged?: () => void;
}) {
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const stepUp = useStepUpAction({ teamId });

  const [listing, setListing] = useState<VerificationLinkListing | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "forbidden" | "unavailable" | "error">("loading");
  const [busy, setBusy] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedVerificationLink | null>(null);
  const [audience, setAudience] = useState("");
  const [expiry, setExpiry] = useState<ExpiryChoice>("7");
  const [projection, setProjection] = useState<ProjectionChoice>("STANDARD");
  const [maxUses, setMaxUses] = useState("");
  const [allowOriginalDownload, setAllowOriginalDownload] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  // The workspace's records still reachable by record id — read on request.
  const [inventory, setInventory] = useState<LegacyVerifyLinkInventory | null>(null);
  const [inventoryState, setInventoryState] = useState<"closed" | "loading" | "ready" | "error">("closed");

  const load = useCallback(async () => {
    try {
      setListing(await listVerificationLinks(evidenceId));
      setLoadState("ready");
    } catch (err) {
      const status = (err as { statusCode?: number } | null)?.statusCode;
      // 404 on the LIST route means the API serving this page predates share
      // links (the web deploys before the API). That is not a failure to retry:
      // say the controls are not available yet.
      setLoadState(status === 403 ? "forbidden" : status === 404 ? "unavailable" : "error");
    }
  }, [evidenceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const active = useMemo(() => (listing?.links ?? []).filter((l) => l.state === "ACTIVE"), [listing]);
  const inactive = useMemo(() => (listing?.links ?? []).filter((l) => l.state !== "ACTIVE"), [listing]);
  const pageAvailable = listing?.verificationAccessState === "AVAILABLE";
  const maxUsesValue = maxUses.trim() === "" ? null : Number(maxUses);
  const maxUsesInvalid = maxUsesValue !== null && (!Number.isInteger(maxUsesValue) || maxUsesValue < 1);
  const canCreate = audience.trim().length > 0 && !maxUsesInvalid && busy === null;

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      addToast("Verification link copied", "success");
    } catch {
      addToast("The link could not be copied. Select it and copy it manually.", "error");
    }
  };

  const create = async () => {
    if (!listing || !canCreate) return;
    setBusy("create");
    try {
      const result = await stepUp.runStepUpAction((headers) =>
        createVerificationLink(
          evidenceId,
          {
            audience: audience.trim(),
            expiresInDays: Number(expiry),
            projection,
            maxUses: maxUsesValue,
            // Only a content-preview share can carry the download grant.
            allowOriginalDownload: projection === "STANDARD" && allowOriginalDownload,
          },
          headers,
        ),
      );
      setCreated(result);
      setAudience("");
      setMaxUses("");
      setAllowOriginalDownload(false);
      await load();
      addToast("Reviewer share created", "success");
    } catch (err) {
      if ((err as { code?: string } | null)?.code !== "STEP_UP_CANCEL") {
        notifyApiError(addToast, err, { message: "The reviewer share could not be created." });
      }
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (link: VerificationLink) => {
    const ok = await confirm({
      title: "Revoke this reviewer share?",
      description: `"${purposeLabel(link)}" will stop working immediately. Other reviewer shares and the verification page are not affected. This cannot be undone — create a new share if the reviewer needs access again.`,
      confirmLabel: "Revoke share",
      tone: "danger",
      testId: "verification-link-revoke",
    });
    if (!ok) return;
    setBusy(link.id);
    try {
      await revokeVerificationLink(evidenceId, link.id);
      await load();
      addToast("Reviewer share revoked", "success");
    } catch (err) {
      notifyApiError(addToast, err, { message: "The reviewer share could not be revoked." });
    } finally {
      setBusy(null);
    }
  };

  const renew = async (link: VerificationLink) => {
    const ok = await confirm({
      title: "Renew this reviewer share for 30 days?",
      description: `The link for "${purposeLabel(link)}" keeps working and now expires 30 days from today. The renewal is recorded in the workspace audit log.`,
      confirmLabel: "Renew for 30 days",
      testId: "verification-link-renew",
    });
    if (!ok) return;
    setBusy(link.id);
    try {
      await renewVerificationLink(evidenceId, link.id, 30);
      await load();
      addToast("Reviewer share renewed for 30 days", "success");
    } catch (err) {
      notifyApiError(addToast, err, { message: "The reviewer share could not be renewed." });
    } finally {
      setBusy(null);
    }
  };

  const rotate = async (link: VerificationLink) => {
    const ok = await confirm({
      title: "Replace this reviewer share?",
      description: `The current link for "${purposeLabel(link)}" stops working immediately and a new one is created with the same recipient, expiry and profile. You will need to send the new link to the reviewer.`,
      confirmLabel: "Replace share",
      testId: "verification-link-rotate",
    });
    if (!ok) return;
    setBusy(link.id);
    try {
      const result = await rotateVerificationLink(evidenceId, link.id);
      setCreated(result);
      await load();
      addToast("Reviewer share replaced", "success");
    } catch (err) {
      notifyApiError(addToast, err, { message: "The reviewer share could not be replaced." });
    } finally {
      setBusy(null);
    }
  };

  const toggleInventory = async () => {
    if (inventoryState !== "closed") {
      setInventoryState("closed");
      return;
    }
    setInventoryState("loading");
    try {
      setInventory(await legacyVerifyLinkInventory());
      setInventoryState("ready");
    } catch {
      setInventoryState("error");
    }
  };

  const revokeLegacy = async () => {
    const ok = await confirm({
      title: "End the legacy link now?",
      description:
        "Links and QR codes that use this record's id — including those printed in reports issued before share links existed — will stop working immediately. This cannot be undone.",
      confirmLabel: "End legacy link",
      tone: "danger",
      testId: "verification-link-legacy-revoke",
    });
    if (!ok) return;
    setBusy("legacy");
    try {
      await revokeLegacyVerifyLink(evidenceId);
      await load();
      // The workspace list, if open, is now one record out of date.
      setInventoryState("closed");
      onChanged?.();
      addToast("Legacy link ended", "success");
    } catch (err) {
      notifyApiError(addToast, err, { message: "The legacy link could not be ended." });
    } finally {
      setBusy(null);
    }
  };

  const row = (link: VerificationLink) => (
    <li
      key={link.id}
      className="evidence-detail-link-row"
      data-verification-link={link.id}
      data-verification-link-state={link.state}
      // The SERVER says whether the link answers: an ACTIVE share on a
      // withdrawn or suspended page answers what the page answers, and is
      // never labelled "Active".
      data-verification-link-usable={link.usable ? "true" : "false"}
    >
      <div className="evidence-detail-link-row__main">
        <strong>{purposeLabel(link)}</strong>
        {link.state === "ACTIVE" && !link.usable ? (
          <AppStatusBadge tone="amber" data-verification-link-inactive={link.inactiveReason ?? "UNKNOWN"}>
            <PauseCircle size={12} aria-hidden="true" /> Inactive — verification page not available
          </AppStatusBadge>
        ) : (
          <AppStatusBadge tone={STATE_TONE[link.state]}>
            {STATE_ICON[link.state]} {STATE_LABEL[link.state]}
          </AppStatusBadge>
        )}
        {link.purpose === "OWNER_SHARE" ? (
          <AppStatusBadge tone="slate" data-verification-link-profile={link.projection}>
            {profileLabel(link.projection)}
          </AppStatusBadge>
        ) : null}
        {link.allowOriginalDownload ? (
          <AppStatusBadge tone="amber" data-verification-link-original-download>
            <Download size={12} aria-hidden="true" /> Original download allowed
          </AppStatusBadge>
        ) : null}
      </div>
      <p className="app-field__help">
        Created {formatUserDate(link.createdAtUtc)}
        {link.expiresAtUtc
          ? ` · ${link.state === "EXPIRED" ? "expired" : "expires"} ${formatUserDate(link.expiresAtUtc)}`
          : ""}
        {link.maxUses != null ? ` · ${link.useCount} of ${link.maxUses} uses` : ` · opened ${link.useCount} time${link.useCount === 1 ? "" : "s"}`}
        {link.lastUsedAtUtc ? ` · last opened ${formatUserDateTime(link.lastUsedAtUtc)}` : ""}
      </p>
      {revokedNote(link) ? <p className="app-field__help">{revokedNote(link)}</p> : null}
      {link.state === "ACTIVE" || (link.state === "EXPIRED" && link.purpose === "OWNER_SHARE") ? (
        <div className="evidence-detail-link-row__actions">
          {link.purpose === "OWNER_SHARE" ? (
            <button
              type="button"
              className="app-secondary-action"
              disabled={busy !== null}
              onClick={() => void renew(link)}
              data-verification-link-action="renew"
            >
              Renew
            </button>
          ) : null}
          {link.state === "ACTIVE" ? (
          <button
            type="button"
            className="app-secondary-action"
            disabled={busy !== null}
            onClick={() => void rotate(link)}
            data-verification-link-action="rotate"
          >
            Replace share
          </button>
          ) : null}
          {link.state === "ACTIVE" ? (
          <button
            type="button"
            className="app-secondary-action evidence-detail-destructive-action"
            disabled={busy !== null}
            onClick={() => void revoke(link)}
            data-verification-link-action="revoke"
          >
            Revoke
          </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );

  return (
    <section
      id="reviewer-shares"
      className="evidence-detail-links-panel"
      data-evidence-section="reviewer-shares"
      aria-labelledby="reviewer-shares-title"
    >
      <h2 id="reviewer-shares-title" className="evidence-detail-verify-card__title">
        Secure reviewer shares
      </h2>

      {loadState === "loading" ? <p className="app-field__help">Loading reviewer shares…</p> : null}
      {loadState === "forbidden" ? (
        <p className="app-field__help" data-verification-links-forbidden>
          Managing reviewer shares needs a role with the publish permission in this workspace.
        </p>
      ) : null}
      {loadState === "unavailable" ? (
        <p className="app-field__help" data-verification-links-unavailable>
          Reviewer shares are not available for this record yet.
        </p>
      ) : null}
      {loadState === "error" ? (
        <p className="app-field__help" role="alert">
          The reviewer shares could not be loaded.{" "}
          <button type="button" className="evidence-detail-inline-link" onClick={() => void load()}>
            Try again
          </button>
        </p>
      ) : null}

      {loadState === "ready" && listing ? (
        <>
          <p className="app-field__help" data-verification-links-state={pageAvailable ? "available" : "page-unavailable"}>
            {pageAvailable
              ? "A reviewer share is for one named reviewer. It shows what its own profile allows, until it expires, reaches its use limit or you revoke it. Creating one never changes what the verification page discloses."
              : "The verification page is withdrawn or suspended, so every share answers that it is not available until the page is reinstated."}
          </p>

          {created ? (
            <div className="app-alert" role="status" data-verification-link-created>
              <strong>Copy this link now.</strong>
              <p>
                It is shown once. PROOVRA keeps only a fingerprint of it, so it cannot be displayed again — if it is
                lost, replace the link.
              </p>
              <input
                className="app-input"
                readOnly
                value={absoluteVerifyUrl(created.verifyPath)}
                onFocus={(e) => e.currentTarget.select()}
                aria-label="New reviewer share link"
                data-verification-link-url
              />
              <div className="evidence-detail-link-row__actions">
                <button
                  type="button"
                  className="app-secondary-action"
                  onClick={() => void copy(absoluteVerifyUrl(created.verifyPath))}
                  data-verification-link-action="copy"
                >
                  Copy link
                </button>
                <button type="button" className="app-secondary-action" onClick={() => setCreated(null)}>
                  I have copied it
                </button>
              </div>
            </div>
          ) : null}

          {listing.legacy ? (
            <div className="evidence-detail-link-row" data-verification-link="legacy" data-verification-link-state={listing.legacy.active ? "ACTIVE" : "EXPIRED"}>
              <div className="evidence-detail-link-row__main">
                <strong>Legacy link (record ID)</strong>
                <AppStatusBadge tone={listing.legacy.active ? "amber" : "slate"}>
                  {listing.legacy.active ? "Active until it ends" : "Ended"}
                </AppStatusBadge>
              </div>
              <p className="app-field__help">
                {listing.legacy.active
                  ? `This record was shared by its record ID before share links existed, so links and QR codes that use its id — including those printed in earlier reports — still work until ${formatUserDate(listing.legacy.expiresAtUtc)}. After that only share links work. It cannot be extended.`
                  : `Links that use this record's id stopped working on ${formatUserDate(listing.legacy.expiresAtUtc)}.`}
              </p>
              {listing.legacy.active ? (
                <div className="evidence-detail-link-row__actions">
                  <button
                    type="button"
                    className="app-secondary-action evidence-detail-destructive-action"
                    disabled={busy !== null}
                    onClick={() => void revokeLegacy()}
                    data-verification-link-action="revoke-legacy"
                  >
                    End legacy link now
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          <button
            type="button"
            className="evidence-detail-inline-link"
            aria-expanded={inventoryState !== "closed"}
            onClick={() => void toggleInventory()}
            data-verification-links-toggle="legacy-inventory"
          >
            {inventoryState === "closed" ? "Show" : "Hide"} records in this workspace still reachable by record ID
          </button>
          {inventoryState === "loading" ? <p className="app-field__help">Loading…</p> : null}
          {inventoryState === "error" ? (
            <p className="app-field__help" role="alert" data-verification-legacy-inventory="error">
              The list could not be loaded.
            </p>
          ) : null}
          {inventoryState === "ready" && inventory ? (
            <div data-verification-legacy-inventory={inventory.activeCount > 0 ? "some" : "none"}>
              {inventory.activeCount === 0 ? (
                <p className="app-field__help">
                  No record in this workspace can be opened by its record ID. Only share links work.
                </p>
              ) : (
                <>
                  <p className="app-field__help">
                    {inventory.activeCount} record{inventory.activeCount === 1 ? "" : "s"} can still be opened by
                    record ID
                    {inventory.latestExpiryUtc ? `, the last until ${formatUserDate(inventory.latestExpiryUtc)}` : ""}.
                    Open a record to end its legacy link early.
                    {inventory.records.length < inventory.activeCount
                      ? ` Showing the ${inventory.records.length} that end soonest.`
                      : ""}
                  </p>
                  <ul className="evidence-detail-link-list">
                    {inventory.records.map((r) => (
                      <li key={r.evidenceId} className="evidence-detail-link-row" data-verification-legacy-record={r.evidenceId}>
                        <div className="evidence-detail-link-row__main">
                          <Link className="evidence-detail-inline-link" href={evidenceVerificationPageHref(r.evidenceId)}>
                            {r.title?.trim() || "Untitled record"}
                          </Link>
                        </div>
                        <p className="app-field__help">Reachable by record ID until {formatUserDate(r.expiresAtUtc)}</p>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          ) : null}

          {active.length > 0 ? (
            <ul className="evidence-detail-link-list" data-verification-links="active">
              {active.map(row)}
            </ul>
          ) : (
            <p className="app-field__help">No active reviewer shares.</p>
          )}

          {inactive.length > 0 ? (
            <>
              <button
                type="button"
                className="evidence-detail-inline-link"
                aria-expanded={showInactive}
                onClick={() => setShowInactive((v) => !v)}
                data-verification-links-toggle="inactive"
              >
                {showInactive ? "Hide" : "Show"} {inactive.length} expired or revoked share{inactive.length === 1 ? "" : "s"}
              </button>
              {showInactive ? (
                <ul className="evidence-detail-link-list" data-verification-links="inactive">
                  {inactive.map(row)}
                </ul>
              ) : null}
            </>
          ) : null}

          {listing.shareable ? (
            <form
              className="evidence-detail-link-form"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
              data-verification-link-form
            >
              <div>
                <label className="app-field-label" htmlFor="verification-link-audience">
                  Recipient
                </label>
                <input
                  id="verification-link-audience"
                  className="app-input"
                  value={audience}
                  maxLength={120}
                  onChange={(e) => setAudience(e.target.value)}
                  placeholder="For example: opposing counsel, the insurer, the court clerk"
                />
                <p className="app-field__help">Only your workspace sees this label. It lets you revoke one reviewer later.</p>
              </div>
              <div>
                <label className="app-field-label" htmlFor="verification-link-expiry">
                  Expires
                </label>
                <AppListbox
                  id="verification-link-expiry"
                  ariaLabel="Expires"
                  value={expiry}
                  options={EXPIRY_OPTIONS}
                  onChange={setExpiry}
                />
              </div>
              <div>
                <label className="app-field-label" htmlFor="verification-link-projection">
                  Profile
                </label>
                <AppListbox
                  id="verification-link-projection"
                  ariaLabel="Profile"
                  value={projection}
                  options={PROJECTION_OPTIONS}
                  onChange={(next) => {
                    setProjection(next);
                    if (next !== "STANDARD") setAllowOriginalDownload(false);
                  }}
                />
              </div>
              <div>
                <label className="evidence-detail-switch" htmlFor="verification-link-original-download">
                  <input
                    id="verification-link-original-download"
                    type="checkbox"
                    checked={projection === "STANDARD" && allowOriginalDownload}
                    disabled={projection !== "STANDARD"}
                    aria-describedby="verification-link-original-download-help"
                    onChange={(e) => setAllowOriginalDownload(e.target.checked)}
                    data-verification-link-original-download-toggle
                  />
                  <span>Allow original file download</span>
                </label>
                <p className="app-field__help" id="verification-link-original-download-help">
                  {projection === "STANDARD"
                    ? "The reviewer can download the original files, subject to your export controls. Granting it asks you to confirm your identity."
                    : "Available only with the Content preview profile."}
                </p>
              </div>
              <div>
                <label className="app-field-label" htmlFor="verification-link-max-uses">
                  Use limit (optional)
                </label>
                <input
                  id="verification-link-max-uses"
                  className="app-input"
                  inputMode="numeric"
                  value={maxUses}
                  onChange={(e) => setMaxUses(e.target.value)}
                  placeholder="No limit"
                  aria-invalid={maxUsesInvalid}
                />
                {maxUsesInvalid ? (
                  <p className="app-field-error" role="alert">
                    Enter a whole number of at least 1, or leave it empty.
                  </p>
                ) : null}
              </div>
              <button type="submit" className="app-secondary-action" disabled={!canCreate} data-verification-link-action="create">
                {busy === "create" ? "Creating…" : "Create reviewer share"}
              </button>
            </form>
          ) : (
            <p className="app-field__help" data-verification-links-unshareable>
              A reviewer share can be created once the record is finalized, and not while it is in Trash.
            </p>
          )}
        </>
      ) : null}
      <StepUpModal control={stepUp} />
    </section>
  );
}
