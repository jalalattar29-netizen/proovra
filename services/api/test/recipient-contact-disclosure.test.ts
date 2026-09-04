/**
 * EXTERNAL INTAKE RECIPIENT CONTACT — one disclosure rule, every surface.
 *
 * The address and number an intake request was DELIVERED to belong to a third
 * party. Before this closure the same two columns had three different answers
 * depending on which projection you asked:
 *
 *   projectWorkflowIntakeLink      RAW, to anyone holding `evidence.read`
 *   intake-link list item          masked, by a helper local to that file
 *   external-intake source summary masked, raw under `intake_link.create`
 *
 * The middle one was already safe; the other two were not. And the third was
 * less safe than it looked: `workflow.intake_link.create` is held by canonical
 * REVIEWER, and the DB role MEMBER maps to REVIEWER, so every ordinary team
 * member was receiving the stored contact details.
 *
 * The rule now: no projection can emit a raw value, for anyone. A caller
 * holding `workflow.intake_recipient_contact.reveal` asks for one at a
 * dedicated route, which audits the disclosure.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PERMISSIONS,
  roleHasPermission,
  mapTeamRoleToCanonical,
  maskEmail,
  maskPhonePreview,
} from "@proovra/shared";

import {
  projectRecipientContact,
  revealRecipientContact,
  RECIPIENT_CONTACT_DISCLOSURES,
} from "../src/services/privacy/recipient-contact-disclosure.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

const LINK_SERVICE = read("services/api/src/services/workflow-intake-link.service.ts");
const LIFECYCLE = read("services/api/src/services/intake-link-lifecycle.service.ts");
const SUMMARY = read(
  "services/api/src/services/external-intake-source-summary.service.ts",
);
const LINK_ROUTES = read("services/api/src/routes/workflow-intake-links.routes.ts");
const EVIDENCE_ROUTES = read("services/api/src/routes/evidence.routes.ts");
const INTEGRATIONS = read("services/api/src/routes/integrations-api.routes.ts");
const SESSION_SERVICE = read(
  "services/api/src/services/workflow-intake-session.service.ts",
);
const POLICY = read(
  "services/api/src/services/privacy/recipient-contact-disclosure.ts",
);
const CARD = read(
  "apps/web/app/(app)/evidence/[id]/components/ExternalIntakeSourceCard.tsx",
);

/** The canaries. Distinctive enough that a substring hit is never a coincidence. */
const CANARY_EMAIL = "recipient-privacy-canary@example.test";
const CANARY_PHONE = "+499999000111222";

// ===========================================================================
// The authority
// ===========================================================================
describe("the disclosure authority", () => {
  it("is its own permission, not a mutation capability borrowed for the job", () => {
    expect(PERMISSIONS).toContain("workflow.intake_recipient_contact.reveal");
  });

  it("is held by the roles that OPERATE intake, and by nobody else", () => {
    /*
     * It was first granted to OWNER and ADMIN only, on the reasoning that a
     * disclosure is an administrative act. That was wrong about who runs
     * intake: the people who create the links and chase the recipients are
     * canonical REVIEWER — which is what DB role MEMBER maps to — and
     * withholding the address from them protected nobody. It pushed the
     * number into a spreadsheet outside the product, where no policy reaches
     * it at all.
     */
    for (const role of ["OWNER", "ADMIN", "REVIEWER"] as const) {
      expect(
        roleHasPermission(role, "workflow.intake_recipient_contact.reveal"),
        `${role} should hold the reveal authority`,
      ).toBe(true);
    }
    for (const role of ["CONTRIBUTOR", "VIEWER"] as const) {
      expect(
        roleHasPermission(role, "workflow.intake_recipient_contact.reveal"),
        `${role} must NOT hold the reveal authority`,
      ).toBe(false);
    }
  });

  it("tracks the intake authority exactly, in both directions", () => {
    /*
     * The rule, stated as an equivalence rather than a list: whoever may
     * create and revoke an intake link may see who it was sent to, and
     * whoever may not, may not. Written this way, a future edit to either
     * side shows up here instead of silently moving the boundary.
     */
    for (const role of [
      "OWNER",
      "ADMIN",
      "REVIEWER",
      "CONTRIBUTOR",
      "VIEWER",
    ] as const) {
      expect(
        roleHasPermission(role, "workflow.intake_recipient_contact.reveal"),
        `${role} disagrees with its own intake authority`,
      ).toBe(roleHasPermission(role, "workflow.intake_link.create"));
    }
  });

  it("is still not implied by reading the record", () => {
    /*
     * The original finding, and the half that did not move. VIEWER and
     * CONTRIBUTOR can both read evidence; neither can operate intake, and
     * read access to a record is still not a reason to receive a third
     * party's contact details.
     */
    for (const role of ["CONTRIBUTOR", "VIEWER"] as const) {
      expect(roleHasPermission(role, "evidence.read")).toBe(true);
      expect(
        roleHasPermission(role, "workflow.intake_recipient_contact.reveal"),
      ).toBe(false);
    }
  });

  it("reaches an ordinary team MEMBER, because that is a REVIEWER", () => {
    // The mapping that made the first grant wrong is the one that makes this
    // one right: an operational member is exactly who needs the address.
    expect(mapTeamRoleToCanonical("MEMBER")).toBe("REVIEWER");
    expect(
      roleHasPermission("REVIEWER", "workflow.intake_recipient_contact.reveal"),
    ).toBe(true);
    expect(mapTeamRoleToCanonical("VIEWER")).toBe("VIEWER");
    expect(
      roleHasPermission("VIEWER", "workflow.intake_recipient_contact.reveal"),
    ).toBe(false);
  });

  it("names three states and no more", () => {
    expect([...RECIPIENT_CONTACT_DISCLOSURES]).toEqual([
      "HIDDEN",
      "MASKED",
      "REVEALED",
    ]);
  });
});

