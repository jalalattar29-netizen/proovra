/**
 * Intake links — the wire shapes this route reads.
 *
 * Mirrors `IntakeLinkListItem` in
 * `services/api/src/services/intake-link-lifecycle.service.ts` and the
 * projections in `workflow-intake-link.service.ts`. Kept in one place so the
 * list, the drawers, the wizard and the tests all describe the same envelope.
 */

/** `GET /v1/workflow/intake-links` → `items[]`. */
export type IntakeLinkListItem = {
  link: {
    id: string;
    teamId: string;
    workflowTemplateSlug: string;
    workflowTemplateVersion: number;
    workflowTemplateName: string;
    intakeMode: string;
    caseId: string | null;
    recipientLabel: string | null;
    /** The organization's identifier for its customer. Its own concept. */
    customerId: string | null;
    /** Masked, by the same platform policy the row projection uses. */
    recipientEmailPreview: string | null;
    recipientPhonePreview: string | null;
    /** Raw — populated only for a caller the server resolved as authorized. */
    recipientEmail?: string | null;
    recipientPhone?: string | null;
    hasRecipientEmail?: boolean;
    hasRecipientPhone?: boolean;
    recipientContactRevealAuthorized?: boolean;
    maxUses: number;
    usedCount: number;
    status: string;
    expiresAtUtc: string;
    revokedAtUtc: string | null;
    revokedReason: string | null;
    archivedAtUtc: string | null;
    createdAt: string;
    updatedAt: string;
  };
  delivery: {
    latestStatus: string | null;
    latestChannel: string | null;
    latestAtUtc: string | null;
    latestSentAtUtc: string | null;
    latestDeliveredAtUtc: string | null;
    latestFailedAtUtc: string | null;
    latestErrorCode: string | null;
    attemptCount: number;
    channelsAttempted: string[];
    latestProviderMessageId: string | null;
  };
  activity: {
    firstOpenedAtUtc: string | null;
    lastOpenedAtUtc: string | null;
    firstStartedAtUtc: string | null;
    lastStartedAtUtc: string | null;
    firstSubmittedAtUtc: string | null;
    lastSubmittedAtUtc: string | null;
    sessionsCreated: number;
    sessionsOpened: number;
    sessionsStarted: number;
    sessionsSubmitted: number;
    sessionsExpired: number;
    sessionsRevoked: number;
    evidenceCount: number;
  };
  /**
   * The backend's single conflated enum. Preserved on the wire and echoed onto
   * the row as a `data-*` probe, but NEVER used to decide what the operator
   * reads — the three orthogonal axes in `lib/intake-links/state-model` are.
   */
  computedLifecycle:
    | "CREATED"
    | "SENT"
    | "DELIVERY_FAILED"
    | "OPENED"
    | "STARTED"
    | "SUBMITTED"
    | "EXPIRED"
    | "REVOKED";
};

/** The bare row projection returned by create / revoke / archive. */
export type IntakeLinkRow = {
  id: string;
  teamId: string;
  workflowTemplateSlug: string;
  workflowTemplateVersion: number;
  intakeMode: string;
  caseId: string | null;
  recipientLabel: string | null;
  /**
   * Masked. The raw address and number are not part of any projection — a
   * caller with the authority fetches them from
   * POST /v1/workflow/intake-links/:id/recipient-contact.
   */
  recipientEmailMasked: string | null;
  recipientPhoneMasked: string | null;
  hasRecipientEmail: boolean;
  hasRecipientPhone: boolean;
  recipientContactRevealAuthorized: boolean;
  maxUses: number;
  usedCount: number;
  maxFileCountPerSession: number | null;
  maxBytesPerSession: string | null;
  allowedAcceptedKinds: string[];
  consentPolicyVersion: string | null;
  status: string;
  expiresAtUtc: string;
  revokedAtUtc: string | null;
  revokedReason: string | null;
  createdAt: string;
  updatedAt: string;
};

/** `POST /v1/workflow/intake-links` response. */
export type CreatedIntakeLink = {
  link: IntakeLinkRow;
  rawToken: string;
  delivery: {
    method: "MANUAL" | "EMAIL" | "SMS" | "WHATSAPP";
    status: "sent" | "failed" | "skipped";
    communicationMessageId?: string | null;
    reason?: string | null;
  };
};

/** `GET /v1/workflow/intake-links/:id/submissions`. */
export type IntakeSubmissionSession = {
  id: string;
  status: string;
  submitterDisplayName: string | null;
  submitterEmailPreview: string | null;
  submitterPhonePreview: string | null;
  pseudonym: string | null;
  openedAtUtc: string | null;
  uploadStartedAtUtc: string | null;
  uploadCompletedAtUtc: string | null;
  submittedAtUtc: string | null;
  abandonedAtUtc: string | null;
  revokedAtUtc: string | null;
  expiresAtUtc: string;
  consentAcceptedAtUtc: string | null;
  evidenceId: string | null;
};

export type IntakeSubmissionsPayload = {
  link: {
    id: string;
    teamId: string;
    intakeMode: string;
    recipientLabel: string | null;
    workflowTemplateSlug: string;
    workflowTemplateName: string;
  };
  sessions: IntakeSubmissionSession[];
  totals: {
    sessions: number;
    submitted: number;
    inProgress: number;
    evidenceProduced: number;
  };
};

/** `GET /v1/workflow/templates`. */
export type WorkflowTemplateRow = {
  id: string;
  slug: string;
  source: string;
  version: number;
  name: string;
  description: string;
  planMode: string;
  intakeModes: string[];
  archived: boolean;
};

/**
 * `GET /v1/workflow/intake-links/sender-identity` — the SAFE transport preview.
 * Never carries provider secrets; `configured: false` is the authority for
 * "this channel cannot actually deliver from this deployment".
 */
export type SenderTransportChannel = {
  configured: boolean;
  fromName?: string;
  fromAddressPreview?: string;
  fromNumberPreview?: string | null;
  displayName?: string;
};

export type SenderTransportInfo = {
  email: SenderTransportChannel;
  sms: SenderTransportChannel;
  whatsapp: SenderTransportChannel;
};

/** `GET /v1/communications/messages?relatedIntakeLinkId=…`. */
export type CommunicationMessageRow = {
  id: string;
  channel: "SMS" | "WHATSAPP" | "EMAIL";
  purpose: string;
  status:
    | "QUEUED"
    | "SENT"
    | "DELIVERED"
    | "FAILED"
    | "UNDELIVERED"
    | "RETRY_SCHEDULED"
    | "CANCELLED";
  provider: string;
  recipientPreview: string | null;
  bodyPreview: string | null;
  attemptCount: number;
  createdAt: string;
  sentAtUtc: string | null;
  deliveredAtUtc: string | null;
  failedAtUtc: string | null;
  nextAttemptAtUtc: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};
