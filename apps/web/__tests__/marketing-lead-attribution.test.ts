import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { requestDemoSchema } from "../lib/request-demo-schema";
import { contactSalesSchema } from "../lib/contact-sales-schema";

const here = dirname(fileURLToPath(import.meta.url));
const ROUTE = readFileSync(join(here, "../app/api/_marketing-leads.ts"), "utf8");

const attribution = {
  source: "website_referral",
  sourcePath: "/pricing",
  referrer: "https://example.test",
  utmSource: "newsletter",
  utmMedium: "email",
  utmCampaign: "launch",
  utmTerm: "evidence",
  utmContent: "cta",
};

describe("PROV-017 — what the form collects reaches the sales record", () => {
  it("the demo schema keeps the qualification and the attribution", () => {
    const parsed = requestDemoSchema.parse({
      fullName: "Sam Lead",
      workEmail: "sam@example.test",
      primaryInterest: "governance",
      organizationType: "legal",
      useCase: "We need a defensible chain of custody.",
      ...attribution,
    });
    assert.equal(parsed.primaryInterest, "governance");
    assert.equal(parsed.organizationType, "legal");
    assert.equal(parsed.utmCampaign, "launch");
    assert.equal(parsed.sourcePath, "/pricing");
  });

  it("the contact-sales schema keeps the attribution", () => {
    const parsed = contactSalesSchema.parse({
      fullName: "Sam Lead",
      workEmail: "sam@example.test",
      organization: "Acme",
      discussionTopic: "legal-hold",
      stage: "exploring",
      currentChallenge: "Our retention is not defensible yet.",
      ...attribution,
    });
    assert.equal(parsed.utmSource, "newsletter");
    assert.equal(parsed.source, "website_referral");
  });

  it("the visitor is not handed the upstream verdict, and a lead with nowhere to go is not 'received' in production", () => {
    assert.doesNotMatch(ROUTE, /\.\.\.parsedUpstream/);
    assert.match(ROUTE, /NODE_ENV === "production"/);
  });

  it("PROV-022 — the origin check reads what the browser stated, not the Host header", () => {
    const body = ROUTE.slice(ROUTE.indexOf("function isSameOrSafeOrigin"), ROUTE.indexOf("function rateLimitKey"));
    assert.doesNotMatch(body, /headers\.get\("host"\)/);
    assert.match(body, /headers\.get\("origin"\)/);
  });
});
