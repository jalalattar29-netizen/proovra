/**
 * The ACCOUNT timezone is validated, like every other timezone this product
 * stores.
 *
 * `PATCH /v1/users/me` wrote `timezone` through a generic bounded-string
 * helper: anything up to 64 characters was accepted and persisted. So "Syria"
 * — a country, not a zone — became the account timezone, and the digest
 * scheduler inherits exactly that column when a workspace has no override.
 *
 * The notification-schedule route has always checked this with
 * `isValidIanaTimezone`. The account value, which that route falls back to,
 * had no check at all. Same validator now, not a second one.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isValidIanaTimezone } from "@proovra/shared";

const USERS_ROUTES = readFileSync(
  fileURLToPath(new URL("../src/routes/users.routes.ts", import.meta.url)),
  "utf8",
);

describe("IANA validation — the shared authority", () => {
  it("accepts real zones and refuses the things people actually type", () => {
    expect(isValidIanaTimezone("Asia/Damascus")).toBe(true);
    expect(isValidIanaTimezone("Europe/Berlin")).toBe(true);
    expect(isValidIanaTimezone("America/New_York")).toBe(true);
    expect(isValidIanaTimezone("UTC")).toBe(true);

    // A country is not a timezone. This is the reported case.
    expect(isValidIanaTimezone("Syria")).toBe(false);
    expect(isValidIanaTimezone("Germany")).toBe(false);
    expect(isValidIanaTimezone("")).toBe(false);
    expect(isValidIanaTimezone("not a zone")).toBe(false);
    expect(isValidIanaTimezone("GMT+3")).toBe(false);

    // OFFSETS FOLLOW THE RUNTIME, and the validator must AGREE with it —
    // that is the property, not any fixed answer. Newer ICU resolves
    // "+03:00" per ECMA-402's offset time zones; Node 20's ICU throws on
    // it. Pinning `true` here encoded one runtime's ICU as a fact and
    // failed on CI's Node 20 while passing on local Node 24, for code
    // nobody had touched. The selector never offers an offset, so whichever
    // way the runtime answers, none can arrive from this product.
    const runtimeAcceptsOffsets = (() => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: "+03:00" });
        return true;
      } catch {
        return false;
      }
    })();
    expect(isValidIanaTimezone("+03:00")).toBe(runtimeAcceptsOffsets);
  });
});

describe("PATCH /v1/users/me enforces it", () => {
  it("validates the timezone with the shared checker, not a local one", () => {
    expect(USERS_ROUTES).toContain(
      'import { isValidIanaTimezone } from "@proovra/shared"',
    );
    expect(USERS_ROUTES).toMatch(/!isValidIanaTimezone\(tz\)/);
    // A rejection is a 400 with a bounded reason, not a silent write.
    expect(USERS_ROUTES).toMatch(/error: "invalid_timezone"/);
    expect(USERS_ROUTES).toMatch(/reply\.code\(400\)/);
  });

  it("no longer writes the timezone through the generic string helper", () => {
    // `setStr("timezone", 64)` is what let any 64-char string through.
    expect(USERS_ROUTES).not.toMatch(/setStr\("timezone"/);
    expect(USERS_ROUTES).not.toMatch(
      /key: "displayName" \| "firstName" \| "lastName" \| "avatarUrl" \| "locale" \| "timezone"/,
    );
  });

  it("clearing the timezone is still allowed", () => {
    // Null is "no account timezone", which the scheduler already handles by
    // falling back to UTC. Validation must not turn that into an error.
    expect(USERS_ROUTES).toMatch(/body\.timezone === null[\s\S]{0,80}data\.timezone = null/);
    expect(USERS_ROUTES).toMatch(/tz\.length > 0 && !isValidIanaTimezone\(tz\)/);
  });
});
