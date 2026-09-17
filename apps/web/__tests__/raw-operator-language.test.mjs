/**
 * PV-LANG-003 — stored identifiers are not operator language.
 *
 * The audit counted 198 places across the administrative and enterprise
 * surfaces where an operator read an enum member, a permission key or a
 * machine code as if it were a sentence. `scripts/raw-operator-language.mjs`
 * is the standing rule; this file holds the product to it:
 *
 *   1. The scanner itself — what it catches and what it deliberately leaves.
 *   2. Every file the audit cited (at its current path) has ZERO findings.
 *   3. The rest of the product cannot get worse: the app-wide count is a
 *      ratchet that only moves down.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { scanSource, scanWeb } from "../scripts/raw-operator-language.mjs";

const rules = (src) => scanSource("fixture.tsx", src).map((f) => `${f.rule}:${f.value}`);

test("the scanner catches an enum rendered as text, in a text prop, and an identifier literal", () => {
  assert.deepEqual(rules(`const a = <td>{r.status}</td>;`), ["ENUM_CHILD:r.status"]);
  assert.deepEqual(rules(`const a = <p>Role: {workspace.role}</p>;`), ["ENUM_CHILD:workspace.role"]);
  assert.deepEqual(rules(`const a = <KV k="Status" v={snapshot.status} />;`), ["ENUM_PROP:snapshot.status"]);
  assert.deepEqual(rules(`const a = <Chip label="INVALID_EMAIL" />;`), ["LITERAL_TEXT:INVALID_EMAIL"]);
  assert.deepEqual(rules(`const a = <p>Needs the ORG_ADMIN role.</p>;`), ["LITERAL_TEXT:ORG_ADMIN"]);
  assert.deepEqual(rules(`const a = <li>{p.permission}</li>;`), ["ENUM_CHILD:p.permission"]);
});

test("the scanner leaves what an operator never reads, labels, and declared identifiers", () => {
  const clean = [
    `const a = <tr key={r.status} data-state={r.state} />;`,
    `const a = <option value={r.kind}>{kindLabel(r.kind)}</option>;`,
    `const a = <td>{statusLabel(r.status)}</td>;`,
    `const OPTIONS = [{ value: "PAST_DUE", label: "Past due" }];`,
    `const a = <code data-identifier>{r.eventType}</code>;`,
    `const a = <p>Use a sender, e.g. a support address — a.k.a. the reply-to.</p>;`,
    `const a = <p>{r.description}</p>;`,
  ];
  for (const src of clean) assert.deepEqual(rules(src), [], src);
  // A <code> WITHOUT the declaration is still the primary text.
  assert.deepEqual(rules(`const a = <code>{r.eventType}</code>;`), ["ENUM_CHILD:r.eventType"]);
});

/**
 * Every file the PV-LANG-003 audit cited, at its current path (the identity
 * console moved under /security-center/identity, automation and analytics
 * under /operations). These are held to zero.
 */
