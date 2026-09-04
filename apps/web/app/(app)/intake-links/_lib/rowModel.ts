/**
 * Intake links — the ONE row model.
 *
 * The desktop table and the narrow cards are two RENDERERS over this single
 * mapping. Business logic (which state a link is in, which label and tone that
 * state carries, which actions are eligible) is decided here, once, and both
 * renderers read the result. Keeping two renderers is a layout decision;
 * keeping two mappings would be a second source of truth.
 *
 * Pure: no React, no I/O, `now` injectable so the tests are not clock-flaky.
 */

import { formatUserDate, formatUserDateTime } from "../../../../lib/date";
import { describeRelativeTime } from "../../../../lib/relative-time";
import {
  canArchiveLink,
  canRevokeLink,
  getDeliveryPresentation,
  getLatestSessionState,
  getLinkOperationalState,
  type DeliveryPresentation,
  type LatestSessionState,
  type LinkOperationalState,
} from "../../../../lib/intake-links/state-model";
import {
  channelLabel,
  intakeModeShortLabel,
  providerErrorCodeLabel,
  DELIVERY_STATE_VOCABULARY,
  LINK_STATE_VOCABULARY,
  SESSION_STATE_VOCABULARY,
  type IntakeVocabularyEntry,
} from "../../../../lib/intake-links/vocabulary";
import type { IntakeLinkListItem } from "./types";

/** Near-expiry window. A caution, not a failure. */
export const EXPIRING_SOON_MS = 72 * 60 * 60 * 1000;

export type ExpiryState = "expired" | "soon" | "ok";

export type IntakeRowModel = {
  id: string;
  /** Primary value. */
  requestName: string;
  /** Secondary value under the primary. */
  modeLabel: string;
  /** Masked recipient — label, then email preview, then phone preview. */
  /**
   * FOUR INDEPENDENT FACTS, not one string.
   *
   * These used to be a single `recipientText` built from
   * `recipientLabel ?? emailPreview ?? phonePreview`, so a request that had a
   * name showed only the name — the address it went to and the number it was
   * texted to simply vanished, and the Customer ID was never on the client at
   * all. For anyone running many requests at once those are four different
   * questions ("whose file is this?", "who did we ask?", "where did it go?"),
   * and answering them with whichever one happened to be set is how an
   * operator ends up keeping their own list somewhere else.
   *
   * Each is null when genuinely absent. Nothing substitutes for anything.
   */
  customerId: string | null;
  recipientName: string | null;
  recipientEmail: string | null;
  recipientPhone: string | null;
  /** Whether the two contact values above are the raw or the masked form. */
  recipientContactIsMasked: boolean;
  /** True when the API returned no recipient of any kind. */
  recipientIsPlaceholder: boolean;
  channelWire: string;
  channelLabel: string;

  lifecycle: LinkOperationalState;
  lifecycleVocab: IntakeVocabularyEntry;

  activity: LatestSessionState;
  activityVocab: IntakeVocabularyEntry;

  delivery: DeliveryPresentation;
  deliveryVocab: IntakeVocabularyEntry;
  /** "· 3 attempts" style suffix, empty when there is nothing to add. */
  deliveryDetail: string;

  latestActivityIso: string;
  latestActivityRelative: string;
  latestActivityAbsolute: string;

  expiresAtUtc: string;
  expiryState: ExpiryState;
  expiryRelative: string;
  /** Date only — what a narrow table column can show without splitting it. */
  expiryDate: string;
  /** Full local timestamp — the tooltip, the card and the details drawer. */
  expiryAbsolute: string;

  submissionsCount: number;
  inProgressCount: number;
  /** What the submissions cell offers. */
  submissionsAction: "view" | "in_progress" | "none";
  submissionsLabel: string;

  archived: boolean;
  canDisable: boolean;
  canArchive: boolean;
  canUnarchive: boolean;
  hasSessions: boolean;
  hasDeliveryHistory: boolean;

  /** Echoed onto the row for end-to-end probes. */
  computedLifecycle: string;
};

/**
 * Re-exported, not redefined.
 *
 * The implementation moved to `lib/relative-time` when Operations needed the
 * same phrasing: two surfaces of one product must not describe the same age
 * two ways. The name stays exported here because this route's components
 * already import it from this module, and moving the call sites would be a
 * larger diff than the move itself.
 */
export { describeRelativeTime };

