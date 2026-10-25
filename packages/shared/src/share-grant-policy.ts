/**
 * SHARE-GRANT LIFETIME POLICY (members audit SEC-08, owner decision 2026-10-25).
 *
 * Applies to grants held in a person's name: an owner share link
 * (verification share token, purpose OWNER_SHARE) and an external-review
 * grant. It does NOT apply to the record's canonical Public Verify reference
 * (`pvr_`) or to the share token an issued report or package carries — those
 * belong to the record's publication state and have no time expiry.
 *
 *   - default lifetime 7 days, maximum self-service lifetime 30 days;
 *   - a grant never lives indefinitely: there is no "no expiry" choice;
 *   - extending one is an explicit, audited renewal (again at most 30 days
 *     from the moment of renewal).
 */
export const SHARE_GRANT_DEFAULT_LIFETIME_DAYS = 7;
export const SHARE_GRANT_MAX_LIFETIME_DAYS = 30;
