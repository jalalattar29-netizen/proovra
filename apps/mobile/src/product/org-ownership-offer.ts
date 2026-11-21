/**
 * NEW-RG-26-4 / owner decision E (DEC-18) — THE ORGANIZATION OWNERSHIP OFFER,
 * NATIVE.
 *
 * Organization ownership moves only by offer: the ORG_OWNER offers
 * (`POST /v1/orgs/:id/transfer-ownership`, 202 `pendingAcceptance`), and the
 * named member accepts with their OWN account step-up or declines; the offerer
 * may withdraw. Until now the recipient could act only in the web app; the
 * phone said "Offer sent" and nothing on the phone could answer it.
 *
 * The routes (services/api/src/routes/organizations.routes.ts):
 *   GET  /v1/orgs/:id/ownership-offer                 → { offer | null, billingOwnerStays, billingOwnerUserId }
 *   POST /v1/orgs/:id/ownership-offer/:offerId/accept  (recipient; step-up org_ownership_transfer)
 *   POST /v1/orgs/:id/ownership-offer/:offerId/decline (recipient)
 *   POST /v1/orgs/:id/ownership-offer/:offerId/cancel  (offerer)
 *
 * The server answers an offer only to its two parties; everyone else reads
 * `{ offer: null }` (and a non-member the organization's uniform not-found).
 * The client therefore never decides who may act: it shows the controls the
 * signed-in person's side of the offer has, and carries the server's refusal.
 *
 * THE PAYER DOES NOT MOVE. The copy says, before acceptance, that the billing
 * owner stays — the route reports it (`billingOwnerStays`, `billingOwnerUserId`).
 *
 * Pure: no React, no react-native, no fetch.
 */

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isOrgUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

export interface OrgOwnershipOffer {
  id: string;
  organizationId: string;
  fromUserId: string;
  toUserId: string;
  status: string;
  expiresAtIso: string | null;
}

export interface OrgOwnershipOfferState {
  offer: OrgOwnershipOffer | null;
  /** The billing owner that stays in force when the offer is accepted. */
  billingOwnerUserId: string | null;
}

export function buildOrgOwnershipOfferPath(orgId: string): string {
  return `/v1/orgs/${encodeURIComponent(orgId)}/ownership-offer`;
}

export function buildOrgOwnershipOfferActionPath(
  orgId: string,
  offerId: string,
  action: "accept" | "decline" | "cancel",
): string {
  return `${buildOrgOwnershipOfferPath(orgId)}/${encodeURIComponent(offerId)}/${action}`;
}
// One builder per route, each with a literal suffix, so every call site names
// exactly one API route (the architecture audit binds consumers by path shape).
export function buildOrgOwnershipOfferAcceptPath(orgId: string, offerId: string): string {
  return `/v1/orgs/${encodeURIComponent(orgId)}/ownership-offer/${encodeURIComponent(offerId)}/accept`;
}
export function buildOrgOwnershipOfferDeclinePath(orgId: string, offerId: string): string {
  return `/v1/orgs/${encodeURIComponent(orgId)}/ownership-offer/${encodeURIComponent(offerId)}/decline`;
}
export function buildOrgOwnershipOfferCancelPath(orgId: string, offerId: string): string {
  return `/v1/orgs/${encodeURIComponent(orgId)}/ownership-offer/${encodeURIComponent(offerId)}/cancel`;
}

/** `GET /v1/orgs/:id/ownership-offer` → the state; anything unreadable is "no offer". */
export function parseOrgOwnershipOffer(payload: unknown): OrgOwnershipOfferState {
  const d = obj(payload);
  const raw = obj(d.offer);
  const id = str(raw.id);
  const fromUserId = str(raw.fromUserId);
  const toUserId = str(raw.toUserId);
  const offer: OrgOwnershipOffer | null =
    id && fromUserId && toUserId
      ? {
          id,
          organizationId: str(raw.organizationId) ?? "",
          fromUserId,
          toUserId,
          status: str(raw.status) ?? "PENDING",
          expiresAtIso: str(raw.expiresAtUtc) ?? str(raw.expiresAt),
        }
      : null;
  return { offer, billingOwnerUserId: str(d.billingOwnerUserId) };
}

export type OrgOwnershipOfferSide = "recipient" | "offerer" | "none";

/** Which side of the offer the signed-in person is on. The server already filtered. */
export function orgOwnershipOfferSide(
  offer: OrgOwnershipOffer | null,
  viewerUserId: string | null,
): OrgOwnershipOfferSide {
  if (!offer || !viewerUserId) return "none";
  if (offer.toUserId === viewerUserId) return "recipient";
  if (offer.fromUserId === viewerUserId) return "offerer";
  return "none";
}

