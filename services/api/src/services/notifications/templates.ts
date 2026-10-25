/**
 * Phase 8 — Notification template renderer.
 *
 * Pure. No I/O. The renderer is the privacy boundary: every field that
 * reaches an outgoing email body MUST be one of the explicitly-passed
 * fields below. Reviewer notes, raw tokens, token hashes, IP/UA, and
 * other workspace internals are not in the type — so they cannot be
 * accidentally rendered.
 *
 * Wording rule: every template avoids truth claims (authentic /
 * admissible / proven). PROOVRA notifications are operational; they do
 * not assert anything about the evidence content.
 */

import {
  escapeEmailHtml,
  getEmailBrandName,
  getEmailWebBaseUrl,
  renderEmailShell,
} from "../email.service.js";
import type { NotificationEventType } from "@proovra/shared";
import { formatTimestampForReportUtc } from "@proovra/shared";

// -----------------------------------------------------------------------------
// Per-event template context shapes — strictly typed to enforce the
// "never leak internals" rule. Adding a new field requires explicit
// review.
// -----------------------------------------------------------------------------

export type EvidenceRequestTemplateContext = {
  workspaceName: string;
  requestTitle: string;
  requestInstructions: string | null;
  dueAtUtcIso: string | null;
  // Intake URL is the only token-bearing field — it is the contributor's
  // entry point. Token hash NEVER appears.
  intakeUrl: string | null;
  // What the recipient is being asked to provide.
  deliverableSummaries: Array<{
    title: string;
    required: boolean;
  }>;
};

export type EvidenceRequestResponseReceivedContext = {
  workspaceName: string;
  requestTitle: string;
  // Deep link to the authenticated evidence detail view.
  evidenceUrl: string | null;
};

export type EvidenceRequestNeedsMoreInfoContext = {
  workspaceName: string;
  requestTitle: string;
  // Operator-facing safe summary — NOT the raw reviewer note.
  // Templates accept a single safe-to-show "context message" already
  // sanitized by the caller.
  contextMessage: string;
  intakeUrl: string | null;
};

export type ReviewRequestAssignedContext = {
  workspaceName: string;
  requestTitle: string;
  reviewerName: string | null;
  requestUrl: string | null;
};

export type ExternalIntakeLinkCreatedContext = {
  workspaceName: string;
  intakeUrl: string;
  expiresAtUtcIso: string | null;
};

export type ExternalIntakeSubmittedContext = {
  workspaceName: string;
  evidenceUrl: string | null;
  intakeMode: string;
};

export type EvidenceRequestSimpleContext = {
  workspaceName: string;
  requestTitle: string;
};

/**
 * Operations Center digest — bounded list of item TITLES + categories the
 * recipient was already authorized to see when the item surfaced. Never
 * raw content, never other users' data, never admin-only enrichment.
 */
export type OperationsDigestContext = {
  workspaceName: string;
  cadenceLabel: string; // "Hourly" | "Daily" | "Weekly"
  items: Array<{ title: string; category: string; severity: string }>;
  totalUnread: number;
  operationsCenterUrl: string | null;
};

/**
 * Members & access lifecycle (members audit AUD-04). The workspace name, the
 * change, and — for a role change — the new role's display label. Nothing
 * else: no other member, no actor identity, no reason text.
 */
export type MembershipLifecycleContext = {
  workspaceName: string;
  roleLabel: string | null;
  actionUrl: string | null;
};

// Discriminated union the renderer accepts. Adding an event type means
// adding both an entry here and a renderer branch below.
export type TemplateContext =
  | { kind: "EvidenceRequest"; data: EvidenceRequestTemplateContext }
  | { kind: "ResponseReceived"; data: EvidenceRequestResponseReceivedContext }
  | { kind: "NeedsMoreInfo"; data: EvidenceRequestNeedsMoreInfoContext }
  | { kind: "ReviewAssigned"; data: ReviewRequestAssignedContext }
  | { kind: "IntakeLinkCreated"; data: ExternalIntakeLinkCreatedContext }
  | { kind: "IntakeSubmitted"; data: ExternalIntakeSubmittedContext }
  | { kind: "Simple"; data: EvidenceRequestSimpleContext }
  | { kind: "OperationsDigest"; data: OperationsDigestContext }
  | { kind: "MembershipLifecycle"; data: MembershipLifecycleContext };

