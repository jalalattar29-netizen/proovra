/**
 * The server, as the Intake Links surface sees it — by route interception.
 *
 * WHY NOT A REAL STACK
 * ---------------------------------------------------------------------------
 * This project measures GEOMETRY and COMPUTED STYLE: overflow, containment,
 * reflow, target size, and whether the redesigned presentation is the one the
 * cascade actually resolves. None of that is a property of the database. What
 * it IS a property of is the real production bundle, the real stylesheet order
 * and a real layout engine — exactly what jsdom cannot provide.
 *
 * So the API is intercepted and the WEB TIER is real. Every fixture below is
 * shaped like the contract the route actually projects; nothing is invented
 * that the server could not send.
 */

import type { Page } from "@playwright/test";

import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../apps/web/lib/platform-context/types";

export type IntakeContext =
  | "personal"
  | "organization"
  | "enterprise"
  | "admin";

export const WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";

/**
 * Deliberately hostile values. Long-label containment is the property the
 * fixed-percentage column grid has to survive, so the stress fixture carries
 * the longest legitimate value each column can receive.
 */
export const LONG = {
  /** A workspace name a real firm would use. */
  workspace:
    "Fotheringay, Wallace & Associates International Legal Services — Zürich Niederlassung",
  /** A user-generated request title. */
  title:
    "Insurance claim evidence for the multi-vehicle incident on the northbound carriageway, reference NB-2026-08-14-0097-REVIEWED",
  /** An operator-supplied recipient label. */
  recipient:
    "Jane Alexandra Smith-Fotheringay — consolidated claim 4842 / policy AX-99887766 / adjuster copy",
  /** A real long email address. */
  email: "jane.alexandra.smith-fotheringay@claims-department.example-insurance.co.uk",
  /** International phone, masked as the projection masks it. */
  phone: "+49 151 ••• ••• 23",
  /** A long custom sender name, at the API ceiling. */
  sender: "Fotheringay Wallace & Associates International Legal Group",
  /**
   * A translated status label roughly as long as the German for
   * "Queued with provider" — the fixed grid must not be an English-only
   * contract, so the stress fixture drives a value of that length through the
   * same column.
   */
  german: "In der Warteschlange beim Anbieter",
} as const;

export function envelopeFor(
  context: IntakeContext,
  over: { workspaceName?: string; intakeIncluded?: boolean } = {},
): Record<string, unknown> {
  const enterprise = context === "enterprise" || context === "admin";
  const type = context === "personal" ? "PERSONAL" : "ORGANIZATION";
  const displayName =
    over.workspaceName ??
    (context === "personal" ? "Personal Space" : "Meridian Legal");
  return {
    // The REAL accepted versions. An envelope carrying anything else is
    // refused by `versionsAreCompatible` and the shell falls back to its
    // unknown-projection state — which looks exactly like a layout bug.
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: { INTAKE_LINKS_MANAGE: true },
    diagnostics: { requestId: `intake-layout-${context}` },
    workspace: {
      id: WORKSPACE_ID,
      name: displayName,
      status: "active",
      scope: type,
    },
    activeSpace: { type, id: WORKSPACE_ID, displayName, roleLabel: "Owner" },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: {
        workspaceId: WORKSPACE_ID,
        kind: type,
        organizationId: null,
        displayName,
      },
    },
    account: {
      accountPlan: enterprise ? "ENTERPRISE" : "PRO",
      accountStatus: "active",
    },
    flags: { isEnterpriseWorkspace: enterprise },
    platform: { isPlatformAdmin: context === "admin" },
    planFeatures: { intakeIncluded: over.intakeIncluded ?? true },
    user: { id: "user-1", email: "operator@example.invalid", name: "Operator" },
  };
}

type RowSpec = {
  id: string;
  title?: string;
  mode?: string;
  status?: string;
  expires?: string;
  revoked?: string | null;
  archived?: string | null;
  used?: number;
  recipientLabel?: string | null;
  email?: string | null;
  phone?: string | null;
  channel?: string | null;
  delivery?: string | null;
  attempts?: number;
  code?: string | null;
  opened?: number;
  started?: number;
  submitted?: number;
};

const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";

