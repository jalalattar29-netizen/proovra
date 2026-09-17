/**
 * PV-LANG-003 — product language for the stored identifiers the organization
 * and identity/security consoles render: org audit events, workspace roles,
 * permission keys, identity providers, access-review kinds, risk signals,
 * MFA factor kinds, SSO failure reasons, SCIM drift/failure codes, plans and
 * billing states.
 *
 * Each family keeps a curated map where the generic reading would mislead
 * ("AZURE_AD" is not "Azure ad", "identity.org_policy.read" is not a phrase)
 * and falls back to `identifierLabel`, so a value added on the server later
 * still reads as words rather than as a raw key.
 */

import { identifierLabel, type Permission } from "@proovra/shared";

function curated(map: Readonly<Record<string, string>>, value: string): string {
  return map[value] ?? identifierLabel(value);
}

// ---------------------------------------------------------------------------
// Organization audit events (services/api org-audit.service.ts catalog)
// ---------------------------------------------------------------------------

const ORG_AUDIT_EVENT_LABEL: Readonly<Record<string, string>> = {
  ORG_CREATED: "Organization created",
  ORG_UPDATED: "Organization details updated",
  ORG_MEMBER_INVITED: "Member invited",
  ORG_MEMBER_ACCEPTED: "Invitation accepted",
  ORG_MEMBER_ROLE_CHANGED: "Member role changed",
  ORG_MEMBER_REMOVED: "Member removed",
  ORG_MEMBER_LEFT: "Member left",
  ORG_OWNERSHIP_TRANSFERRED: "Ownership transferred",
  ORG_CLOSURE_REQUESTED: "Closure requested",
  ORG_CLOSURE_BLOCKED: "Closure blocked",
  ORG_CLOSURE_CANCELLED: "Closure cancelled",
  ORG_CLOSURE_COMPLETED: "Organization closed",
  ORG_SUSPENDED: "Organization suspended",
  ORG_RESUMED: "Organization resumed",
  ORG_INVITE_CREATED: "Invitation created",
  ORG_INVITE_ACCEPTED: "Invitation accepted",
  ORG_INVITE_REVOKED: "Invitation revoked",
  ORG_INVITE_RESENT: "Invitation resent",
  ORG_INVITE_ACCEPT_REJECTED: "Invitation acceptance rejected",
  ORG_INVITE_DELIVERY_ROTATED: "Invitation link replaced",
  ORG_POLICY_RETENTION_PUBLISHED: "Retention policy published",
  ORG_PLAN_GRANTED: "Plan granted",
  ENTERPRISE_PROVISIONED: "Enterprise customer provisioned",
  DOMAIN_ADDED: "Domain added",
  DOMAIN_VERIFIED: "Domain verified",
  DOMAIN_REMOVED: "Domain removed",
  ORG_REPORT_EXPORTED: "Report exported",
  ORG_BULK_INVITATION_STARTED: "Bulk invitation started",
  ORG_BULK_INVITATION_COMPLETED: "Bulk invitation completed",
};

export function orgAuditEventLabel(eventType: string): string {
  const known = ORG_AUDIT_EVENT_LABEL[eventType];
  if (known) return known;
  // The "ORG_" prefix names the table, not the event.
  return identifierLabel(eventType.replace(/^ORG_/, ""));
}

// ---------------------------------------------------------------------------
// Workspace roles — DB TeamRole plus the canonical permission-model roles
// ---------------------------------------------------------------------------

const WORKSPACE_ROLE_LABEL: Readonly<Record<string, string>> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MEMBER: "Member",
  VIEWER: "Viewer",
  REVIEWER: "Reviewer",
  CONTRIBUTOR: "Contributor",
  EXTERNAL_CONTRIBUTOR: "External contributor",
  PUBLIC_VERIFIER: "Public verifier",
};

export function workspaceRoleLabel(role: string): string {
  return curated(WORKSPACE_ROLE_LABEL, role);
}

// ---------------------------------------------------------------------------
// Permission keys (packages/shared permissions.ts). Typed on the full set so
// a new permission cannot ship without words.
// ---------------------------------------------------------------------------