export type RenderedTemplate = {
  subject: string;
  html: string;
  text: string;
  plaintextPreview: string;
};

// -----------------------------------------------------------------------------
// renderTransactionalTemplate
// -----------------------------------------------------------------------------

export function renderTransactionalTemplate(
  eventType: NotificationEventType,
  ctx: TemplateContext,
): RenderedTemplate {
  switch (eventType) {
    case "EVIDENCE_REQUEST_SENT":
      return renderEvidenceRequestSent(expectCtx(ctx, "EvidenceRequest"));
    case "EVIDENCE_REQUEST_REMINDER":
      return renderEvidenceRequestReminder(expectCtx(ctx, "EvidenceRequest"));
    case "EVIDENCE_REQUEST_RESPONSE_RECEIVED":
      return renderResponseReceived(expectCtx(ctx, "ResponseReceived"));
    case "EVIDENCE_REQUEST_NEEDS_MORE_INFO":
      return renderNeedsMoreInfo(expectCtx(ctx, "NeedsMoreInfo"));
    case "EVIDENCE_REQUEST_FULFILLED":
      return renderRequestStatusUpdate(
        expectCtx(ctx, "Simple"),
        "fulfilled",
      );
    case "EVIDENCE_REQUEST_CANCELLED":
      return renderRequestStatusUpdate(
        expectCtx(ctx, "Simple"),
        "cancelled",
      );
    case "EVIDENCE_REQUEST_CLOSED":
      return renderRequestStatusUpdate(expectCtx(ctx, "Simple"), "closed");
    case "REVIEW_REQUEST_ASSIGNED":
      return renderReviewAssigned(expectCtx(ctx, "ReviewAssigned"));
    // Phase 13 — extra review-operations templates. All reuse the
    // ReviewAssigned context shape (which already includes workspace
    // name + request title + url). We adjust the subject line below
    // to reflect the action; private review notes are NEVER emitted.
    case "REVIEW_REASSIGNED":
      return renderReviewVariant(
        expectCtx(ctx, "ReviewAssigned"),
        "Review reassigned",
        "You have been assigned as the new reviewer",
      );
    case "REVIEW_ESCALATED":
      return renderReviewVariant(
        expectCtx(ctx, "ReviewAssigned"),
        "Review escalated",
        "A review you own has been escalated",
      );
    case "REVIEW_OVERDUE_REMINDER":
      return renderReviewVariant(
        expectCtx(ctx, "ReviewAssigned"),
        "Review overdue",
        "A review you own is past its due date",
      );
    case "REVIEW_NEEDS_MORE_INFO":
      return renderReviewVariant(
        expectCtx(ctx, "ReviewAssigned"),
        "Review needs more information",
        "Additional information has been requested",
      );
    case "REVIEW_RESPONSE_RECEIVED":
      return renderReviewVariant(
        expectCtx(ctx, "ReviewAssigned"),
        "Review response received",
        "A response has been received on a review you own",
      );
    case "EXTERNAL_INTAKE_LINK_CREATED":
      return renderIntakeLinkCreated(expectCtx(ctx, "IntakeLinkCreated"));
    case "EXTERNAL_INTAKE_SUBMITTED":
      return renderIntakeSubmitted(expectCtx(ctx, "IntakeSubmitted"));
    case "OPERATIONS_DIGEST":
      return renderOperationsDigest(expectCtx(ctx, "OperationsDigest"));
    // Phase 16 — collaboration variants reuse the ReviewAssigned
    // context shape so bodies stay workspace-only (no message text,
    // no thread internals).
    case "DISCUSSION_MENTION_RECEIVED":
      return renderReviewVariant(
        expectCtx(ctx, "ReviewAssigned"),
        "You were mentioned",
        "You were @mentioned in a workspace discussion",
      );
    case "DISCUSSION_REPLY_RECEIVED":
      return renderReviewVariant(
        expectCtx(ctx, "ReviewAssigned"),
        "Discussion reply",
        "A discussion you participate in has a new reply",
      );
    case "DISCUSSION_RESOLVED":
      return renderReviewVariant(
        expectCtx(ctx, "ReviewAssigned"),
        "Discussion resolved",
        "A discussion you participate in has been resolved",
      );
    case "DISCUSSION_REOPENED":
      return renderReviewVariant(
        expectCtx(ctx, "ReviewAssigned"),
        "Discussion reopened",
        "A discussion you participate in has been reopened",
      );
    case "CONTRIBUTOR_REPLY_RECEIVED":
      return renderReviewVariant(
        expectCtx(ctx, "ReviewAssigned"),
        "Contributor reply",
        "An external contributor replied on a discussion you own",
      );
    case "WORKSPACE_ACCESS_REMOVED":
    case "WORKSPACE_ACCESS_SUSPENDED":
    case "WORKSPACE_ACCESS_RESTORED":
    case "WORKSPACE_ROLE_CHANGED":
    case "WORKSPACE_OWNERSHIP_RECEIVED":
    case "WORKSPACE_CLOSED":
    case "ACCOUNT_CLOSED":
      return renderMembershipLifecycle(eventType, expectCtx(ctx, "MembershipLifecycle"));
    default: {
      const _exhaustive: never = eventType;
      throw new Error(
        `renderTransactionalTemplate: no renderer for ${_exhaustive}`,
      );
    }
  }
}

