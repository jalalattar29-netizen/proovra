/**
 * CANONICAL PERSONAL ATTENTION STATE (Attention Architecture, Phase 1).
 *
 * THE BOUNDARY THIS MODULE DEFENDS
 * --------------------------------
 * A notification answers ONE question:
 *
 *   "What happened that I personally should know about?"
 *
 * Every value in this module is therefore PER-USER and PER-USER ONLY. None of
 * it may ever be read as, migrated into, or projected onto shared workspace
 * truth. Concretely and permanently:
 *
 *   InboxItemState.dismissedAt  IS NOT  OperationalIncident.status = SUPPRESSED
 *
 * Those two columns look superficially similar — both mean "stop showing me
 * this" — and they are opposite in scope. One user deciding they have read a
 * message cannot decide, on behalf of an entire workspace, that unresolved
 * work no longer needs doing. That is the single most damaging conflation the
 * Attention Architecture exists to prevent, so the rule is stated in code
 * (`PERSONAL_STATE_IS_NEVER_SHARED_SUPPRESSION`) rather than in a comment
 * somebody can delete without a test noticing.
 *
 * THE SMALLEST STATE CONSISTENT WITH THE DATA
 * -------------------------------------------
 * The persisted columns are unchanged — `readAt`, `dismissedAt`,
 * `snoozedUntil` on `InboxItemState`, plus the mirrored trio on
 * `OperationsInboxSnapshot`. What changes is that they now project onto three
 * NAMED, INDEPENDENT axes instead of being interpreted ad hoc at each call
 * site:
 *
 *   readState  UNREAD | READ         — have I looked at this?
 *   lifecycle  ACTIVE | ARCHIVED     — is this still in my active feed?
 *   remindAt   Date | null           — I asked to be reminded later.
 *
 * They are independent on purpose. An item can be READ and ACTIVE (you read it
 * and left it), UNREAD and ARCHIVED (you filed it without reading), or ACTIVE
 * with a future `remindAt` (deferred, not filed). No state machine, no
 * transition table: three orthogonal facts about one person's relationship to
 * one message.
 *
 * PRODUCT VOCABULARY MIGRATION
 * ----------------------------
 * The product said `dismiss` and `snooze`. Both are wrong for a notification
 * center, and both were wrong in the direction of operations:
 *
 *   dismiss -> ARCHIVE          "dismiss" reads as adjudication ("this does
 *                               not matter"); "archive" reads as filing,
 *                               which is what it actually does — nothing
 *                               shared changes.
 *   snooze  -> REMIND ME LATER  same write, honest name.
 *
 * `dismissedAt` / `snoozedUntil` remain the PERSISTED column names so no data
 * migration is required and every historical row stays interpretable exactly
 * as it was written. The rename is a product-semantics rename, carried by this
 * module and by API aliases, not a schema rewrite.
 */

/** Have I looked at this message? */
export type NotificationReadState = "UNREAD" | "READ";

/**
 * Is this message in my active feed?
 *
 * ARCHIVED is filing, and filing is personal. It hides a row from ONE user's
 * default view. It does not resolve, suppress, acknowledge, close, or
 * otherwise touch anything another user can see.
 */
export type NotificationLifecycle = "ACTIVE" | "ARCHIVED";

export type PersonalAttentionState = {
  readState: NotificationReadState;
  lifecycle: NotificationLifecycle;
  /**
   * "Remind me later" — the product name for the persisted `snoozedUntil`.
   * ISO string when a reminder is set (past OR future); null when none is.
   */
  remindAt: string | null;
  /**
   * True when a reminder is set AND has not yet come due. This is the only
   * derived-from-clock value here, so callers never re-implement the
   * comparison and disagree about "is it still deferred".
   */
  deferred: boolean;
};

/**
 * The persisted shape. Matches both `InboxItemState` and the mirrored columns
 * on `OperationsInboxSnapshot`, so one derivation serves the live feed and the
 * history view — the two surfaces that must never disagree about whether you
 * have read something.
 */