// ===========================================================================
// The primitive
// ===========================================================================
describe("the disclosure primitive", () => {
  const source = {
    recipientEmail: CANARY_EMAIL,
    recipientPhone: CANARY_PHONE,
  };

  it("HIDDEN emits nothing — not even a mask", () => {
    const p = projectRecipientContact(source, "HIDDEN");
    expect(JSON.stringify(p)).not.toContain("example.test");
    expect(p.recipientEmailMasked).toBeNull();
    expect(p.recipientPhoneMasked).toBeNull();
    // Presence itself is withheld: a mask confirms a channel was used.
    expect(p.hasRecipientEmail).toBe(false);
    expect(p.hasRecipientPhone).toBe(false);
    expect(p.recipientContactRevealAuthorized).toBe(false);
  });

  it("MASKED emits the platform's mask and no raw substring", () => {
    const p = projectRecipientContact(source, "MASKED");
    expect(p.recipientEmailMasked).toBe(maskEmail(CANARY_EMAIL));
    expect(p.recipientPhoneMasked).toBe(maskPhonePreview(CANARY_PHONE));
    expect(p.recipientContactRevealAuthorized).toBe(false);
    const body = JSON.stringify(p);
    expect(body).not.toContain(CANARY_EMAIL);
    expect(body).not.toContain("999900011122");
  });

  it("REVEALED carries the raw values, and says that it did", () => {
    /*
     * This began as "an entitlement, not a payload": raw came only from an
     * audited reveal route. On an administration screen listing many requests
     * that made an authorized operator click once per row to answer "who did
     * I send this to?", which is not a privacy control — it is the reason
     * people keep a spreadsheet outside the product.
     *
     * The AUTHORITY is unchanged. Only REVEALED reaches this branch, and only
     * `resolveRecipientContactDisclosure` can produce REVEALED.
     */
    const p = projectRecipientContact(source, "REVEALED");
    expect(p.recipientContactRevealAuthorized).toBe(true);
    expect(p.recipientEmail).toBe(CANARY_EMAIL);
    expect(p.recipientPhone).toBe(CANARY_PHONE);
    // The mask travels with it, so a surface can show either without asking
    // a second question.
    expect(p.recipientEmailMasked).toBe(maskEmail(CANARY_EMAIL));
  });

  it("MASKED is still the answer for everybody else", () => {
    // The half that did not move, asserted next to the half that did.
    const p = projectRecipientContact(source, "MASKED");
    expect(p.recipientEmail).toBeNull();
    expect(p.recipientPhone).toBeNull();
    expect(JSON.stringify(p)).not.toContain(CANARY_EMAIL);
  });

  it("the reveal helper refuses without the decision", () => {
    expect(revealRecipientContact(source, "MASKED")).toEqual({
      recipientEmail: null,
      recipientPhone: null,
    });
    expect(revealRecipientContact(source, "HIDDEN")).toEqual({
      recipientEmail: null,
      recipientPhone: null,
    });
    expect(revealRecipientContact(source, "REVEALED")).toEqual(source);
  });

  it("keeps masking and authorization apart", () => {
    // The mask helpers are pure formatters, imported from shared, and are
    // never asked a question about authority.
    expect(POLICY).toContain('from "@proovra/shared"');
    expect(POLICY).toContain("evaluateAuthorize(req, {");
    expect(POLICY).toContain(
      'permission: "workflow.intake_recipient_contact.reveal"',
    );
    // No plan names, no role names.
    expect(POLICY).not.toMatch(/plan\s*===/);
    expect(POLICY).not.toMatch(/role\s*===/);
    expect(POLICY).not.toMatch(/"(FREE|PAYG|PRO|TEAM|ENTERPRISE)"/);
    expect(POLICY).not.toMatch(/"(OWNER|ADMIN|VIEWER)"/);
  });
});