// Type-safe context extractor. Each overload returns the precise data
// shape for the requested kind. Using overloads instead of `Extract<>`
// because TypeScript cannot narrow Extract<> conditionally inside a
// generic function body, but it CAN match overloads at the call site.
function expectCtx(ctx: TemplateContext, kind: "EvidenceRequest"): EvidenceRequestTemplateContext;
function expectCtx(ctx: TemplateContext, kind: "ResponseReceived"): EvidenceRequestResponseReceivedContext;
function expectCtx(ctx: TemplateContext, kind: "NeedsMoreInfo"): EvidenceRequestNeedsMoreInfoContext;
function expectCtx(ctx: TemplateContext, kind: "ReviewAssigned"): ReviewRequestAssignedContext;
function expectCtx(ctx: TemplateContext, kind: "IntakeLinkCreated"): ExternalIntakeLinkCreatedContext;
function expectCtx(ctx: TemplateContext, kind: "IntakeSubmitted"): ExternalIntakeSubmittedContext;
function expectCtx(ctx: TemplateContext, kind: "Simple"): EvidenceRequestSimpleContext;
function expectCtx(ctx: TemplateContext, kind: "OperationsDigest"): OperationsDigestContext;
function expectCtx(ctx: TemplateContext, kind: "MembershipLifecycle"): MembershipLifecycleContext;
function expectCtx(ctx: TemplateContext, kind: TemplateContext["kind"]): unknown {
  if (ctx.kind !== kind) {
    throw new Error(
      `renderTransactionalTemplate: expected context kind "${kind}" but got "${ctx.kind}"`,
    );
  }
  return ctx.data;
}

// -----------------------------------------------------------------------------
// Individual renderers
// -----------------------------------------------------------------------------

