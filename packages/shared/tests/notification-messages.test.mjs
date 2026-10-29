/**
 * SERVER-WRITTEN NOTIFICATIONS IN THE READER'S WORDS.
 *
 * The inbox route writes each item's title/body in English and sends the same
 * text as a structured message. This proves, for EVERY message key:
 *   - English renders exactly the sentence the route writes (the expected
 *     strings below are the route's templates filled with the same params);
 *   - German and Arabic render a complete sentence: no placeholder left, no
 *     raw enum code, not the English text again;
 *   - user content (names, titles, notes, summaries) is carried verbatim;
 *   - an unknown key (a newer server) renders nothing, so the client keeps the
 *     server's English rather than inventing text.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  NOTIFICATION_MESSAGE_KEYS,
  formatTimestampForReportUtc,
  notificationItemText,
  notificationShowingLine,
  readNotificationMessage,
  renderNotificationMessage,
} from "../dist/index.js";

const EXPIRES = "2026-11-02T09:30:00.000Z";
const at = formatTimestampForReportUtc(new Date(EXPIRES));

/** key → [params, the route's English title, the route's English body]. */
const CASES = {
  "onboarding.no_organization": [{}, "You haven't joined an organization yet", "Organizations group workspaces for governance, members, and audit. Create one, or accept an invite token."],
  "onboarding.no_email": [{}, "Add an email to your account", "Email-matched invites and audit-trail attribution require an email identity."],
  org_invite: [{ org: "Acme Legal", role: "ORG_ADMIN", expiresAt: EXPIRES }, "Organization invite waiting: Acme Legal", `You have been invited to join Acme Legal as an administrator. Accept before ${at}.`],
  "org_admin.pending_invites": [{ org: "Acme Legal", count: 3 }, "3 pending invites in Acme Legal", "As an admin you can resend or revoke open invites from this organization's detail page."],
  "review.conflict": [{}, "Reviewer conflict — adjudication required", "Two reviewers disagreed on this workflow. As team OWNER/ADMIN you can resolve it via the multi-stage review panel."],
  "review.awaiting_second": [{}, "Your first-stage decision is awaiting peer review", "Independence policy requires a different reviewer to submit the second-stage decision. No action needed from you."],
  governance: [{ kind: "LEGAL_HOLD_PLACED", team: "Claims", occurrences: 4 }, "Legal hold placed — Claims", "A legal hold has been placed on evidence in this workspace. Seen 4 times."],
  "discussion.mention": [{ thread: "Please review this record" }, 'You were mentioned in "Please review this record"', "A reviewer or investigator @-mentioned you in a workspace discussion. Open the thread to respond."],
  "discussion.assigned": [{ thread: "Gap in custody", status: "IN_PROGRESS", escalated: 1 }, 'Discussion assigned to you: "Gap in custody"', "An escalated discussion is assigned to you. Status: In progress."],
  "escalation.assigned": [{ reason: "NO_REVIEWER_ASSIGNED", summary: "Workflow W-12 has waited 3 days." }, "Escalation assigned to you: No reviewer assigned", "Workflow W-12 has waited 3 days."],
  access_review: [{ kind: "STALE_ACCESS", subject: 1, overdue: 0 }, "Your access is being reviewed", "Stale access review. Open the access reviews console to certify, revoke, or suspend."],
  mfa_recovery: [{ team: "Claims", approvals: 1, required: 2 }, "MFA recovery request pending — Claims", "A member has requested a lost-factor reset. Approvals: 1/2. Quorum-based approval forces re-enrollment; it does NOT grant a session."],
  communication_failure: [{ channel: "EMAIL", purpose: "INTAKE_LINK", team: "Claims", recipient: "j***@example.test", attempts: 3 }, "Failed email delivery — Claims", "An intake link to j***@example.test failed after 3 attempts. Open Messaging operations to retry or cancel."],
  security_alert: [{ eventType: "password_changed" }, "Security alert: Password changed", "A high-severity event on your account was recorded. Open Account security to review the timeline."],
  report_failure: [{ team: "Claims", acknowledged: 1, occurrences: 2, conditionCode: null, conditionParams: null, summary: "Report generation failed for one record." }, "Report generation failure — Claims (acknowledged)", "Report generation failed for one record. Seen 2 times."],
  package_failure: [{ team: null, acknowledged: 0, occurrences: 1, summary: "Package failed." }, "Verification package failure — workspace", "Package failed."],
  ots_failure: [{ evidence: "photo.jpg", chain: 1, code: "OTS_CHAIN_VERIFICATION_FAILED" }, "Bitcoin verification failed — photo.jpg", "The OpenTimestamps proof does not match the referenced block in the active Bitcoin main chain. Open the evidence Integrity tab for the verification details and operator runbook."],
  tsa_failure: [{ evidence: "photo.jpg", reason: null }, "Trusted timestamp failed — photo.jpg", "Timestamping failed. The record remains sealed and signed, and OpenTimestamps anchoring proceeds independently. A trusted timestamp cannot be issued later for the sealing moment. Open the evidence Integrity tab for the timestamping status."],
  case_assignment: [{ case: "Harbour fire", role: "INVESTIGATOR", note: null }, 'Case assigned to you: "Harbour fire"', "Role: investigator. Open the case to begin."],
  "intake.review": [{ team: "Claims", title: "Site photos", status: "UNDER_REVIEW" }, "Intake submission awaiting review — Claims", '"Site photos" is in under review state with no assigned reviewer. Open evidence requests to claim it.'],
  "intake.incomplete": [{ team: "Claims", title: null, moreInfo: 1 }, "Intake incomplete — Claims", '"Untitled request" cannot complete because the reviewer requested more information. Open evidence requests for the checklist.'],
  "intake.link_expiring": [{ team: "Claims", expiresAt: EXPIRES, used: 2, max: 5 }, "Intake link expiring soon — Claims", `An active intake link (2/5 uses) expires on ${at}. Open intake links to renew or revoke.`],
  collaboration: [{ type: "ASSIGNMENT_ASSIGNED", title: "Work assigned to you", body: "You have been made responsible for a record assigned to your team." }, "Work assigned to you", "You have been made responsible for a record assigned to your team."],
  "history.unavailable": [{}, "[No longer accessible — workspace access removed]", "This historical item belongs to a workspace you no longer have access to."],
};

