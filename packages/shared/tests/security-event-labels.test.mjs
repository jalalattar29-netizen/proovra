/**
 * PV-LANG-001 — every security event type has a label an operator can read.
 *
 * The consoles title-cased every word of the stored identifier, so 104 of the
 * 382 types rendered their acronyms as words ("Sso", "Scim", "Mfa"). These
 * cases hold EVERY type in SECURITY_EVENT_TYPES to the rule, so a type added
 * tomorrow is held to it too.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { SECURITY_EVENT_TYPES, identifierLabel, securityEventLabel } from "../dist/index.js";

const MANGLED = /\b(Sso|Scim|Saml|Mfa|Totp|Otp|Rbac|Sla|Api|Ai|Ip|Url|Oidc|Jwt|Sms|Tsa|Kek|Kms|Pii|Mime|Csv|Pdf|Dns|Hmac|Ssrf)\b/;

test("every event type has a sentence-case label with no mangled acronym", () => {
  assert.ok(SECURITY_EVENT_TYPES.length > 300, "the full catalog is covered");
  const bad = [];
  for (const type of SECURITY_EVENT_TYPES) {
    const label = securityEventLabel(type);
    if (!label || label === type) bad.push(`${type}: no label`);
    else if (MANGLED.test(label)) bad.push(`${type}: "${label}" mangles an acronym`);
    else if (label[0] !== label[0].toUpperCase()) bad.push(`${type}: "${label}" does not start with a capital`);
    else if (/_/.test(label)) bad.push(`${type}: "${label}" still carries an underscore`);
  }
  assert.deepEqual(bad, []);
});

test("acronyms keep their conventional form, the rest is sentence case", () => {
  assert.equal(securityEventLabel("session_revoked"), "Session revoked");
  for (const [token, form] of [
    ["sso", "SSO"],
    ["scim", "SCIM"],
    ["saml", "SAML"],
    ["mfa", "MFA"],
  ]) {
    const type = SECURITY_EVENT_TYPES.find((t) => t.split("_").includes(token));
    assert.ok(type, `the catalog has a ${token} event`);
    const words = securityEventLabel(type).split(" ");
    assert.ok(words.includes(form), `${type} -> "${securityEventLabel(type)}" keeps ${form}`);
  }
});

test("PV-LANG-003 — identifierLabel reads any stored identifier as words", () => {
  assert.equal(identifierLabel("PENDING_DESTRUCTION"), "Pending destruction");
  assert.equal(identifierLabel("DEAD_LETTERED"), "Dead lettered");
  assert.equal(identifierLabel("sso_health_checked"), "SSO health checked");
  assert.equal(identifierLabel("identity.org_policy.read"), "Identity org policy read");
  assert.equal(identifierLabel("step-up"), "Step up");
  assert.equal(identifierLabel("ACTIVE"), "Active");
  assert.equal(identifierLabel(""), "");
});

test("an unknown or dotted identifier still reads as words", () => {
  assert.equal(securityEventLabel("admin.incident_resolve"), "Admin incident resolve");
  assert.equal(securityEventLabel("mfa_recovery_digest_failed"), "MFA recovery digest failed");
});
