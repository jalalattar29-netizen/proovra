/**
 * ATTENTION ARCHITECTURE PHASE 5 (2026-08-22) — /notifications is THE personal
 * notification center.
 *
 * ---------------------------------------------------------------------------
 * TWO ROUTES SWAPPED MEANING HERE, SO READ THIS BEFORE CHANGING IT
 * ---------------------------------------------------------------------------
 *   BEFORE                                    AFTER
 *   /inbox         personal notifications  ->  permanent redirect to here
 *   /notifications outbound delivery log   ->  moved to
 *                                              /settings/notifications/deliveries
 *
 * The old `/notifications` was an ADMIN DEBUGGING SURFACE: a log of outbound
 * email `NotificationDelivery` rows with resend buttons. A user following an
 * obvious guess at "where are my notifications?" landed on a provider error
 * log, and the surface that actually held their notifications was called an
 * inbox. Both names lied, in opposite directions.
 *
 * The delivery log did not lose anything: it moved, intact, to a truthful
 * location under settings, and `/notifications/deliveries` redirects there for
 * anyone with the old link.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS A RE-EXPORT AND NOT A COPY
 * ---------------------------------------------------------------------------
 * `/inbox` remains a live compatibility route — shipped emails, digests and
 * collaboration links point at it and must keep working. Two copies of a
 * 1,300-line page is how the canonical route and its compatibility route
 * drift apart, so there is ONE implementation and this is its canonical URL.
 */
export { default } from "../inbox/page";