/** The web's refusal copy (OrgOwnershipOffer.tsx OFFER_REFUSAL_COPY), keyed by the server's code. */
export const ORG_OWNERSHIP_OFFER_REFUSAL_COPY: Readonly<Record<string, string>> = {
  ownership_offer_not_found: "This offer is no longer open to you. Nothing changed.",
  ownership_offer_not_pending: "This offer is no longer open. Nothing changed.",
  ownership_offer_expired: "This offer has expired. Ask the owner to make a new one.",
  ownership_offer_offerer_not_owner:
    "The person who made this offer no longer owns the organization, so it was withdrawn. Nothing changed.",
  OWNER_TARGET_NOT_ACTIVE: "Only an active member can become the owner. Nothing changed.",
  closure_in_progress:
    "A closure request for this organization is open. Ownership cannot change until it is cancelled.",
  WORKSPACE_SEAT_LIMIT_REACHED:
    "A workspace of this organization has no seat for this change, or you are suspended there. Nothing was transferred.",
};

/** The server's code inside an apiFetch error (nested `body.error.code` or flattened `code`). */
export function orgOwnershipOfferErrorCode(err: unknown): string | null {
  const e = obj(err);
  return str(obj(obj(e.body).error).code) ?? str(e.code);
}

/** The sentence for a refused accept/decline/cancel, or null for an unnamed failure. */
export function orgOwnershipOfferRefusal(err: unknown): string | null {
  const code = orgOwnershipOfferErrorCode(err);
  return code ? (ORG_OWNERSHIP_OFFER_REFUSAL_COPY[code] ?? null) : null;
}

export function orgOwnershipAcceptedCopy(orgName: string | null, billingOwnerLabel: string): string {
  return `You now own ${orgName || "this organization"}. Billing ownership did not change: the organization's billing owner is still ${billingOwnerLabel}.`;
}
export const ORG_OWNERSHIP_DECLINED_COPY = "Offer declined. Ownership did not change.";
export const ORG_OWNERSHIP_WITHDRAWN_COPY = "Offer withdrawn. Ownership did not change.";
export const ORG_OWNERSHIP_STEP_UP_TITLE = "Confirm accepting ownership of this organization.";

/**
 * A LINKED offer that the signed-in account cannot act on.
 *
 * The ownership-offer link names an organization and (optionally) the offer.
 * On a shared phone the account signed in may not be the one the offer was
 * made to; the server then answers `{ offer: null }` for that account, and the
 * screen must say so instead of rendering nothing — otherwise the person who
 * tapped "you have been offered ownership" sees an organization page with no
 * offer and no reason. Nothing about the offer (who, which account) is
 * revealed: the server told this account nothing, and neither does the copy.
 */
export function linkedOfferNotice(
  linkedOfferId: string | null,
  state: OrgOwnershipOfferState | null,
  viewerUserId: string | null,
  viewerEmail: string | null,
): string | null {
  if (!linkedOfferId || !state) return null;
  const side = orgOwnershipOfferSide(state.offer, viewerUserId);
  if (side !== "none" && state.offer?.id === linkedOfferId) return null;
  if (side !== "none" && state.offer && state.offer.id !== linkedOfferId) {
    return "The offer in this link is no longer open. The current offer for this organization is shown below.";
  }
  const who = viewerEmail ? ` (${viewerEmail})` : "";
  return `The ownership offer in this link is not open to the account you are signed in as${who}. It may have been accepted, declined, withdrawn or expired, or it was made to a different account — if so, sign out and sign in with that account.`;
}

/**
 * Where an ownership-offer link lands in the app: the organization screen,
 * carrying the offer it named. Both halves are opaque ids proven by the
 * screen's own authorized reads; a malformed id is no destination at all.
 */
export function orgOwnershipOfferRoute(orgId: string, offerId?: string | null): string | null {
  if (!isOrgUuid(orgId)) return null;
  const base = `/organizations/${encodeURIComponent(orgId)}`;
  return offerId && isOrgUuid(offerId) ? `${base}?ownershipOffer=${encodeURIComponent(offerId)}` : base;
}

/**
 * The authenticated WEB handoff, organization context preserved: the web's own
 * organization page renders the same offer panel (OrgOwnershipOffer.tsx). Used
 * when the phone cannot take the step-up the server asks for (an account with
 * no password and no authenticator: `reauth` only). The web session is its
 * own; nothing from the phone's session is put in the URL.
 */
export function orgOwnershipOfferWebUrl(origin: string | null, orgId: string): string | null {
  if (!origin || !/^https?:\/\//.test(origin) || !isOrgUuid(orgId)) return null;
  return `${origin.replace(/\/+$/, "")}/organizations/${encodeURIComponent(orgId)}`;
}