function row(s: RowSpec) {
  const created = "2026-08-01T00:00:00.000Z";
  return {
    link: {
      id: s.id,
      teamId: WORKSPACE_ID,
      workflowTemplateSlug: "general-evidence-record",
      workflowTemplateVersion: 1,
      workflowTemplateName: s.title ?? "General evidence request",
      intakeMode: s.mode ?? "EXTERNAL_ONE_TIME",
      caseId: null,
      recipientLabel: s.recipientLabel ?? null,
      recipientEmailPreview: s.email ?? null,
      recipientPhonePreview: s.phone ?? null,
      maxUses: 1,
      usedCount: s.used ?? 0,
      status: s.status ?? "ACTIVE",
      expiresAtUtc: s.expires ?? FUTURE,
      revokedAtUtc: s.revoked ?? null,
      revokedReason: null,
      archivedAtUtc: s.archived ?? null,
      createdAt: created,
      updatedAt: created,
    },
    delivery: {
      latestStatus: s.delivery ?? null,
      latestChannel: s.channel ?? null,
      latestAtUtc: s.delivery ? created : null,
      latestSentAtUtc: null,
      latestDeliveredAtUtc: null,
      latestFailedAtUtc: null,
      latestErrorCode: s.code ?? null,
      attemptCount: s.attempts ?? (s.delivery ? 1 : 0),
      channelsAttempted: s.channel ? [s.channel] : [],
      latestProviderMessageId: null,
    },
    activity: {
      firstOpenedAtUtc: null,
      lastOpenedAtUtc: null,
      firstStartedAtUtc: null,
      lastStartedAtUtc: null,
      firstSubmittedAtUtc: null,
      lastSubmittedAtUtc: null,
      sessionsCreated: (s.opened ?? 0) + (s.started ?? 0) + (s.submitted ?? 0),
      sessionsOpened: s.opened ?? 0,
      sessionsStarted: s.started ?? 0,
      sessionsSubmitted: s.submitted ?? 0,
      sessionsExpired: 0,
      sessionsRevoked: 0,
      evidenceCount: s.submitted ?? 0,
    },
    computedLifecycle: "SENT",
  };
}

/**
 * What `POST /v1/workflow/intake-links` answers with: the created row, the
 * one-shot token, and the outcome of the delivery attempt. Shaped from the same
 * row builder, so the create response cannot drift from the list contract.
 */
function createdPayload() {
  const created = row({ id: "r-created", title: "General evidence request" });
  return {
    link: created.link,
    rawToken: "raw-token-for-the-layout-fixture",
    delivery: { method: "MANUAL", status: "skipped", reason: null },
  };
}

/**
 * Every axis combination that has to survive layout, plus the long-text stress
 * row. Held constant across contexts so any difference the matrix observes
 * comes from the capability projection, never from the data.
 */
export const ROWS = [
  row({
    id: "r-archived-submitted",
    archived: PAST,
    opened: 1,
    started: 1,
    submitted: 1,
    channel: "SMS",
    delivery: "QUEUED",
    phone: LONG.phone,
  }),
  row({
    id: "r-long",
    title: LONG.title,
    recipientLabel: LONG.recipient,
    channel: "EMAIL",
    delivery: "DELIVERED",
    opened: 1,
    expires: "2026-08-25T00:00:00.000Z",
  }),
  row({
    id: "r-failed",
    channel: "WHATSAPP",
    delivery: "FAILED",
    attempts: 3,
    code: "63016",
    title: "Property damage",
  }),
  row({
    id: "r-disabled",
    status: "REVOKED",
    revoked: PAST,
    title: "Legal document collection",
    opened: 1,
    started: 1,
    submitted: 1,
    channel: "SMS",
    delivery: "DELIVERED",
  }),
  row({
    id: "r-expired",
    status: "EXPIRED",
    used: 1,
    expires: PAST,
    title: "Compliance / audit submission",
    mode: "EXTERNAL_ANONYMOUS",
    email: LONG.email,
    channel: "EMAIL",
    delivery: "RETRY_SCHEDULED",
  }),
  row({ id: "r-quiet", title: "Documents", channel: null }),
] as const;

/**
 * THE DELIVERY-SEMANTICS MATRIX — the four cases that must stay distinct.
 *
 * `Manual` and `Not sent` looked identical before this pass, and the whole
 * point of the fix is that they are different facts. These rows exercise the
 * boundary from both sides:
 *
 *   manual    no delivery record at all (attemptCount 0, channel null)
 *   not-sent  a REAL provider record whose status is not one of the six
 *             recognised sends — `RECEIVED` is an inbound message, which
 *             `getDeliveryState` folds to NOT_SENT. A record exists, so the
 *             manual rule cannot claim it.
 *   provider  QUEUED — the provider is holding it
 *   failed    FAILED
 */
export const DELIVERY_MATRIX_ROWS = [
  row({ id: "d-manual", title: "Manual share", channel: null }),
  row({
    id: "d-not-sent",
    title: "Provider, unsent",
    channel: "EMAIL",
    delivery: "RECEIVED",
    attempts: 1,
  }),
  row({
    id: "d-provider",
    title: "Provider holding",
    channel: "SMS",
    delivery: "QUEUED",
  }),
  row({
    id: "d-failed",
    title: "Provider failed",
    channel: "EMAIL",
    delivery: "FAILED",
  }),
] as const;