const RAW_CODE = /\b[A-Z]{2,}(?:_[A-Z0-9]{2,})+\b/;

test("every message key has a case here (the closed set is covered)", () => {
  assert.deepEqual(Object.keys(CASES).sort(), [...NOTIFICATION_MESSAGE_KEYS].sort());
});

for (const [key, [params, title, body]] of Object.entries(CASES)) {
  test(`${key}: English is the route's sentence`, () => {
    assert.deepEqual(renderNotificationMessage("en", { key, params }), { title, body });
  });
  test(`${key}: German and Arabic are complete and not English`, () => {
    for (const locale of ["de", "ar"]) {
      const said = renderNotificationMessage(locale, { key, params });
      assert.ok(said, `${locale} renders`);
      for (const part of [said.title, said.body]) {
        assert.doesNotMatch(part, /\{\w+\}/, `${locale}: placeholder left in ${part}`);
        assert.doesNotMatch(part.replace(/OTS_|OWNER\/ADMIN/g, ""), RAW_CODE, `${locale}: raw code in ${part}`);
      }
      assert.notEqual(said.title, title, `${locale} title is still English`);
    }
  });
}

test("user content is carried verbatim in every locale", () => {
  for (const locale of ["en", "de", "ar"]) {
    const m = renderNotificationMessage(locale, { key: "discussion.mention", params: { thread: "Beweis «A» & <b>" } });
    assert.ok(m.title.includes("Beweis «A» & <b>"));
    const esc = renderNotificationMessage(locale, { key: "escalation.assigned", params: { reason: "REVIEW_OVERDUE", summary: "Stored summary." } });
    assert.equal(esc.body, "Stored summary.");
    const note = renderNotificationMessage(locale, { key: "case_assignment", params: { case: "X", role: "OWNER", note: "Call the insurer." } });
    assert.ok(note.body.endsWith("Call the insurer."));
  }
});