const AUDITED_FILES = [
  "app/(app)/admin/billing/page.tsx",
  "app/(app)/admin/contact-sales/[id]/page.tsx",
  "app/(app)/admin/contact-sales/page.tsx",
  "app/(app)/admin/customers/[id]/page.tsx",
  "app/(app)/admin/demo-requests/page.tsx",
  "app/(app)/admin/evidence-ops/page.tsx",
  "app/(app)/admin/evidence-ops/records/page.tsx",
  "app/(app)/admin/operations/_sections/PlatformSecurityEvents.tsx",
  "app/(app)/admin/page.tsx",
  "app/(app)/admin/platform/exports/page.tsx",
  "app/(app)/admin/platform/media-graph/page.tsx",
  "app/(app)/admin/platform/observability/page.tsx",
  "app/(app)/admin/platform/recovery/page.tsx",
  "app/(app)/admin/platform/runbooks/page.tsx",
  "app/(app)/admin/platform/signers/page.tsx",
  "app/(app)/admin/search/page.tsx",
  "app/(app)/admin/timeline/page.tsx",
  "app/(app)/admin/users/[id]/page.tsx",
  "app/(app)/admin/users/_sections/LifecycleRequestQueue.tsx",
  "app/(app)/admin/users/page.tsx",
  "app/(app)/admin/workspaces/[id]/page.tsx",
  "app/(app)/audit-transparency/page.tsx",
  "app/(app)/budget-center/page.tsx",
  "app/(app)/collaboration-teams/[teamId]/_tabs/ActivityTab.tsx",
  "app/(app)/collaboration-teams/[teamId]/_tabs/MembersTab.tsx",
  "app/(app)/collaboration-teams/page.tsx",
  "app/(app)/evidence-lifecycle/archive/page.tsx",
  "app/(app)/evidence-lifecycle/chain-transfers/page.tsx",
  "app/(app)/evidence-lifecycle/destruction/page.tsx",
  "app/(app)/evidence-lifecycle/legal-holds/page.tsx",
  "app/(app)/evidence-lifecycle/page.tsx",
  "app/(app)/evidence-lifecycle/retention/page.tsx",
  "app/(app)/evidence-lifecycle/webhooks/page.tsx",
  "app/(app)/exchange/page.tsx",
  "app/(app)/governance-platform/cross-org/page.tsx",
  "app/(app)/governance-platform/departments/page.tsx",
  "app/(app)/governance-platform/policies/page.tsx",
  "app/(app)/governance/destruction/page.tsx",
  "app/(app)/governance/retention/page.tsx",
  "app/(app)/intake-links/page.tsx",
  "app/(app)/integrations/_sections/EvidenceDeliveryHistorySection.tsx",
  "app/(app)/intelligence-quality/_sections/IntelligenceRecordsPanel.tsx",
  "app/(app)/intelligence-quality/page.tsx",
  "app/(app)/investigation/graph/_sections/GraphCurationPanel.tsx",
  "app/(app)/investigation/page.tsx",
  "app/(app)/operations/_components/FilterToolbar.tsx",
  "app/(app)/operations/analytics/page.tsx",
  "app/(app)/operations/automation/page.tsx",
  "app/(app)/operations/health/page.tsx",
  "app/(app)/organizations/[id]/admin/audit/page.tsx",
  "app/(app)/organizations/[id]/admin/domains/page.tsx",
  "app/(app)/organizations/[id]/admin/governance/external-reviewers/page.tsx",
  "app/(app)/organizations/[id]/admin/governance/page.tsx",
  "app/(app)/organizations/[id]/admin/integrations/page.tsx",
  "app/(app)/organizations/[id]/admin/overview/page.tsx",
  "app/(app)/organizations/[id]/admin/readiness/page.tsx",
  "app/(app)/organizations/[id]/page.tsx",
  "app/(app)/packaging/page.tsx",
  "app/(app)/redaction/[projectId]/page.tsx",
  "app/(app)/redaction/page.tsx",
  "app/(app)/redaction/policy/page.tsx",
  "app/(app)/review/external/page.tsx",
  "app/(app)/review/qc/page.tsx",
  "app/(app)/review/queues/page.tsx",
  "app/(app)/review/workspace/page.tsx",
  "app/(app)/reviewer-ops/[reviewId]/page.tsx",
  "app/(app)/reviewer-ops/escalations/page.tsx",
  "app/(app)/reviewer-ops/sla/page.tsx",
  "app/(app)/search/page.tsx",
  "app/(app)/security-center/identity/_sections/MembersSection.tsx",
  "app/(app)/security-center/identity/_sections/SessionGovernanceSection.tsx",
  "app/(app)/security-center/identity/access-reviews/page.tsx",
  "app/(app)/security-center/identity/permission-matrix/page.tsx",
  "app/(app)/security-center/identity/runtime/page.tsx",
  "app/(app)/security-center/identity/scim/page.tsx",
  "app/(app)/security-center/identity/sessions/_sections/ActiveSessionsSection.tsx",
  "app/(app)/security-center/identity/sessions/_sections/SessionTimelineDrawer.tsx",
  "app/(app)/security-center/identity/sessions/_sections/UserRiskSection.tsx",
  "app/(app)/security-center/mfa-recovery/page.tsx",
  "app/(app)/security-center/page.tsx",
  "app/(app)/security-center/posture/_sections/MfaMemberPostureSection.tsx",
  "app/(app)/security-center/sso/health/page.tsx",
  "app/(app)/security-center/sso/mapping/page.tsx",
  "app/(app)/security-center/sso/page.tsx",
  "app/(app)/settings/_sections/AiReadOnlyView.tsx",
  "app/(app)/settings/_sections/LegalAcceptanceStatusCard.tsx",
  "app/(app)/settings/_sections/PrivacySection.tsx",
  "app/(app)/settings/notifications/deliveries/page.tsx",
  "app/(app)/workflows/[id]/page.tsx",
];

const ALL = scanWeb();

test("every file the audit cited renders no stored identifier as operator text", () => {
  const audited = new Set(AUDITED_FILES);
  const hits = ALL.filter((f) => audited.has(f.file)).map(
    (f) => `${f.rule} ${f.file}:${f.line} ${f.value}`,
  );
  assert.deepEqual(hits, []);
});

/**
 * The rest of the product, outside the audited surfaces, still carries raw
 * identifiers (recorded as a follow-up in the closure ledger). This ratchet
 * only moves DOWN: fixing one lowers it, adding one fails here. Measured
 * after the PV-LANG-003 fixes: 394 before, 247 after.
 */
const APP_WIDE_CEILING = 247;

test("the app-wide count of raw identifiers does not grow", () => {
  assert.ok(
    ALL.length <= APP_WIDE_CEILING,
    `${ALL.length} raw identifier(s) app-wide; the ceiling is ${APP_WIDE_CEILING}`,
  );
});

test("the scanner follows a value through a condition, a fallback and a template", () => {
  assert.deepEqual(rules("const a = <p>{r.outcome ?? \"unknown\"}</p>;"), ["ENUM_CHILD:r.outcome"]);
  assert.deepEqual(rules("const a = <p>{LABEL[r.status] ?? r.status}</p>;"), ["ENUM_CHILD:r.status"]);
  assert.deepEqual(rules("const a = <p>{r.category ? ` · ${r.category}` : \"\"}</p>;"), ["ENUM_CHILD:r.category"]);
  assert.deepEqual(rules("const a = <Pill label={`Role: ${w.role}`} />;"), ["ENUM_PROP:w.role"]);
  // A field read only in the CONDITION is not rendered.
  assert.deepEqual(rules("const a = <p>{r.status === \"OK\" ? \"Fine\" : \"Broken\"}</p>;"), []);
  // A call ends the search: that is a label.
  assert.deepEqual(rules("const a = <p>{LABEL[r.status] ?? identifierLabel(r.status)}</p>;"), []);
});

test("an allowance names its reason at the site, and every allowance is listed", () => {
  const allowed = [
    "const a = (<div>",
    "  {/* raw-identifier-ok: state.status here is the HTTP status number of a failed read */}",
    "  {`Could not load (HTTP ${state.status})`}",
    "</div>);",
  ].join("\n");
  assert.deepEqual(rules(allowed), []);
  // A marker without a reason is not an allowance.
  assert.deepEqual(
    rules("const a = (<div>\n  {/* raw-identifier-ok: */}\n  {r.status}\n</div>);"),
    ["ENUM_CHILD:r.status"],
  );
});
