import { describe, it, expect } from "vitest";

import {
  redactAnalyticsPath,
  redactAnalyticsReferrer,
  shouldRejectAnalyticsEvent,
  classifyRouteType,
} from "../src/lib/route-classification";

describe("analytics path redaction", () => {
  it("redacts /verify/<token> to a stable safe path", () => {
    expect(redactAnalyticsPath("/verify/413dc332-d92f-40ef-8bd8-f02678e5ef97"))
      .toBe("/verify/[redacted]");
    expect(redactAnalyticsPath("/v/abc12345abc12345abc")).toBe("/v/[redacted]");
  });

  it("redacts evidence / cases / case / share / intake / portal", () => {
    expect(redactAnalyticsPath("/evidence/413dc332-d92f-40ef-8bd8-f02678e5ef97"))
      .toBe("/evidence/[redacted]");
    expect(redactAnalyticsPath("/cases/foo")).toBe("/cases/[redacted]");
    expect(redactAnalyticsPath("/case/foo")).toBe("/case/[redacted]");
    expect(redactAnalyticsPath("/share/xyz")).toBe("/share/[redacted]");
    expect(redactAnalyticsPath("/intake/xyz")).toBe("/intake/[redacted]");
    expect(redactAnalyticsPath("/portal/xyz")).toBe("/portal/[redacted]");
  });

  it("redacts OAuth callback paths and offline-verifier", () => {
    expect(redactAnalyticsPath("/auth/callback?code=abc&state=xyz"))
      .toBe("/auth/callback/[redacted]");
    expect(redactAnalyticsPath("/offline-verifier/foo"))
      .toBe("/offline-verifier/[redacted]");
  });

  it("strips query strings on any path", () => {
    expect(redactAnalyticsPath("/pricing?utm_source=foo")).toBe("/pricing");
  });

  it("scrubs UUIDs anywhere in non-sensitive paths", () => {
    expect(
      redactAnalyticsPath("/random/413dc332-d92f-40ef-8bd8-f02678e5ef97/edit"),
    ).toBe("/random/[uuid]/edit");
  });

  it("leaves marketing pages untouched", () => {
    expect(redactAnalyticsPath("/pricing")).toBe("/pricing");
    expect(redactAnalyticsPath("/about")).toBe("/about");
    expect(redactAnalyticsPath("/")).toBe("/");
  });

  it("returns null for null/empty input", () => {
    expect(redactAnalyticsPath(null)).toBeNull();
    expect(redactAnalyticsPath(undefined)).toBeNull();
    expect(redactAnalyticsPath("")).toBeNull();
  });
});

describe("analytics referrer redaction", () => {
  it("preserves the host but redacts the path", () => {
    expect(
      redactAnalyticsReferrer(
        "https://app.proovra.com/verify/413dc332-d92f-40ef-8bd8-f02678e5ef97",
      ),
    ).toBe("https://app.proovra.com/verify/[redacted]");
  });

  it("handles relative referrer values", () => {
    expect(redactAnalyticsReferrer("/share/foo")).toBe("/share/[redacted]");
  });

  it("returns null for empty values", () => {
    expect(redactAnalyticsReferrer(null)).toBeNull();
    expect(redactAnalyticsReferrer("")).toBeNull();
  });
});

describe("shouldRejectAnalyticsEvent", () => {
  it("rejects page_view on /verify, /v, /share, /intake, /portal, /auth", () => {
    expect(shouldRejectAnalyticsEvent("page_view", "/verify/x")).toBe(true);
    expect(shouldRejectAnalyticsEvent("page_view", "/v/abc")).toBe(true);
    expect(shouldRejectAnalyticsEvent("page_view", "/share/x")).toBe(true);
    expect(shouldRejectAnalyticsEvent("page_view", "/intake/x")).toBe(true);
    expect(shouldRejectAnalyticsEvent("page_view", "/portal/x")).toBe(true);
    expect(shouldRejectAnalyticsEvent("page_view", "/auth/callback")).toBe(true);
  });

  it("allows page_view on app and marketing routes", () => {
    expect(shouldRejectAnalyticsEvent("page_view", "/home")).toBe(false);
    expect(shouldRejectAnalyticsEvent("page_view", "/pricing")).toBe(false);
    expect(shouldRejectAnalyticsEvent("page_view", "/")).toBe(false);
  });

  it("allows non-page_view events on any route", () => {
    expect(shouldRejectAnalyticsEvent("evidence_created", "/verify/x")).toBe(
      false,
    );
  });
});

describe("classifyRouteType (unchanged by redaction)", () => {
  it("still classifies /verify as public", () => {
    expect(classifyRouteType("/verify/anything")).toBe("public");
  });
});