const PERMISSION_LABEL: Readonly<Record<Permission, string>> = {
  "evidence.read": "View evidence",
  "evidence.create": "Create evidence",
  "evidence.update_metadata": "Update evidence metadata",
  "evidence.delete": "Delete evidence",
  "evidence.archive": "Archive evidence",
  "evidence.generate_report": "Generate evidence reports",
  "evidence.generate_package": "Generate evidence packages",
  "evidence.publish_verify": "Publish evidence for public verification",
  "evidence.download_original": "Download original evidence files",
  "evidence.download_report": "Download evidence reports",
  "evidence.download_package": "Download evidence packages",
  "workflow.template.manage": "Manage workflow templates",
  "workflow.intake_link.create": "Create intake links",
  "workflow.intake_link.revoke": "Revoke intake links",
  "workflow.external_submission.read": "View external submissions",
  "workflow.intake_recipient_contact.reveal": "Reveal intake recipient contact details",
  "evidence_request.create": "Create evidence requests",
  "evidence_request.assign": "Assign evidence requests",
  "evidence_request.review": "Review evidence requests",
  "evidence_request.close": "Close evidence requests",
  "evidence_request.cancel": "Cancel evidence requests",
  "notification.delivery.read": "View notification deliveries",
  "notification.delivery.resend": "Resend notifications",
  "governance.policy.read": "View governance policies",
  "governance.policy.manage": "Manage governance policies",
  "governance.legal_hold.manage": "Manage legal holds",
  "governance.retention.manage": "Manage retention governance",
  "audit.read": "View the audit log",
  "audit.export": "Export the audit log",
  "integration.api_key.manage": "Manage API keys",
  "integration.webhook.manage": "Manage webhooks",
  "integration.evidence.read": "View evidence through integrations",
  "integration.evidence.create": "Create evidence through integrations",
  "integration.evidence.upload": "Upload evidence through integrations",
  "integration.intake_link.create": "Create intake links through integrations",
  "integration.evidence_request.create": "Create evidence requests through integrations",
  "integration.evidence_request.read": "View evidence requests through integrations",
  "review.queue.read": "View the review queue",
  "review.assign": "Assign reviews",
  "review.decide": "Decide reviews",
  "review.escalate": "Escalate reviews",
  "review.reopen": "Reopen reviews",
  "review.sla.configure": "Configure review SLAs",
  "intelligence.read": "View intelligence results",
  "intelligence.run": "Run intelligence analysis",
  "intelligence.feedback.write": "Give intelligence feedback",
  "intelligence.policy.manage": "Manage intelligence policy",
  "collaboration.thread.read": "View discussion threads",
  "collaboration.thread.create": "Start discussion threads",
  "collaboration.message.post": "Post messages",
  "collaboration.thread.resolve": "Resolve discussion threads",
  "collaboration.thread.reopen": "Reopen discussion threads",
  "collaboration.thread.escalate": "Escalate discussion threads",
  "collaboration.contributor.access.manage": "Manage contributor access",
  "publication.public_verify.gate": "Control public verification",
  "retention.read": "View retention settings",
  "retention.configure": "Configure retention",
  "identity.member.read": "View members",
  "identity.member.invite": "Invite members",
  "identity.member.role.change": "Change member roles",
  "identity.member.suspend": "Suspend members",
  "identity.member.revoke": "Revoke member access",
  "identity.member.restore": "Restore members",
  "identity.capability.grant": "Grant capabilities",
  "identity.capability.revoke": "Revoke capabilities",
  "identity.delegated_admin.grant": "Grant delegated administration",
  "identity.delegated_admin.revoke": "Revoke delegated administration",
  "identity.service_account.manage": "Manage service accounts",
  "identity.service_account.disable": "Disable service accounts",
  "identity.contributor_session.revoke": "Revoke contributor sessions",
  "identity.org_policy.read": "View organization identity policy",
  "identity.sso.read": "View SSO settings",
  "identity.audit.read": "View the identity audit log",
  "identity.org_policy.manage": "Manage organization identity policy",
  "identity.access_review.read": "View access reviews",
  "identity.access_review.action": "Act on access reviews",
  "identity.external_mapping.read": "View external identity mappings",
  "identity.external_mapping.manage": "Manage external identity mappings",
  "billing.read": "View billing",
  "billing.manage": "Manage billing",
  "redaction.view": "View redactions",
  "redaction.region.author": "Author redaction regions",
  "redaction.detection.run": "Run redaction detection",
  "redaction.detection.review": "Review redaction detections",
  "redaction.version.submit": "Submit redacted versions",
  "redaction.version.approve": "Approve redacted versions",
  "redaction.version.publish": "Publish redacted versions",
  "redaction.derivative.download": "Download redacted copies",
  "redaction.administer": "Administer redaction",
  "operations.view": "View operations",
  "operations.acknowledge": "Acknowledge operations items",
  "operations.assign": "Assign operations items",
  "operations.resolve": "Resolve operations items",
  "operations.suppress": "Suppress operations items",
  "operations.saved_views.manage": "Manage saved operations views",
};