// ===========================================================================
// Every projection consumes the one decision
// ===========================================================================
describe("the inventory", () => {
  it("projectWorkflowIntakeLink no longer returns raw contact", () => {
    const fn = LINK_SERVICE.slice(
      LINK_SERVICE.indexOf("export function projectWorkflowIntakeLink("),
    );
    expect(fn).toContain("disclosure: RecipientContactDisclosure");
    expect(fn).toContain("...projectRecipientContact(link, disclosure)");
    // The two raw reads are gone from the projection body.
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).not.toContain("recipientEmail: link.recipientEmail");
    expect(body).not.toContain("recipientPhone: link.recipientPhone");
  });

  it("the intake-link list uses the same policy, not its own masks", () => {
    expect(LIFECYCLE).toContain("projectRecipientContact(link, disclosure)");
    expect(LIFECYCLE).toContain(
      "recipientEmailPreview: recipientContact.recipientEmailMasked",
    );
    // The local pair is retired: nothing in the service calls it any more, so
    // the same address cannot render two ways on two screens.
    const service = LIFECYCLE.slice(LIFECYCLE.indexOf("projectIntakeLinkList"));
    expect(service).not.toContain("maskEmailForList(");
    expect(service).not.toContain("maskPhoneForList(");
  });

  it("the list defaults to MASKED when a route forgets to decide", () => {
    expect(LIFECYCLE).toContain(
      'input.recipientContactDisclosure ?? "MASKED"',
    );
  });

  it("the Evidence Detail summary spreads the same projection", () => {
    expect(SUMMARY).toContain("...projectRecipientContact(link, disclosure)");
    expect(SUMMARY).toContain('disclosure: RecipientContactDisclosure = "MASKED"');
  });

  it("every intake-link route response passes a decision", () => {
    /*
     * Six call sites: create, list, the legacy `links` array, get, and the
     * three mutation responses. A projection call with one argument would be
     * a route that never asked.
     */
    const calls = LINK_ROUTES.match(/projectWorkflowIntakeLink\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(6);
    expect(LINK_ROUTES).not.toMatch(/projectWorkflowIntakeLink\(\s*\w+\s*\)/);
  });

  it("the machine API masks what it echoes back", () => {
    const handler = INTEGRATIONS.slice(
      INTEGRATIONS.indexOf("intakeLink: {"),
      INTEGRATIONS.indexOf("rawToken,"),
    );
    expect(handler).toContain("recipientEmailMasked: maskEmail(link.recipientEmail)");
    expect(handler).not.toContain("recipientEmail: link.recipientEmail");
  });

  it("the contributor's own view is HIDDEN — no contact at all", () => {
    const projection = SESSION_SERVICE.slice(
      SESSION_SERVICE.indexOf("export function projectIntakeLinkForExternalView"),
    ).slice(0, 2500);
    expect(projection).not.toContain("recipientEmail");
    expect(projection).not.toContain("recipientPhone");
    expect(projection).not.toContain("Masked");
  });

  it("public verify reads neither column", () => {
    const publicHandler = EVIDENCE_ROUTES.slice(
      EVIDENCE_ROUTES.indexOf('app.get("/public/verify/:id"'),
    );
    expect(publicHandler).not.toContain("recipientEmail");
    expect(publicHandler).not.toContain("recipientPhone");
    expect(publicHandler).not.toContain("recipientContact");
  });

  it("neither column reaches a report or a verification package", () => {
    for (const rel of [
      "services/worker/src/report-v2/build-view-model.ts",
      "services/worker/src/report-v2/technical-model.ts",
      "services/worker/src/verification-package.ts",
    ]) {
      const src = read(rel);
      expect(src, `${rel} must not carry recipient contact`).not.toContain(
        "recipientEmail",
      );
      expect(src, `${rel} must not carry recipient contact`).not.toContain(
        "recipientPhone",
      );
    }
  });

  it("queue payloads already ban both keys, and still do", () => {
    const payload = read("packages/shared/src/queue-integrity/payload.ts");
    expect(payload).toContain('"recipientEmail"');
    expect(payload).toContain('"recipientPhone"');
  });
});

