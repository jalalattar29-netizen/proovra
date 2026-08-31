/**
 * The page-view event contract, end to end through the layers that decide it.
 *
 * A consenting visitor's page view used to be answered 422. The ingest
 * allowlist held eight UPPER_SNAKE_CASE names that nothing emitted and nothing
 * downstream could classify, while `page_view` — the name the persistence
 * layer, the admin dashboard filters, the overview service and the sensitive
 * route rejection are all built around — was not in it. Page-view analytics
 * therefore collected nothing, and every navigation logged a console error.
 *
 * This suite pins both halves of the fix: the event is ACCEPTED at ingest, and
 * it is UNDERSTOOD by everything it reaches afterwards. Proving only the first
 * would allow the opposite failure — a 200 for an event that is silently
 * dropped or filed as "custom" and never appears on a dashboard.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ANALYTICS_EVENT_NAMES } from "@proovra/shared";

import { AnalyticsTrackSchema } from "../src/routes/analytics.routes.js";
import {
  classifyEventClass,
  classifySeverity,
  humanizeEventType,
} from "../src/services/analytics-event.service.js";
import {
  classifyRouteType,
  shouldRejectAnalyticsEvent,
} from "../src/lib/route-classification.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/** A complete, valid beacon payload — the shape the web client actually sends. */
function beaconPayload(eventType: string) {
  return {
    eventType,
    visitorId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    path: "/pricing",
    referrer: null,
    metadata: {
      routeType: "public",
      displayLabel: "Page View",
      eventClass: "navigation",
      severity: "info",
      path: "/pricing",
    },
  };
}

describe("analytics ingest accepts the page view the client sends", () => {
  it("accepts a well-formed page_view", () => {
    const parsed = AnalyticsTrackSchema.safeParse(beaconPayload("page_view"));
    expect(
      parsed.success,
      parsed.success ? "" : JSON.stringify(parsed.error.issues),
    ).toBe(true);
  });

  it("still rejects an event name that is not on the allowlist", () => {
    // The fix must not have loosened validation into "any string".
    for (const forged of [
      "billing_payment_succeeded", // server-asserted: a browser may not claim it
      "evidence_created",
      "page_views",
      "PAGE_VIEW",
      "",
    ]) {
      expect(
        AnalyticsTrackSchema.safeParse(beaconPayload(forged)).success,
        `"${forged}" must not be ingestible`,
      ).toBe(false);
    }
  });

  it("rejects the retired UPPER_SNAKE_CASE names", () => {
    for (const retired of [
      "VERIFY_VIEW",
      "REPORT_DOWNLOAD",
      "PACKAGE_DOWNLOAD",
      "CAPTURE_STARTED",
      "CAPTURE_COMPLETED",
      "AI_ASSISTANT_OPENED",
      "PUBLIC_VERIFY_OPENED",
      "REVIEW_SESSION_STARTED",
    ]) {
      expect(
        AnalyticsTrackSchema.safeParse(beaconPayload(retired)).success,
        `"${retired}" was never emitted and cannot be classified`,
      ).toBe(false);
    }
  });
});

describe("every ingestible event is understood downstream", () => {
  it("classifies, labels and grades each allowlisted name", () => {
    for (const name of ANALYTICS_EVENT_NAMES) {
      expect(classifyEventClass(name), `${name} event class`).not.toBe("custom");
      expect(humanizeEventType(name), `${name} label`).toBeTruthy();
      expect(classifySeverity(name), `${name} severity`).toBe("info");
    }
  });

  it("files page_view as navigation, labelled, at info severity", () => {
    expect(classifyEventClass("page_view")).toBe("navigation");
    expect(humanizeEventType("page_view")).toBe("Page View");
    expect(classifySeverity("page_view")).toBe("info");
  });

  it("is the exact string the dashboard and overview consumers query", () => {
    // These read `eventType` with an equality filter, so an ingest name that
    // drifted by even a character would return 200 and populate nothing.
    const overview = readSource("../src/services/admin/overview.service.ts");
    expect(overview).toContain('eventType: "page_view"');

    const routes = readSource("../src/routes/analytics.routes.ts");
    expect(routes).toContain('{ key: "page_view", label: "Page Views"');
  });
});

describe("page-view privacy survives the change", () => {
  it("still drops page views on sensitive token routes", () => {
    for (const path of [
      "/verify/eyJhbGciOi.token.sig",
      "/v/abc123",
      "/share/some-share-id",
      "/intake/token",
      "/portal/token",
      "/auth/callback",
    ]) {
      expect(
        shouldRejectAnalyticsEvent("page_view", path),
        `${path} must never be persisted as a page view`,
      ).toBe(true);
    }
  });

  it("keeps ordinary public marketing routes", () => {
    for (const path of ["/", "/pricing", "/platform", "/trust"]) {
      expect(shouldRejectAnalyticsEvent("page_view", path)).toBe(false);
      expect(classifyRouteType(path)).toBe("public");
    }
  });
});
