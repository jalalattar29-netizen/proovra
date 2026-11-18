/**
 * B7A-F-006 — the owner's key-compromise notice is minimal: it names no key
 * identity, fingerprint, operator reason, record title or content; it says the
 * record and its issued outputs are unchanged, what verification now shows,
 * and (only when a replacement can be issued) that one can be requested.
 */
import { describe, expect, it } from "vitest";

import { NOTIFICATION_EVENT_TYPES } from "@proovra/shared";

import { renderTransactionalTemplate } from "../src/services/notifications/templates.js";

describe("B7A-F-006 — SIGNING_KEY_COMPROMISE_NOTICE", () => {
  it("is a registered transactional e-mail type", () => {
    expect(NOTIFICATION_EVENT_TYPES).toContain("SIGNING_KEY_COMPROMISE_NOTICE");
  });

  it("renders minimal copy: no key, fingerprint, reason or record content", () => {
    const r = renderTransactionalTemplate("SIGNING_KEY_COMPROMISE_NOTICE", {
      kind: "SigningKeyCompromiseNotice",
      data: { actionUrl: "https://app.example.test/evidence/00000000-0000-0000-0000-000000000001", replacementAvailable: true },
    });
    const all = `${r.subject}\n${r.text}\n${r.html}`;
    expect(r.subject).toMatch(/signing key/i);
    expect(r.text).toMatch(/stay exactly as they were/);
    expect(r.text).toMatch(/revoked key/);
    expect(r.text).toMatch(/request a replacement verification package/);
    expect(r.text).toContain("https://app.example.test/evidence/00000000-0000-0000-0000-000000000001");
    for (const leak of [/fingerprint/i, /sha-?256/i, /key ?id/i, /kms/i, /operator/i, /compromis/i]) {
      expect(all).not.toMatch(leak);
    }
  });

  it("does not offer a replacement when none can be issued", () => {
    const r = renderTransactionalTemplate("SIGNING_KEY_COMPROMISE_NOTICE", {
      kind: "SigningKeyCompromiseNotice",
      data: { actionUrl: null, replacementAvailable: false },
    });
    expect(r.text).not.toMatch(/replacement/);
    expect(r.text).not.toMatch(/Open:/);
  });

  const LEAKS = [/fingerprint/i, /sha-?256/i, /key ?id/i, /kms/i, /operator/i, /compromis/i];

  it("B7A-F-006 final: outputs no replacement restores are stated plainly, never implied replaced", () => {
    const r = renderTransactionalTemplate("SIGNING_KEY_COMPROMISE_NOTICE", {
      kind: "SigningKeyCompromiseNotice",
      data: {
        actionUrl: "https://app.example.test/evidence/x",
        replacementAvailable: false,
        notReplaceable: ["RECORD_SIGNATURE", "CUSTODY_ATTESTATIONS"],
      },
    });
    expect(r.text).toMatch(/cannot re-sign the record without changing its history/);
    expect(r.text).toMatch(/Custody-event attestations made with that key are not re-signed/);
    expect(r.text).not.toMatch(/You can request a replacement/);
    for (const leak of LEAKS) expect([r.subject, r.text, r.html].join("\n")).not.toMatch(leak);
  });

  it("B7A-F-006 final: a destruction certificate notice says it is kept and is not re-issued", () => {
    const r = renderTransactionalTemplate("SIGNING_KEY_COMPROMISE_NOTICE", {
      kind: "SigningKeyCompromiseNotice",
      data: { actionUrl: "https://app.example.test/governance/destruction", replacementAvailable: false, subject: "destruction_certificate" },
    });
    expect(r.subject).toMatch(/destruction certificate/);
    expect(r.text).toMatch(/kept exactly as it was/);
    expect(r.text).toMatch(/not re-issued and no replacement certificate is available/);
    expect(r.text).not.toMatch(/You can request a replacement/);
    expect(r.text).toContain("https://app.example.test/governance/destruction");
    for (const leak of LEAKS) expect([r.subject, r.text, r.html].join("\n")).not.toMatch(leak);
  });
});
