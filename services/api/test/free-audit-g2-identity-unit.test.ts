/**
 * FREE-USER AUDIT 0ea0 — GROUP API-G2-IDENTITY, the pure pieces.
 *
 *   B3A-F-006 — the canonical CSV writer neutralises spreadsheet formulas in
 *               every text cell, and leaves typed scalars as they were.
 *   B1-F-014  — filing an MFA recovery request is an essential (terms-exempt)
 *               account path, like its cancel and resend.
 */
import { describe, expect, it } from "vitest";

import { neutralizeSpreadsheetFormula, toCsv } from "../src/services/reporting/csv-export.js";
import { legalAcceptanceExemptionFor } from "../src/middleware/legal-acceptance-route-policy.js";

describe("B3A-F-006 — CSV formula neutralisation", () => {
  type Row = { name: string; note: string | null; count: number; at: Date; ok: boolean };
  const cols = [
    { header: "name", value: (r: Row) => r.name },
    { header: "note", value: (r: Row) => r.note },
    { header: "count", value: (r: Row) => r.count },
    { header: "at", value: (r: Row) => r.at },
    { header: "ok", value: (r: Row) => r.ok },
  ];
  const at = new Date("2026-11-16T00:00:00.000Z");

  it("every formula trigger (= + - @ tab CR) in a text cell is prefixed with ' and quoted", () => {
    for (const evil of ["=1+1", "+1", "-1+2", "@SUM(A1)", "\tcmd", "\rcmd", '=HYPERLINK("http://x","y")']) {
      const csv = toCsv([{ name: evil, note: null, count: 1, at, ok: true }], cols);
      const cell = csv.split("\r\n")[1]!;
      expect(cell.startsWith(`"'`), JSON.stringify(cell)).toBe(true);
      expect(cell).toContain(`'${evil.replace(/"/g, '""')}`);
    }
  });

  it("the acceptance case: displayName '=1+1' exports as \"'=1+1\"", () => {
    const csv = toCsv([{ name: "=1+1", note: null, count: 0, at, ok: false }], cols);
    expect(csv.split("\r\n")[1]).toBe(`"'=1+1",,0,2026-11-16T00:00:00.000Z,false`);
  });

  it("ordinary text keeps its RFC-4180 byte shape; numbers (negative too), dates and booleans are untouched", () => {
    const csv = toCsv([{ name: "Ada, Lovelace", note: 'say "hi"', count: -3, at, ok: true }], cols);
    expect(csv).toBe(`name,note,count,at,ok\r\n"Ada, Lovelace","say ""hi""",-3,2026-11-16T00:00:00.000Z,true`);
    expect(neutralizeSpreadsheetFormula("plain")).toBe("plain");
    expect(neutralizeSpreadsheetFormula("a=b")).toBe("a=b");
  });
});

describe("B1-F-014 — filing an MFA recovery request is terms-exempt", () => {
  it("POST /v1/identity/mfa-admin/recovery-requests is an ACCOUNT exemption, like cancel and resend", () => {
    expect(legalAcceptanceExemptionFor("POST", "/v1/identity/mfa-admin/recovery-requests")).toEqual({ category: "ACCOUNT" });
    expect(legalAcceptanceExemptionFor("POST", "/v1/identity/mfa/recovery-requests/:requestId/cancel")).toEqual({
      category: "ACCOUNT",
    });
    // The administrator's decision on a request is not an essential path.
    expect(legalAcceptanceExemptionFor("POST", "/v1/identity/mfa-admin/recovery-requests/:requestId/approve")).toBeNull();
  });
});