export function permissionLabel(permission: string): string {
  return curated(PERMISSION_LABEL, permission);
}

// ---------------------------------------------------------------------------
// Identity providers (ExternalIdentityProvider) — same words as the SSO console
// ---------------------------------------------------------------------------

const IDENTITY_PROVIDER_LABEL: Readonly<Record<string, string>> = {
  GENERIC_SAML: "Generic SAML",
  GENERIC_OIDC: "Generic OIDC",
  GENERIC_SCIM: "Generic SCIM",
  OKTA: "Okta",
  AZURE_AD: "Microsoft Entra ID",
  GOOGLE_WORKSPACE: "Google Workspace",
};

export function identityProviderLabel(provider: string): string {
  return curated(IDENTITY_PROVIDER_LABEL, provider);
}

// ---------------------------------------------------------------------------
// Access reviews, risk signals, MFA, session revocation
// ---------------------------------------------------------------------------

const ACCESS_REVIEW_KIND_LABEL: Readonly<Record<string, string>> = {
  PERIODIC_MEMBER_REVIEW: "Periodic member review",
  STALE_ACCESS: "Stale access",
  UNUSED_SERVICE_ACCOUNT: "Unused service account",
  EXPIRING_TEMPORARY_ACCESS: "Expiring temporary access",
  SUSPICIOUS_ACCESS_PATTERN: "Suspicious access pattern",
  EMERGENCY_REVOCATION_FOLLOWUP: "Emergency revocation follow-up",
};

export function accessReviewKindLabel(kind: string): string {
  return curated(ACCESS_REVIEW_KIND_LABEL, kind);
}

const RISK_SIGNAL_LABEL: Readonly<Record<string, string>> = {
  NEW_DEVICE: "New device",
  NEW_IP: "New IP address",
  NEW_USER_AGENT: "New browser or client",
  NEW_COUNTRY: "New country",
  IMPOSSIBLE_TRAVEL: "Impossible travel",
  FAILED_AUTH_BURST: "Repeated failed sign-ins",
  FAILED_OTP_BURST: "Repeated failed verification codes",
  SERVICE_ACCOUNT_NEW_IP: "Service account used from a new IP address",
  SERVICE_ACCOUNT_IP_ALLOWLIST_VIOLATION: "Service account outside its IP allowlist",
  CONTRIBUTOR_TOKEN_FAILURE_BURST: "Repeated contributor link failures",
  CONTRIBUTOR_REVOKED_ATTEMPT: "Revoked contributor tried to connect",
  SUSPENDED_MEMBER_ACTIVITY: "Activity by a suspended member",
  REVOKED_MEMBER_ACTIVITY: "Activity by a revoked member",
  EXCESSIVE_COMMUNICATION_SENDS: "Unusually many messages sent",
  PERMISSION_DENIED_BURST: "Repeated permission denials",
  WEBHOOK_INVALID_SIGNATURE_BURST: "Repeated invalid webhook signatures",
};

export function riskSignalLabel(kind: string): string {
  return curated(RISK_SIGNAL_LABEL, kind);
}

const MFA_FACTOR_KIND_LABEL: Readonly<Record<string, string>> = {
  TOTP: "Authenticator app",
  SMS: "Text message (SMS)",
  WHATSAPP: "WhatsApp",
};

export function mfaFactorKindLabel(kind: string): string {
  return curated(MFA_FACTOR_KIND_LABEL, kind);
}

const SESSION_REVOCATION_SCOPE_LABEL: Readonly<Record<string, string>> = {
  SINGLE_SESSION: "One session",
  ALL_FOR_USER: "All sessions",
};