// ===========================================================================
// The reveal route
// ===========================================================================
describe("the reveal route", () => {
  const route = LINK_ROUTES.slice(
    LINK_ROUTES.indexOf('"/v1/workflow/intake-links/:id/recipient-contact"'),
    LINK_ROUTES.indexOf("-- Sender identity preview"),
  );

  it("exists exactly once, and is a POST", () => {
    expect(
      (LINK_ROUTES.match(/\/recipient-contact"/g) ?? []).length,
    ).toBe(1);
    expect(LINK_ROUTES).toContain(
      'app.post(\n    "/v1/workflow/intake-links/:id/recipient-contact"',
    );
  });

  it("gates on the resource first, then on the disclosure authority", () => {
    expect(route).toContain("requireMember(req, reply, link.teamId)");
    expect(route.indexOf("requireMember")).toBeLessThan(
      route.indexOf("resolveRecipientContactDisclosure"),
    );
    expect(route).toContain('if (disclosure !== "REVEALED")');
    expect(route).toContain("reply.code(403)");
  });

  it("cannot produce a value the decision did not allow", () => {
    expect(route).toContain("revealRecipientContact(link, disclosure)");
  });

  it("audits the disclosure on the platform's existing convention", () => {
    expect(route).toContain("safeEmitSecurityEvent({");
    expect(route).toContain(
      'eventType: "workflow_intake_recipient_contact_revealed"',
    );
    expect(route).toContain("actorUserId");
    expect(route).toContain("intakeLinkId: link.id");
    expect(route).toContain('disclosureType: "recipient_contact"');
  });

  it("never writes the address into the audit record", () => {
    const audit = route.slice(
      route.indexOf("safeEmitSecurityEvent({"),
      route.indexOf("return reply.code(200)"),
    );
    // Booleans, not values: the log says a reveal happened, not what was in it.
    expect(audit).toContain("revealedEmail: Boolean(revealed.recipientEmail)");
    expect(audit).toContain("revealedPhone: Boolean(revealed.recipientPhone)");
    expect(audit).not.toMatch(/:\s*revealed\.recipientEmail\b/);
    expect(audit).not.toMatch(/:\s*revealed\.recipientPhone\b/);
    expect(audit).not.toContain("link.recipientEmail");
    expect(audit).not.toContain("link.recipientPhone");
  });
});

// ===========================================================================
// The outbound delivery log — the fourth surface, found during the audit
// ===========================================================================
describe("the notification delivery log", () => {
  const deliveryRow = (channel: "EMAIL" | "SMS", recipient: string) =>
    ({
      id: "d1",
      eventType: "intake_link_sent",
      channel,
      provider: channel === "EMAIL" ? "RESEND" : "TWILIO",
      recipient,
      recipientName: null,
      status: "SENT",
      subject: null,
      templateKey: "intake_link",
      renderedPreview: null,
      providerMessageId: null,
      errorCode: null,
      errorMessage: null,
      retryCount: 0,
      nextAttemptAtUtc: null,
      sentAtUtc: new Date(),
      deliveredAtUtc: null,
      failedAtUtc: null,
      evidenceRequestId: null,
      evidenceId: null,
      intakeLinkId: "link-1",
      initiatedByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as never;

  it("masks an email recipient by default", async () => {
    const { projectNotificationDelivery } = await import(
      "../src/services/notifications/index.js"
    );
    const out = projectNotificationDelivery(deliveryRow("EMAIL", CANARY_EMAIL));
    expect(JSON.stringify(out)).not.toContain(CANARY_EMAIL);
    expect(out.recipient).toBe(maskEmail(CANARY_EMAIL));
  });

  it("masks an SMS recipient too — the old branch only handled email", async () => {
    /*
     * The previous helper returned any value without an "@" UNCHANGED, so a
     * phone number came back raw even when the caller had asked for masking.
     * A phone number is not less personal than an address.
     */
    const { projectNotificationDelivery } = await import(
      "../src/services/notifications/index.js"
    );
    const out = projectNotificationDelivery(deliveryRow("SMS", CANARY_PHONE));
    expect(JSON.stringify(out)).not.toContain("999900011122");
    expect(out.recipient).toBe(maskPhonePreview(CANARY_PHONE));
  });

  it("returns the raw value only for a REVEALED caller", async () => {
    const { projectNotificationDelivery } = await import(
      "../src/services/notifications/index.js"
    );
    const out = projectNotificationDelivery(deliveryRow("EMAIL", CANARY_EMAIL), {
      disclosure: "REVEALED",
    });
    expect(out.recipient).toBe(CANARY_EMAIL);
  });

  it("no longer lets the client choose with a query parameter", () => {
    const routes = read("services/api/src/routes/notifications.routes.ts");
    // Only the comment explaining its removal survives; the schema field and
    // every read of it are gone.
    expect(routes).not.toMatch(/maskRecipient:/);
    expect(routes).not.toMatch(/query.maskRecipient/);
    expect(routes).toContain("resolveRecipientContactDisclosure(req, {");
  });

  it("records the disclosure when it actually discloses", () => {
    const routes = read("services/api/src/routes/notifications.routes.ts");
    expect(routes).toContain('if (disclosure === "REVEALED" && rows.length > 0)');
    expect(routes).toContain(
      'eventType: "workflow_intake_recipient_contact_revealed"',
    );
    // Counts, not addresses.
    expect(routes).toContain("deliveryCount: rows.length");
    expect(routes).not.toMatch(/details:[sS]{0,300}r.recipient/);
  });
});

// ===========================================================================
// The reveal UX
// ===========================================================================
describe("the card", () => {
  it("renders no control for a reader without the authority", () => {
    // Not a disabled button: offering an action that can only fail tells the
    // reader about a capability they do not have. And no control for an
    // AUTHORIZED reader either once the server has already sent the value —
    // a button that swaps a string for the same string is not a control.
    expect(CARD).toContain("summary.link.recipientContactRevealAuthorized &&");
    expect(CARD).toContain("recipientContacts.every((c) => c.raw === null)");
    expect(CARD).toContain("{canRevealRecipient ? (");
  });

  it("holds a raw value only when the server decided to send one", () => {
    /*
     * The card makes no disclosure decision. It reads whatever the server put
     * in the payload — which is null for a masked caller — and falls back to
     * the reveal response for the case where an authorized caller was still
     * sent masks. An unauthorized reader's page therefore contains no raw
     * value in the HTML, the hydration state or a React prop, because one was
     * never sent to it.
     */
    expect(CARD).toContain("const [rawRecipient, setRawRecipient] = useState<");
    expect(CARD).toContain("summary.link.recipientEmail ??");
    expect(CARD).toContain("rawRecipient?.recipientEmail ??");
    // Still no masking and no authority decision in the browser.
    expect(CARD).not.toContain("maskEmail(");
    expect(CARD).not.toMatch(/plan\s*===/);
    expect(CARD).not.toMatch(/role\s*===/);
  });

  it("fetches through the audited route, not a second projection", () => {
    expect(CARD).toContain("/recipient-contact");
    expect(CARD).toContain('method: "POST"');
  });

  it("still labels the destination as a destination", () => {
    expect(CARD).toContain('<Detail label="Intake sent to">');
    expect(CARD).toContain("Not proof of who submitted");
  });
});

// ===========================================================================
// The other two concepts are untouched
// ===========================================================================
describe("the neighbouring data classes", () => {
  it("Customer ID keeps its own rules", () => {
    // Organization-supplied business metadata, visible to any authorized
    // reader, deliberately NOT routed through the recipient-contact policy.
    expect(LINK_SERVICE).toContain("customerId: link.customerId");
    expect(SUMMARY).toContain("customerId: link.customerId");
    expect(CARD).toContain('<Detail label="Customer ID">');
    // And still private on public verify.
    const publicHandler = EVIDENCE_ROUTES.slice(
      EVIDENCE_ROUTES.indexOf('app.get("/public/verify/:id"'),
    );
    expect(publicHandler).not.toContain("customerId");
  });

  it("submitter-provided contact stays a separate concept", () => {
    expect(CARD).toContain('<Detail label="Submitter provided">');
    // Anonymity still wins over any reveal authority: the anonymous branch is
    // decided by the intake MODE, not by who is looking.
    expect(SUMMARY).toContain("submitterEmail: isAnonymous ? null : session.submitterEmail");
    expect(SUMMARY).toContain("submitterPhone: isAnonymous ? null : session.submitterPhone");
    // Recipient reveal authority is never consulted for submitter fields: the
    // session block of the RETURN literal mentions the decision nowhere.
    const returnLiteral = SUMMARY.slice(SUMMARY.indexOf("  return {"));
    const submitterBlock = returnLiteral.slice(
      returnLiteral.indexOf("session: {"),
      returnLiteral.indexOf("consentPolicyVersion"),
    );
    expect(submitterBlock.length).toBeGreaterThan(80);
    expect(submitterBlock).not.toContain("disclosure");
    expect(submitterBlock).not.toContain("Reveal");
  });
});
