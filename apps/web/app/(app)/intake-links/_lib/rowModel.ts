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
  recipientText: string;
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

export function describeRelativeTime(
  iso: string | null | undefined,
  now: number = Date.now(),
): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const past = t <= now;
  const deltaMs = Math.abs(now - t);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return past ? "just now" : "in under a minute";
  if (minutes < 60) return past ? `${minutes}m ago` : `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return past ? `${hours}h ago` : `in ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return past ? `${days}d ago` : `in ${days}d`;
  return formatUserDate(iso);
}

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

  const recipientText =
    link.recipientLabel ??
    link.recipientEmailPreview ??
    link.recipientPhonePreview ??
    "No recipient";

  const expiryState = expiryStateOf(link.expiresAtUtc, now);
  const expiryRelative = describeRelativeTime(link.expiresAtUtc, now);
  const expiryDate = formatUserDate(link.expiresAtUtc);
  const expiryAbsolute = formatUserDateTime(link.expiresAtUtc);

  return {
    id: link.id,
    requestName: link.workflowTemplateName,
    modeLabel: intakeModeShortLabel(link.intakeMode),
    recipientText,
    recipientIsPlaceholder:
      !link.recipientLabel &&
      !link.recipientEmailPreview &&
      !link.recipientPhonePreview,
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
