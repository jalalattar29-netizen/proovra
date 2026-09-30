/**
 * Lead adjudication for the remediation ledger. Lane reports (lanes/*.json) carry most rows;
 * DECISIONS here override or supply rows the lead implemented directly.
 */
export const AUDIT_BRANCH = "audit/universal-evidence-capture-truth";
export const AUDIT_SHA = "dae43b40";
export const AUDIT_REMOTE_STATUS =
  "NOT PUSHED — the push was refused by the session's permission classifier; the owner must push it (git push -u origin audit/universal-evidence-capture-truth)";
export const BASE_SHA = "47034f45403e87089b29571e3e702311c9d1a2a4";

/** id -> same shape as a lane finding row */
export const DECISIONS = {};
