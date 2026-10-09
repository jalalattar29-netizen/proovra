/**
 * THE HEADER EACH MACHINE-TO-MACHINE CONTRACT USES. One name per contract.
 *
 * OPS-006 — the worker called the integration cron routes with `x-cron-secret`
 * while the API authenticated `x-proovra-integration-cron-secret`, so every
 * invite-retry and automation-dispatch sweep was refused with 401 whatever the
 * secret values. The caller and the verifier each spelled the header from
 * memory. They now import the SAME constant from here, so a contract cannot
 * have two spellings again.
 *
 * Header NAMES only. Secret values are read from the environment at each end
 * and are never logged.
 */

/** Integration cron routes (`requireIntegrationCronSecret`). Secret: INTEGRATION_CRON_SECRET. */
export const INTEGRATION_CRON_HEADER = "x-proovra-integration-cron-secret";

/** Notification cron routes (`requireNotificationCronSecret`). Secret: NOTIFICATION_CRON_SECRET. */
export const NOTIFICATION_CRON_HEADER = "x-proovra-cron-secret";

/**
 * Reviewer-operations reconcile and the identity machine sweeps. Secret:
 * REVIEWER_OPS_CRON_SECRET (falling back to INTEGRATION_CRON_SECRET at the
 * verifier). A separate contract from the integration routes, with its own
 * documented header.
 */
export const REVIEWER_OPS_CRON_HEADER = "x-cron-secret";