export type PersistedAttentionColumns = {
  readAt: Date | string | null | undefined;
  /** PERSISTED NAME. Product name: archived. */
  dismissedAt: Date | string | null | undefined;
  /** PERSISTED NAME. Product name: remind-at. */
  snoozedUntil: Date | string | null | undefined;
};

function toMs(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * PURE derivation of the three axes from the persisted columns.
 *
 * Exported and unit-tested without a database, for the same reason
 * `deriveEnterpriseAuthority` is: the rule is the product, and a rule that can
 * only be exercised through a live Postgres is a rule nobody exercises.
 */
export function derivePersonalAttentionState(
  columns: PersistedAttentionColumns | null | undefined,
  now: Date,
): PersonalAttentionState {
  const nowMs = now.getTime();
  const readAtMs = toMs(columns?.readAt);
  const archivedAtMs = toMs(columns?.dismissedAt);
  const remindAtMs = toMs(columns?.snoozedUntil);

  return {
    readState: readAtMs != null ? "READ" : "UNREAD",
    lifecycle: archivedAtMs != null ? "ARCHIVED" : "ACTIVE",
    remindAt: toIso(columns?.snoozedUntil),
    deferred: remindAtMs != null && remindAtMs > nowMs,
  };
}

/**
 * Is this notification in the recipient's ACTIVE feed right now?
 *
 * Archived rows are filed. Deferred rows are waiting for their reminder. Both
 * are personal decisions, and neither says anything about whether the
 * underlying work still needs doing.
 */
export function isActiveForRecipient(state: PersonalAttentionState): boolean {
  return state.lifecycle === "ACTIVE" && !state.deferred;
}

/** Active AND not yet read — the one definition of the bell's population. */
export function isUnreadActive(state: PersonalAttentionState): boolean {
  return isActiveForRecipient(state) && state.readState === "UNREAD";
}

/**
 * THE INVARIANT, STATED AS CODE.
 *
 * Any surface that is about to translate a personal attention decision into a
 * shared workspace decision is, by construction, wrong. This constant exists
 * so the rule can be asserted by a test rather than trusted to a comment: it
 * answers "may this personal action change shared operational truth?" and the
 * answer is permanently, unconditionally, no.
 *
 * If a future requirement genuinely needs "everyone stop seeing this", that is
 * an OPERATIONS action (`OPERATIONS_SUPPRESS`, adjudicated on the shared
 * condition by an authorized operator, with an event written to the condition
 * history). It is never reached by archiving a notification.
 */
export const PERSONAL_STATE_IS_NEVER_SHARED_SUPPRESSION = false as const;

/**
 * Personal actions, named the way the product now names them. The right-hand
 * value is the PERSISTED column each one writes, so the compatibility mapping
 * lives in one table instead of being rediscovered at each endpoint.
 */
export const PERSONAL_ATTENTION_ACTIONS = {
  read: "readAt",
  unread: "readAt",
  /** Product name for the legacy `dismiss` action. */
  archive: "dismissedAt",
  /** Restores an archived notification to the active feed. */
  unarchive: "dismissedAt",
  /** Product name for the legacy `snooze` action. */
  remind: "snoozedUntil",
} as const;

export type PersonalAttentionAction = keyof typeof PERSONAL_ATTENTION_ACTIONS;

/**
 * LEGACY ACTION NAME -> CANONICAL ACTION NAME.
 *
 * Shipped clients call `/dismiss` and `/snooze`. Those URLs keep working and
 * resolve through this table, so there is exactly one implementation behind
 * both names and they cannot drift apart.
 */
export const LEGACY_ACTION_ALIASES: Readonly<
  Record<string, PersonalAttentionAction>
> = {
  dismiss: "archive",
  undismiss: "unarchive",
  snooze: "remind",
};