test("a comment mention keeps the member's words; a fixed assignment body is translated", () => {
  const mention = { key: "collaboration", params: { type: "MENTION_IN_COMMENT", title: "You were mentioned in a team comment", body: "Bitte prüfen." } };
  assert.equal(renderNotificationMessage("ar", mention).body, "Bitte prüfen.");
  const assigned = renderNotificationMessage("de", CASES.collaboration[0] && { key: "collaboration", params: CASES.collaboration[0] });
  assert.equal(assigned.title, "Ihnen zugewiesene Arbeit");
  assert.match(assigned.body, /verantwortlich/);
});

test("German and Arabic dates are the reader's calendar words, in UTC", () => {
  const de = renderNotificationMessage("de", { key: "org_invite", params: CASES.org_invite[0] });
  assert.match(de.body, /2\. Nov\. 2026.*UTC/);
  const ar = renderNotificationMessage("ar", { key: "org_invite", params: CASES.org_invite[0] });
  assert.match(ar.body, /نوفمبر.*UTC/);
});

test("condition codes are said in the reader's language when the incident carries one", () => {
  const params = {
    team: "Claims",
    acknowledged: 0,
    occurrences: 1,
    conditionCode: "ops.pipeline.report_generation_failed.sanitized",
    conditionParams: "{}",
    summary: "Stored.",
  };
  const en = renderNotificationMessage("en", { key: "report_failure", params });
  const de = renderNotificationMessage("de", { key: "report_failure", params });
  assert.match(en.body, /^This record's report could not be generated\./);
  assert.match(de.body, /^Der Bericht dieses Datensatzes konnte nicht erstellt werden\./);
  // Unknown or invalid codes fall back to the stored summary verbatim.
  const bad = renderNotificationMessage("de", { key: "report_failure", params: { ...params, conditionCode: "not.a.code" } });
  assert.equal(bad.body, "Stored.");
});

test("unknown keys and unknown collaboration types render nothing — the client keeps the server's English", () => {
  assert.equal(renderNotificationMessage("de", { key: "future.kind", params: {} }), null);
  assert.equal(renderNotificationMessage("de", { key: "collaboration", params: { type: "DISCUSSION_REPLY" } }), null);
  const item = { title: "Server English", body: "Body", message: { key: "future.kind", params: {} } };
  assert.deepEqual(notificationItemText("ar", item), { title: "Server English", body: "Body" });
  assert.deepEqual(notificationItemText("de", { title: "T", body: "B" }), { title: "T", body: "B" });
});

test("a served message is read defensively", () => {
  assert.equal(readNotificationMessage(null), null);
  assert.equal(readNotificationMessage({ key: 7 }), null);
  assert.deepEqual(readNotificationMessage({ key: "k", params: { a: "x", b: 2, c: null, d: { nested: 1 }, e: true } }), {
    key: "k",
    params: { a: "x", b: 2, c: null },
  });
});

test("the Showing line: English unchanged; German and Arabic state the same facts", () => {
  const facts = { shown: 3, total: 5, archived: false, view: "read", englishNoun: "read notifications" };
  assert.equal(notificationShowingLine("en", facts), "Showing 3 of 5 read notifications");
  assert.equal(notificationShowingLine("en", { ...facts, total: null }), "Showing 3 read notifications (more may exist)");
  assert.equal(notificationShowingLine("de", facts), "Angezeigt: 3 von 5 · Gelesen");
  assert.equal(notificationShowingLine("ar", { ...facts, archived: true, view: "high" }), "المعروض: 3 من 5 · مؤرشفة · مرتفع");
  assert.equal(notificationShowingLine("de", { ...facts, view: "all", total: null }), "Angezeigt: 3 (möglicherweise mehr)");
});

test("escalation routed to the workspace's admins says so, never 'assigned to you' (2026-10-23)", () => {
  const m = renderNotificationMessage("en", {
    key: "escalation.assigned",
    params: { reason: "REVIEWER_ESCALATED", summary: "Needs counsel review", toWorkspace: 1 },
  });
  assert.equal(m.title, "Review escalated to your workspace's admins: Escalated by a reviewer");
  assert.equal(m.body, "Needs counsel review");
});