/** A German-length status/title fixture, for the localization audit. */
export const GERMAN_ROWS = [
  row({
    id: "r-de-1",
    title: "Versicherungsschadensnachweis — Mehrfahrzeugunfall Nordfahrbahn",
    recipientLabel: "Sachbearbeiterin Frau Dr. Ingeborg Schmidt-Wagenknecht",
    channel: "SMS",
    delivery: "QUEUED",
    phone: LONG.phone,
  }),
  row({
    id: "r-de-2",
    title: "Zusammenstellung der Beweismittel für die Schadensregulierung",
    recipientLabel: "Rechtsanwaltskanzlei Fotheringay & Partner mbB",
    channel: "WHATSAPP",
    delivery: "FAILED",
    attempts: 3,
    code: "63016",
    opened: 1,
    started: 1,
    submitted: 1,
  }),
] as const;

export type ProviderShape = "all" | "none" | "sms" | "email" | "whatsapp";

function transportFor(shape: ProviderShape) {
  const on = (k: ProviderShape) => shape === "all" || shape === k;
  return {
    email: {
      configured: on("email"),
      fromName: "PROOVRA",
      fromAddressPreview: "no-reply@proovra.com",
    },
    sms: { configured: on("sms"), fromNumberPreview: "+1 ••• ••• 8084" },
    whatsapp: {
      configured: on("whatsapp"),
      fromNumberPreview: "+1 ••• ••• 8084",
    },
  };
}

/** Install the whole API surface for one context. */
export async function installApi(
  page: Page,
  context: IntakeContext,
  over: {
    rows?: ReadonlyArray<unknown>;
    provider?: ProviderShape;
    workspaceName?: string;
    intakeIncluded?: boolean;
    listStatus?: number;
  } = {},
): Promise<void> {
  const envelope = envelopeFor(context, {
    workspaceName: over.workspaceName,
    intakeIncluded: over.intakeIncluded,
  });
  const rows = over.rows ?? ROWS;
  const transport = transportFor(over.provider ?? "all");

  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (path.endsWith("/v1/platform/context")) return json(envelope);
    if (path.endsWith("/v1/auth/me") || path.endsWith("/v1/users/me")) {
      return json({ id: "user-1", email: "operator@example.invalid" });
    }
    if (path.endsWith("/v1/workflow/intake-links")) {
      // The same path is the list read and the create write. Answering both
      // with the list payload used to leave the wizard holding a response with
      // no token in it, which looks exactly like a failed create.
      if (route.request().method() === "POST") {
        return json(createdPayload());
      }
      if (over.listStatus && over.listStatus >= 400) {
        return json({ error: { code: "forbidden" } }, over.listStatus);
      }
      return json({ items: rows });
    }
    if (path.endsWith("/v1/workflow/templates")) return json({ templates: [] });
    if (path.endsWith("/v1/workflow/intake-links/sender-identity")) {
      return json(transport);
    }
    if (path.includes("/v1/communications/messages")) {
      return json({ messages: [] });
    }
    // Anything else the shell asks for: an empty, well-formed answer. A 404
    // here would push the page into an error state and measure the wrong tree.
    return json({});
  });
}

/** Load `/intake-links` and wait for the settled management surface. */
export async function openIntakeLinks(
  page: Page,
  context: IntakeContext,
  over: Parameters<typeof installApi>[2] = {},
): Promise<void> {
  await installApi(page, context, over);
  await page.goto("/intake-links");
  await page.waitForSelector('[data-testid="intake-links-page"]', {
    timeout: 30_000,
  });
  // The KPI strip only exists once the list read has settled, so waiting for it
  // means the measured tree is the settled one rather than the first paint.
  await page.waitForSelector("[data-intake-links-kpis]", { timeout: 30_000 });
}

/** Open the creation wizard on the settled page. */
export async function openWizard(page: Page): Promise<void> {
  await page.click("[data-intake-links-new-cta]");
  await page.waitForSelector('[data-testid="intake-link-create-wizard"]', {
    timeout: 15_000,
  });
}

/** Switch the document to RTL, the way a locale would. */
export async function setDirection(
  page: Page,
  dir: "ltr" | "rtl",
): Promise<void> {
  await page.evaluate((d) => {
    document.documentElement.setAttribute("dir", d);
  }, dir);
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => r(null))),
  );
}

export const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1280", width: 1280, height: 860 },
  { name: "1024", width: 1024, height: 800 },
  /** The tablet breakpoint, where the table sheds its foldable columns. */
  { name: "768", width: 768, height: 1024 },
  /** A large phone — cards, not a squeezed table. */
  { name: "430", width: 430, height: 932 },
  /** The narrowest viewport the product supports. */
  { name: "390", width: 390, height: 844 },
] as const;

export const DIRECTIONS = ["ltr", "rtl"] as const;