export function expiryStateOf(
  expiresAtUtc: string,
  now: number = Date.now(),
): ExpiryState {
  const t = Date.parse(expiresAtUtc);
  if (!Number.isFinite(t)) return "ok";
  if (t <= now) return "expired";
  return t - now < EXPIRING_SOON_MS ? "soon" : "ok";
}

export function buildRowModel(
  item: IntakeLinkListItem,
  now: number = Date.now(),
): IntakeRowModel {
  const { link, delivery, activity } = item;
  const nowDate = new Date(now);

  const lifecycle = getLinkOperationalState(link, nowDate);
  const activityState = getLatestSessionState(activity);
  // THE CANONICAL RESOLVER, not a JSX guess. `MANUAL` is decided from the
  // domain (no delivery record exists) in one place that both renderers and
  // every test read.
  const deliveryState = getDeliveryPresentation(delivery);

  const channelWire = String(delivery.latestChannel ?? "MANUAL").toUpperCase();

  const attemptSuffix =
    delivery.attemptCount > 1 ? `${delivery.attemptCount} attempts` : "";
  const errorSuffix = delivery.latestErrorCode
    ? providerErrorCodeLabel(delivery.latestErrorCode)
    : "";
  const deliveryDetail = [attemptSuffix, errorSuffix]
    .filter(Boolean)
    .join(" · ");

  const latestActivityIso =
    activity.lastSubmittedAtUtc ??
    activity.lastStartedAtUtc ??
    activity.lastOpenedAtUtc ??
    delivery.latestAtUtc ??
    link.createdAt;

  const submissions = activity.sessionsSubmitted;
  // `sessionsStarted` counts every session that began an upload, including the
  // ones that went on to submit — so "in progress" is the remainder.
  const inProgress = Math.max(0, activity.sessionsStarted - submissions);

  /*
   * The server decides raw-versus-masked and says which it sent; the browser
   * only chooses which field to read. An authorized operator sees the address
   * directly — being made to press "reveal" on every row to answer "who did I
   * send this to?" is not a privacy control, it is a tax — while a limited
   * reader still gets the mask, and neither is decided here.
   */
  const revealed = link.recipientContactRevealAuthorized === true;
  const recipientEmail =
    (revealed ? link.recipientEmail : null) ?? link.recipientEmailPreview ?? null;
  const recipientPhone =
    (revealed ? link.recipientPhone : null) ?? link.recipientPhonePreview ?? null;

  const expiryState = expiryStateOf(link.expiresAtUtc, now);
  const expiryRelative = describeRelativeTime(link.expiresAtUtc, now);
  const expiryDate = formatUserDate(link.expiresAtUtc);
  const expiryAbsolute = formatUserDateTime(link.expiresAtUtc);

  return {
    id: link.id,
    requestName: link.workflowTemplateName,
    modeLabel: intakeModeShortLabel(link.intakeMode),
    customerId: link.customerId ?? null,
    recipientName: link.recipientLabel ?? null,
    recipientEmail,
    recipientPhone,
    recipientContactIsMasked: !revealed,
    recipientIsPlaceholder:
      !link.recipientLabel && !recipientEmail && !recipientPhone,
    channelWire,
    channelLabel: channelLabel(channelWire),

    lifecycle,
    lifecycleVocab: LINK_STATE_VOCABULARY[lifecycle],

    activity: activityState,
    activityVocab: SESSION_STATE_VOCABULARY[activityState],

    delivery: deliveryState,
    deliveryVocab: DELIVERY_STATE_VOCABULARY[deliveryState],
    deliveryDetail,

    latestActivityIso,
    latestActivityRelative: describeRelativeTime(latestActivityIso, now),
    latestActivityAbsolute: formatUserDateTime(latestActivityIso),

    expiresAtUtc: link.expiresAtUtc,
    expiryState,
    expiryRelative,
    expiryDate,
    expiryAbsolute,

    submissionsCount: submissions,
    inProgressCount: inProgress,
    submissionsAction:
      submissions > 0 ? "view" : inProgress > 0 ? "in_progress" : "none",
    submissionsLabel:
      submissions > 0
        ? `View submissions (${submissions})`
        : inProgress > 0
          ? `In progress (${inProgress})`
          : "None yet",

    archived: Boolean(link.archivedAtUtc),
    canDisable: canRevokeLink(link),
    canArchive: canArchiveLink(link),
    canUnarchive: Boolean(link.archivedAtUtc),
    hasSessions: activity.sessionsCreated > 0,
    hasDeliveryHistory: delivery.attemptCount > 0,

    computedLifecycle: item.computedLifecycle,
  };
}