function renderEvidenceRequestSent(
  d: EvidenceRequestTemplateContext,
): RenderedTemplate {
  const app = getEmailBrandName();
  const workspaceName = escapeEmailHtml(d.workspaceName);
  const title = escapeEmailHtml(d.requestTitle);
  const instructions = d.requestInstructions
    ? escapeEmailHtml(d.requestInstructions)
    : "";
  const due = d.dueAtUtcIso
    ? `<div style="margin:0 0 12px 0;"><strong>Please respond by:</strong> ${escapeEmailHtml(
        formatTimestampForReportUtc(d.dueAtUtcIso),
      )}</div>`
    : "";
  const deliverableList =
    d.deliverableSummaries.length > 0
      ? `
        <div style="margin:0 0 12px 0;"><strong>What's needed:</strong></div>
        <ul style="margin:0 0 16px 18px; padding:0;">
          ${d.deliverableSummaries
            .map(
              (item) =>
                `<li style="margin:0 0 6px 0;">${escapeEmailHtml(item.title)}${item.required ? " (required)" : ""}</li>`,
            )
            .join("")}
        </ul>
      `
      : "";

  const body = `
    <div style="margin:0 0 12px 0;">
      <strong>${workspaceName}</strong> has asked you to provide evidence
      using a secure ${escapeEmailHtml(app)} link.
    </div>
    <div style="margin:0 0 12px 0;"><strong>Request:</strong> ${title}</div>
    ${instructions ? `<div style="margin:0 0 12px 0;">${instructions}</div>` : ""}
    ${due}
    ${deliverableList}
    <div style="margin:0 0 12px 0; color:#64748b; font-size:13px;">
      The link below is unique to this request. Please do not share it.
    </div>
  `.trim();

  const html = renderEmailShell({
    title: `Evidence requested by ${d.workspaceName}`,
    preheader: `${d.workspaceName} is asking you to submit evidence securely.`,
    bodyHtml: body,
    ctaText: d.intakeUrl ? "Open secure upload page" : undefined,
    ctaUrl: d.intakeUrl ?? undefined,
    secondaryText:
      "If you didn't expect this request, you can ignore this email.",
  });

  const text = [
    `Evidence requested by ${d.workspaceName}`,
    "",
    `Request: ${d.requestTitle}`,
    d.requestInstructions ? "" : null,
    d.requestInstructions ?? "",
    d.dueAtUtcIso
      ? `Please respond by: ${formatTimestampForReportUtc(d.dueAtUtcIso)}`
      : null,
    d.deliverableSummaries.length > 0 ? "" : null,
    d.deliverableSummaries.length > 0 ? "What's needed:" : null,
    ...d.deliverableSummaries.map(
      (item) => `  - ${item.title}${item.required ? " (required)" : ""}`,
    ),
    "",
    d.intakeUrl ? `Secure upload link: ${d.intakeUrl}` : null,
    "",
    "If you didn't expect this request, you can safely ignore this email.",
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");

  return {
    subject: `Evidence requested by ${d.workspaceName}`,
    html,
    text,
    plaintextPreview: text.slice(0, 2000),
  };
}

function renderEvidenceRequestReminder(
  d: EvidenceRequestTemplateContext,
): RenderedTemplate {
  const base = renderEvidenceRequestSent(d);
  return {
    ...base,
    subject: `Reminder: ${base.subject}`,
  };
}

function renderResponseReceived(
  d: EvidenceRequestResponseReceivedContext,
): RenderedTemplate {
  const workspaceName = escapeEmailHtml(d.workspaceName);
  const title = escapeEmailHtml(d.requestTitle);
  const body = `
    <div style="margin:0 0 12px 0;">
      A response has been submitted for the request
      <strong>${title}</strong> in ${workspaceName}.
    </div>
    <div style="margin:0 0 12px 0;">
      Open the request to review the submitted materials and record your
      decision.
    </div>
    <div style="margin:0 0 12px 0; color:#64748b; font-size:13px;">
      Submission of a response does not assert authenticity or legal
      admissibility. Your review decision is recorded for internal
      workflow tracking only.
    </div>
  `.trim();

  const html = renderEmailShell({
    title: "Response received",
    preheader: `New submission for "${d.requestTitle}".`,
    bodyHtml: body,
    ctaText: d.evidenceUrl ? "Open in review queue" : undefined,
    ctaUrl: d.evidenceUrl ?? undefined,
  });

  const text = [
    `Response received for "${d.requestTitle}"`,
    "",
    `Workspace: ${d.workspaceName}`,
    d.evidenceUrl ? `Open in review queue: ${d.evidenceUrl}` : null,
    "",
    "Submission of a response does not assert authenticity or legal admissibility.",
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");

  return {
    subject: `Response received: ${d.requestTitle}`,
    html,
    text,
    plaintextPreview: text.slice(0, 2000),
  };
}

function renderNeedsMoreInfo(
  d: EvidenceRequestNeedsMoreInfoContext,
): RenderedTemplate {
  const workspaceName = escapeEmailHtml(d.workspaceName);
  const title = escapeEmailHtml(d.requestTitle);
  const contextMessage = escapeEmailHtml(d.contextMessage);
  const body = `
    <div style="margin:0 0 12px 0;">
      <strong>${workspaceName}</strong> has reviewed the materials submitted
      for the request <strong>${title}</strong> and is asking for additional
      context.
    </div>
    <div style="margin:0 0 12px 0;">${contextMessage}</div>
    ${
      d.intakeUrl
        ? `<div style="margin:0 0 12px 0;">You can return to the secure upload page using the button below.</div>`
        : ""
    }
  `.trim();

  const html = renderEmailShell({
    title: "Additional information requested",
    preheader: `${d.workspaceName} needs more context for "${d.requestTitle}".`,
    bodyHtml: body,
    ctaText: d.intakeUrl ? "Open secure upload page" : undefined,
    ctaUrl: d.intakeUrl ?? undefined,
  });

  const text = [
    `Additional information requested: ${d.requestTitle}`,
    "",
    d.contextMessage,
    "",
    d.intakeUrl ? `Secure upload link: ${d.intakeUrl}` : null,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");

  return {
    subject: `Additional information requested: ${d.requestTitle}`,
    html,
    text,
    plaintextPreview: text.slice(0, 2000),
  };
}

function renderRequestStatusUpdate(
  d: EvidenceRequestSimpleContext,
  decision: "fulfilled" | "cancelled" | "closed",
): RenderedTemplate {
  const labels: Record<typeof decision, string> = {
    fulfilled: "Fulfilled",
    cancelled: "Cancelled",
    closed: "Closed",
  };
  const workspaceName = escapeEmailHtml(d.workspaceName);
  const title = escapeEmailHtml(d.requestTitle);
  const body = `
    <div style="margin:0 0 12px 0;">
      The request <strong>${title}</strong> in ${workspaceName} has been
      marked <strong>${labels[decision]}</strong>.
    </div>
  `.trim();
  const html = renderEmailShell({
    title: `Request ${labels[decision].toLowerCase()}`,
    preheader: `"${d.requestTitle}" — ${labels[decision]}.`,
    bodyHtml: body,
  });
  const text = [
    `Request ${labels[decision].toLowerCase()}: ${d.requestTitle}`,
    "",
    `Workspace: ${d.workspaceName}`,
  ].join("\n");
  return {
    subject: `Request ${labels[decision].toLowerCase()}: ${d.requestTitle}`,
    html,
    text,
    plaintextPreview: text.slice(0, 2000),
  };
}

function renderReviewAssigned(
  d: ReviewRequestAssignedContext,
): RenderedTemplate {
  const workspaceName = escapeEmailHtml(d.workspaceName);
  const title = escapeEmailHtml(d.requestTitle);
  const body = `
    <div style="margin:0 0 12px 0;">
      You have been assigned as the reviewer for the request
      <strong>${title}</strong> in ${workspaceName}.
    </div>
  `.trim();
  const html = renderEmailShell({
    title: "You have a new review assignment",
    preheader: `Assigned: "${d.requestTitle}".`,
    bodyHtml: body,
    ctaText: d.requestUrl ? "Open the request" : undefined,
    ctaUrl: d.requestUrl ?? undefined,
  });
  const text = [
    `New review assignment: ${d.requestTitle}`,
    "",
    `Workspace: ${d.workspaceName}`,
    d.requestUrl ? `Open: ${d.requestUrl}` : null,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
  return {
    subject: `Assigned: ${d.requestTitle}`,
    html,
    text,
    plaintextPreview: text.slice(0, 2000),
  };
}

function renderReviewVariant(
  d: ReviewRequestAssignedContext,
  subjectPrefix: string,
  headline: string,
): RenderedTemplate {
  const workspaceName = escapeEmailHtml(d.workspaceName);
  const title = escapeEmailHtml(d.requestTitle);
  const headlineEsc = escapeEmailHtml(headline);
  const body = `
    <div style="margin:0 0 12px 0;">
      ${headlineEsc} for
      <strong>${title}</strong> in ${workspaceName}.
    </div>
    <div style="margin:0 0 12px 0; color:#64748b; font-size:13px;">
      Open the workspace to see the latest review status and history.
      Internal review notes and decisions stay in the workspace and are
      never sent by email.
    </div>
  `.trim();
  const html = renderEmailShell({
    title: subjectPrefix,
    preheader: `${subjectPrefix}: "${d.requestTitle}".`,
    bodyHtml: body,
    ctaText: d.requestUrl ? "Open the workspace" : undefined,
    ctaUrl: d.requestUrl ?? undefined,
  });
  const text = [
    `${subjectPrefix}: ${d.requestTitle}`,
    "",
    `Workspace: ${d.workspaceName}`,
    d.requestUrl ? `Open: ${d.requestUrl}` : null,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
  return {
    subject: `${subjectPrefix}: ${d.requestTitle}`,
    html,
    text,
    plaintextPreview: text.slice(0, 2000),
  };
}

function renderIntakeLinkCreated(
  d: ExternalIntakeLinkCreatedContext,
): RenderedTemplate {
  const workspaceName = escapeEmailHtml(d.workspaceName);
  const expiry = d.expiresAtUtcIso
    ? formatTimestampForReportUtc(d.expiresAtUtcIso)
    : null;
  const body = `
    <div style="margin:0 0 12px 0;">
      <strong>${workspaceName}</strong> has shared a secure upload link
      with you.
    </div>
    ${
      expiry
        ? `<div style="margin:0 0 12px 0;"><strong>Expires:</strong> ${escapeEmailHtml(expiry)}</div>`
        : ""
    }
    <div style="margin:0 0 12px 0; color:#64748b; font-size:13px;">
      The link is unique to you. Please do not share it.
    </div>
  `.trim();
  const html = renderEmailShell({
    title: `Secure upload link from ${d.workspaceName}`,
    preheader: `${d.workspaceName} sent a secure upload link.`,
    bodyHtml: body,
    ctaText: "Open secure upload page",
    ctaUrl: d.intakeUrl,
  });
  const text = [
    `Secure upload link from ${d.workspaceName}`,
    "",
    `Open: ${d.intakeUrl}`,
    expiry ? `Expires: ${expiry}` : null,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
  return {
    subject: `Secure upload link from ${d.workspaceName}`,
    html,
    text,
    plaintextPreview: text.slice(0, 2000),
  };
}

function renderOperationsDigest(d: OperationsDigestContext): RenderedTemplate {
  const workspaceName = escapeEmailHtml(d.workspaceName);
  const listedItems = d.items.slice(0, 15);
  const overflow = d.totalUnread - listedItems.length;
  const rowsHtml = listedItems
    .map(
      (it) =>
        `<li style="margin:0 0 6px 0;">[${escapeEmailHtml(it.severity.toUpperCase())}] ${escapeEmailHtml(it.category)} — ${escapeEmailHtml(it.title)}</li>`,
    )
    .join("");
  const body = `
    <div style="margin:0 0 12px 0;">
      Your ${escapeEmailHtml(d.cadenceLabel.toLowerCase())} Operations Center
      digest for ${workspaceName}: ${d.totalUnread} unread operational
      item${d.totalUnread === 1 ? "" : "s"}.
    </div>
    <ul style="margin:0 0 12px 0; padding-left:18px;">${rowsHtml}</ul>
    ${overflow > 0 ? `<div style="margin:0 0 12px 0;">…and ${overflow} more in the Operations Center.</div>` : ""}
  `.trim();
  const html = renderEmailShell({
    title: `${d.cadenceLabel} operations digest`,
    preheader: `${d.totalUnread} unread operational item${d.totalUnread === 1 ? "" : "s"} in ${d.workspaceName}.`,
    bodyHtml: body,
    ctaText: d.operationsCenterUrl ? "Open the Operations Center" : undefined,
    ctaUrl: d.operationsCenterUrl ?? undefined,
  });
  const text = [
    `${d.cadenceLabel} operations digest — ${d.workspaceName}`,
    `${d.totalUnread} unread operational item${d.totalUnread === 1 ? "" : "s"}:`,
    ...listedItems.map(
      (it) => `- [${it.severity.toUpperCase()}] ${it.category} — ${it.title}`,
    ),
    overflow > 0 ? `…and ${overflow} more.` : null,
    d.operationsCenterUrl ? `Open: ${d.operationsCenterUrl}` : null,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
  return {
    subject: `${d.cadenceLabel} operations digest — ${d.workspaceName} (${d.totalUnread} unread)`,
    html,
    text,
    plaintextPreview: text.slice(0, 2000),
  };
}

type MembershipLifecycleEvent =
  | "WORKSPACE_ACCESS_REMOVED"
  | "WORKSPACE_ACCESS_SUSPENDED"
  | "WORKSPACE_ACCESS_RESTORED"
  | "WORKSPACE_ROLE_CHANGED"
  | "WORKSPACE_OWNERSHIP_RECEIVED"
  | "WORKSPACE_CLOSED"
  | "ACCOUNT_CLOSED";

function renderMembershipLifecycle(
  eventType: MembershipLifecycleEvent,
  d: MembershipLifecycleContext,
): RenderedTemplate {
  const brand = getEmailBrandName();
  const role = d.roleLabel ?? "a new role";
  const copy: Record<MembershipLifecycleEvent, { title: string; line: string }> = {
    WORKSPACE_ACCESS_REMOVED: {
      title: "Your workspace access was removed",
      line: `Your access to the workspace ${d.workspaceName} was removed. Records you created there stay with the workspace under its retention and legal hold rules.`,
    },
    WORKSPACE_ACCESS_SUSPENDED: {
      title: "Your workspace access was suspended",
      line: `Your access to the workspace ${d.workspaceName} was suspended. A workspace administrator can restore it.`,
    },
    WORKSPACE_ACCESS_RESTORED: {
      title: "Your workspace access was restored",
      line: `Your access to the workspace ${d.workspaceName} was restored.`,
    },
    WORKSPACE_ROLE_CHANGED: {
      title: "Your workspace role changed",
      line: `Your role in the workspace ${d.workspaceName} is now ${role}.`,
    },
    WORKSPACE_OWNERSHIP_RECEIVED: {
      title: "You now own a workspace",
      line: `Ownership of the workspace ${d.workspaceName} was transferred to you.`,
    },
    WORKSPACE_CLOSED: {
      title: "A workspace you belonged to was closed",
      line: `The workspace ${d.workspaceName} was closed, and your access to it has ended. Its records remain governed by retention and legal hold.`,
    },
    ACCOUNT_CLOSED: {
      title: `Your ${brand} account was closed`,
      line: `Your ${brand} account was closed. Records held by workspaces remain governed by their retention and legal hold rules.`,
    },
  };
  const { title, line } = copy[eventType];
  const html = renderEmailShell({
    title,
    preheader: line.slice(0, 120),
    bodyHtml: `<div style="margin:0 0 12px 0;">${escapeEmailHtml(line)}</div>`,
    ctaText: d.actionUrl ? "Open your workspaces" : undefined,
    ctaUrl: d.actionUrl ?? undefined,
  });
  const text = [title, "", line, d.actionUrl ? `Open: ${d.actionUrl}` : null]
    .filter((l): l is string => typeof l === "string")
    .join("\n");
  return { subject: title, html, text, plaintextPreview: text.slice(0, 2000) };
}

function renderIntakeSubmitted(
  d: ExternalIntakeSubmittedContext,
): RenderedTemplate {
  const workspaceName = escapeEmailHtml(d.workspaceName);
  const body = `
    <div style="margin:0 0 12px 0;">
      A new submission has arrived in ${workspaceName} from an external
      intake link (mode: ${escapeEmailHtml(d.intakeMode)}).
    </div>
  `.trim();
  const html = renderEmailShell({
    title: "New external submission",
    preheader: `Submission via ${d.intakeMode}.`,
    bodyHtml: body,
    ctaText: d.evidenceUrl ? "Open the evidence" : undefined,
    ctaUrl: d.evidenceUrl ?? undefined,
  });
  const text = [
    `New external submission in ${d.workspaceName}`,
    `Mode: ${d.intakeMode}`,
    d.evidenceUrl ? `Open: ${d.evidenceUrl}` : null,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
  return {
    subject: `New external submission in ${d.workspaceName}`,
    html,
    text,
    plaintextPreview: text.slice(0, 2000),
  };
}

// Re-export so business code can construct a context object directly.
export { getEmailWebBaseUrl };