export function sessionRevocationScopeLabel(scope: string): string {
  return curated(SESSION_REVOCATION_SCOPE_LABEL, scope);
}

// ---------------------------------------------------------------------------
// SSO health failure reasons and SAML mapping warnings
// ---------------------------------------------------------------------------

const SSO_FAILURE_REASON_LABEL: Readonly<Record<string, string>> = {
  invalid_signature: "Invalid signature",
  expired_certificate: "Expired certificate",
  audience_mismatch: "Audience mismatch",
  acs_mismatch: "Reply URL (ACS) mismatch",
  missing_nameid: "Missing NameID",
  missing_email: "Missing email attribute",
  clock_skew: "Clock skew",
  replay_detected: "Replayed assertion",
  idp_unreachable: "Identity provider unreachable",
  metadata_invalid: "Invalid metadata",
  unknown: "Unclassified failure",
};

export function ssoFailureReasonLabel(reason: string): string {
  return curated(SSO_FAILURE_REASON_LABEL, reason);
}

const SAML_MAPPING_WARNING_LABEL: Readonly<Record<string, string>> = {
  GROUP_ROLE_INCLUDES_OWNER_OR_ADMIN: "Grants owner or admin",
  GROUP_ROLE_OVERLAPS_SCIM: "Overlaps SCIM provisioning",
  DEFAULT_ROLE_DOWNGRADED: "Default role lowered",
  EMAIL_MAPPING_REMOVED: "Email mapping removed",
  EXTERNAL_ID_OVERRIDE_RISKY: "Risky external ID override",
};

export function samlMappingWarningLabel(code: string): string {
  return curated(SAML_MAPPING_WARNING_LABEL, code);
}

// ---------------------------------------------------------------------------
// SCIM reconciliation drift and sync failures
// ---------------------------------------------------------------------------

const SCIM_DRIFT_CATEGORY_LABEL: Readonly<Record<string, string>> = {
  ORPHAN_LOCAL_MEMBERSHIP: "Membership without a directory link",
  UNLINKED_IDENTITY_ACTIVE_USER: "Unlinked identity still has access",
  STALE_TOKEN: "Stale provisioning token",
  ORPHAN_SCIM_GROUP: "Orphaned directory group",
  DUPLICATE_EXTERNAL_SUBJECT: "Duplicate directory identity",
};

export function scimDriftCategoryLabel(category: string): string {
  return curated(SCIM_DRIFT_CATEGORY_LABEL, category);
}

const SCIM_FAILURE_LABEL: Readonly<Record<string, string>> = {
  scim_invalid_token: "Provisioning token rejected",
  scim_user_create_failed: "User creation failed",
  scim_user_deactivate_failed: "User deactivation failed",
  scim_group_membership_reconcile_failed: "Group membership sync failed",
};

export function scimFailureLabel(eventType: string): string {
  return curated(SCIM_FAILURE_LABEL, eventType);
}

// ---------------------------------------------------------------------------
// Workspace billing (Team.billingPlan / Team.billingStatus)
// ---------------------------------------------------------------------------

const PLAN_LABEL: Readonly<Record<string, string>> = {
  FREE: "Free",
  PAYG: "Pay as you go",
  PRO: "Pro",
  TEAM: "Team",
  ENTERPRISE: "Enterprise",
};

export function planLabel(plan: string): string {
  return curated(PLAN_LABEL, plan);
}

const WORKSPACE_BILLING_STATUS_LABEL: Readonly<Record<string, string>> = {
  INACTIVE: "Inactive",
  ACTIVE: "Active",
  // The billing surface's own word for PAST_DUE (billing/_sections/format.ts).
  PAST_DUE: "Payment failed",
  CANCELED: "Cancelled",
};

export function workspaceBillingStatusLabel(status: string): string {
  return curated(WORKSPACE_BILLING_STATUS_LABEL, status);
}

// ---------------------------------------------------------------------------
// Destruction reviews (shared DESTRUCTION_REVIEW_REASONS)
// ---------------------------------------------------------------------------

const DESTRUCTION_REASON_LABEL: Readonly<Record<string, string>> = {
  retention_expired: "Retention period ended",
  manual_review: "Manual review",
  policy_supersede: "Superseded by a newer policy",
};

export function destructionReasonLabel(reason: string): string {
  return curated(DESTRUCTION_REASON_LABEL, reason);
}
