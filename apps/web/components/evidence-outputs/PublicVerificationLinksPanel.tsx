"use client";

/**
 * PUBLIC VERIFICATION LINKS — the owner's controls (ET-PKG-07, 2026-09-30).
 *
 * A record is private until its owner publishes it, and a public link is an
 * opaque share token, never the record's id. This panel is where that is done:
 *
 *   create   name the audience, choose an expiry, and get the link ONCE
 *   copy     only at creation or rotation — the server keeps a hash, not the link
 *   revoke   one link; every other recipient keeps theirs
 *   rotate   replace one link; the old one stops at once
 *   view     every link with its state: active, expired, revoked, used up
 *   legacy   the old record-id link, when the record has one, with its end date
 *
 * Creating the FIRST link on an unpublished record is the act of publishing it,
 * and says so before it happens.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { AppListbox, AppStatusBadge, type AppTone } from "../app-primitives";
import { StepUpModal, useStepUpAction } from "../identity-security/StepUpModal";
import { useToast } from "../ui";
import { useConfirmAction } from "../ui/ConfirmActionModal";
import { notifyApiError } from "../../lib/feedback/notify";
import { formatUserDate, formatUserDateTime } from "../../lib/date";
import {
  absoluteVerifyUrl,
  createVerificationLink,
  listVerificationLinks,
  revokeLegacyVerifyLink,
  revokeVerificationLink,
  rotateVerificationLink,
  type CreatedVerificationLink,
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
const STATE_TONE: Record<VerificationLinkState, AppTone> = {
  ACTIVE: "green",
  EXPIRED: "slate",
  REVOKED: "red",
  EXHAUSTED: "slate",
};

type ExpiryChoice = "7" | "30" | "90" | "365" | "never";
const EXPIRY_OPTIONS: ReadonlyArray<{ value: ExpiryChoice; label: string }> = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "never", label: "No expiry" },
];
type ProjectionChoice = "STANDARD" | "BASIC";
const PROJECTION_OPTIONS: ReadonlyArray<{ value: ProjectionChoice; label: string; description: string }> = [
  {
    value: "STANDARD",
    label: "Standard verification page",
    description: "Everything this record's public page is allowed to show.",
  },
  {
    value: "BASIC",
    label: "Integrity result only",
    description: "Hash, signature, timestamp and anchoring checks. No title, preview or details.",
  },
];

function purposeLabel(link: VerificationLink): string {
  if (link.purpose === "REPORT") {
    return link.reportVersion != null ? `Printed in report version ${link.reportVersion}` : "Printed in a report";
  }
  if (link.purpose === "PACKAGE") return "Carried by a verification package";
  return link.audience ?? "Shared link";
}

function revokedNote(link: VerificationLink): string | null {
  if (link.state !== "REVOKED") return null;
  const when = link.revokedAtUtc ? formatUserDateTime(link.revokedAtUtc) : null;
  return link.revocationReason === "ROTATED"
    ? `Replaced by a new link${when ? ` on ${when}` : ""}.`
    : `Revoked${when ? ` on ${when}` : ""}.`;
}

export function PublicVerificationLinksPanel({
  evidenceId,
  teamId,
  onChanged,
}: {
  evidenceId: string;
  /** The record's workspace — the step-up challenge is bound to it. */
  teamId: string | null;
  /** Called after a change that may alter the record's publication state. */
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
  const [expiry, setExpiry] = useState<ExpiryChoice>("30");
  const [projection, setProjection] = useState<ProjectionChoice>("STANDARD");
  const [maxUses, setMaxUses] = useState("");
  const [showInactive, setShowInactive] = useState(false);

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
  const published = listing?.publicVerifyState === "PUBLISHED";
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
    if (!published) {
      const ok = await confirm({
        title: "Publish this record and create the link?",
        description:
          "This record is not public. Creating its first verification link publishes it: anyone who holds the link can open its public verification page until you revoke the link or unpublish the record. The record's id alone opens nothing.",
        confirmLabel: "Publish and create link",
        testId: "verification-link-publish",
      });
      if (!ok) return;
    }
    setBusy("create");
    try {
      const result = await stepUp.runStepUpAction((headers) =>
        createVerificationLink(
          evidenceId,
          {
            audience: audience.trim(),
            expiresInDays: expiry === "never" ? null : Number(expiry),
            projection,
            maxUses: maxUsesValue,
          },
          headers,
        ),
      );
      setCreated(result);
      setAudience("");
      setMaxUses("");
      await load();
      if (result.published) onChanged?.();
      addToast("Verification link created", "success");
    } catch (err) {
      if ((err as { code?: string } | null)?.code !== "STEP_UP_CANCEL") {
        notifyApiError(addToast, err, { message: "The verification link could not be created." });
      }
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (link: VerificationLink) => {
    const ok = await confirm({
      title: "Revoke this verification link?",
      description: `"${purposeLabel(link)}" will stop working immediately. Other links for this record are not affected. This cannot be undone — create a new link if the recipient needs access again.`,
      confirmLabel: "Revoke link",
      tone: "danger",
      testId: "verification-link-revoke",
    });
    if (!ok) return;
    setBusy(link.id);
    try {
      await revokeVerificationLink(evidenceId, link.id);
      await load();
      addToast("Verification link revoked", "success");
    } catch (err) {
      notifyApiError(addToast, err, { message: "The verification link could not be revoked." });
    } finally {
      setBusy(null);
    }
  };

  const rotate = async (link: VerificationLink) => {
    const ok = await confirm({
      title: "Replace this verification link?",
      description: `The current link for "${purposeLabel(link)}" stops working immediately and a new one is created with the same audience and expiry. You will need to send the new link to the recipient.`,
      confirmLabel: "Replace link",
      testId: "verification-link-rotate",
    });
    if (!ok) return;
    setBusy(link.id);
    try {
      const result = await rotateVerificationLink(evidenceId, link.id);
      setCreated(result);
      await load();
      addToast("Verification link replaced", "success");
    } catch (err) {
      notifyApiError(addToast, err, { message: "The verification link could not be replaced." });
    } finally {
      setBusy(null);
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
      onChanged?.();
      addToast("Legacy link ended", "success");
    } catch (err) {
      notifyApiError(addToast, err, { message: "The legacy link could not be ended." });
    } finally {
      setBusy(null);
    }
  };

  const row = (link: VerificationLink) => (
    <li key={link.id} className="evidence-detail-link-row" data-verification-link={link.id} data-verification-link-state={link.state}>
      <div className="evidence-detail-link-row__main">
        <strong>{purposeLabel(link)}</strong>
        <AppStatusBadge tone={STATE_TONE[link.state]}>{STATE_LABEL[link.state]}</AppStatusBadge>
        {link.projection === "BASIC" ? <AppStatusBadge tone="slate">Integrity result only</AppStatusBadge> : null}
      </div>
      <p className="app-field__help">
        Created {formatUserDate(link.createdAtUtc)}
        {link.expiresAtUtc
          ? ` · ${link.state === "EXPIRED" ? "expired" : "expires"} ${formatUserDate(link.expiresAtUtc)}`
          : " · no expiry"}
        {link.maxUses != null ? ` · ${link.useCount} of ${link.maxUses} uses` : ` · opened ${link.useCount} time${link.useCount === 1 ? "" : "s"}`}
        {link.lastUsedAtUtc ? ` · last opened ${formatUserDateTime(link.lastUsedAtUtc)}` : ""}
      </p>
      {revokedNote(link) ? <p className="app-field__help">{revokedNote(link)}</p> : null}
      {link.state === "ACTIVE" ? (
        <div className="evidence-detail-link-row__actions">
          <button
            type="button"
            className="app-secondary-action"
            disabled={busy !== null}
            onClick={() => void rotate(link)}
            data-verification-link-action="rotate"
          >
            Replace link
          </button>
          <button
            type="button"
            className="app-secondary-action evidence-detail-destructive-action"
            disabled={busy !== null}
            onClick={() => void revoke(link)}
            data-verification-link-action="revoke"
          >
            Revoke
          </button>
        </div>
      ) : null}
    </li>
  );

  return (
    <section
      id="public-verification-links"
      className="evidence-detail-links-panel"
      data-evidence-section="public-verification-links"
      aria-labelledby="public-verification-links-title"
    >
      <h2 id="public-verification-links-title" className="evidence-detail-verify-card__title">
        Public verification links
      </h2>

      {loadState === "loading" ? <p className="app-field__help">Loading links…</p> : null}
      {loadState === "forbidden" ? (
        <p className="app-field__help" data-verification-links-forbidden>
          Managing public verification links needs a role with the publish permission in this workspace.
        </p>
      ) : null}
      {loadState === "unavailable" ? (
        <p className="app-field__help" data-verification-links-unavailable>
          Public verification links are not available for this record yet.
        </p>
      ) : null}
      {loadState === "error" ? (
        <p className="app-field__help" role="alert">
          The links could not be loaded.{" "}
          <button type="button" className="evidence-detail-inline-link" onClick={() => void load()}>
            Try again
          </button>
        </p>
      ) : null}

      {loadState === "ready" && listing ? (
        <>
          <p className="app-field__help" data-verification-links-state={published ? "published" : "private"}>
            {published
              ? "This record is published. Only someone holding one of the links below can open its public verification page — the record's id alone opens nothing."
              : "This record is private. It has no public verification page until you create a link, which publishes it."}
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
                aria-label="New verification link"
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
                  ? `This record was published before share links existed, so links and QR codes that use its id — including those printed in earlier reports — still work until ${formatUserDate(listing.legacy.expiresAtUtc)}. After that only share links work. It cannot be extended.`
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

          {active.length > 0 ? (
            <ul className="evidence-detail-link-list" data-verification-links="active">
              {active.map(row)}
            </ul>
          ) : (
            <p className="app-field__help">No active links.</p>
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
                {showInactive ? "Hide" : "Show"} {inactive.length} expired or revoked link{inactive.length === 1 ? "" : "s"}
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
                  Who is this link for?
                </label>
                <input
                  id="verification-link-audience"
                  className="app-input"
                  value={audience}
                  maxLength={120}
                  onChange={(e) => setAudience(e.target.value)}
                  placeholder="For example: opposing counsel, the insurer, the court clerk"
                />
                <p className="app-field__help">Only you see this label. It lets you revoke one recipient later.</p>
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
                  What the link shows
                </label>
                <AppListbox
                  id="verification-link-projection"
                  ariaLabel="What the link shows"
                  value={projection}
                  options={PROJECTION_OPTIONS}
                  onChange={setProjection}
                />
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
                {busy === "create" ? "Creating…" : published ? "Create link" : "Publish and create link"}
              </button>
            </form>
          ) : (
            <p className="app-field__help" data-verification-links-unshareable>
              A link can be created once the record is finalized, and not while it is in Trash.
            </p>
          )}
        </>
      ) : null}
      <StepUpModal control={stepUp} />
    </section>
  );
}
