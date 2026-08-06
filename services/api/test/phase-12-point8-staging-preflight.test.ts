/**
 * PHASE 12 — POINT 8, STEPS 1 AND 2: the census and the Staging preflight.
 *
 * The mandate forbids running any Point-8 gate until the preflight is green,
 * and the preflight's whole value is that it refuses. Point 7 established what
 * it is refusing: `services/api/.env` on this machine holds LIVE Stripe,
 * PayPal, AWS, Redis, Sentry, Resend and Twilio credentials, and `db.ts` loads
 * it into any process started from that directory. Point 8 drives real
 * providers, so a selection mistake is a real charge, a real email or a
 * mutation of production storage — not a noisy test.
 *
 * Each check below is proved by handing the preflight a selection that is
 * production in exactly one way and asserting the corresponding boolean turns
 * true. The last two tests record the repository's HONEST state: no Staging
 * environment is configured, so the preflight cannot be green and no gate may
 * run.
 *
 * No value from any env file reaches an assertion message. The suite reads
 * files; it opens no socket.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { syntheticStripeLiveSecret, syntheticStripeTestSecret } from "./point8/synthetic-credentials.js";

import {
  classifyEnvFile,
  ENV_FILES,
  hostCategory,
  isControlledTestMailbox,
  preflight,
  REPO_ROOT,
  runCensus,
  type CensusResult,
} from "./point8/staging-census.mjs";

/**
 * The preflight only reads `metrics.unknownCredentialSelections` from a census.
 * Supplying that one field keeps each case about the selection under test
 * rather than about whatever the machine's env files happen to hold.
 */
const censusWith = (
  unknownCredentialSelections: number,
  // A Staging environment that EXISTS is the premise of these cases: each one
  // asks what the preflight does with a given SELECTION, which is only a
  // meaningful question once there is something to select. The empty-census
  // case — nothing verified at all — is asserted separately against the real
  // census, where it must refuse.
  sandboxOrStagingVerified = 1,
): CensusResult =>
  ({
    metrics: { unknownCredentialSelections, sandboxOrStagingVerified },
  }) as unknown as CensusResult;

/** A selection that is entirely Staging-named — the shape the owner must supply. */
const CLEAN_STAGING_SELECTION = {
  DATABASE_URL: "postgresql://u:p@db.staging.example-staging.net:5432/app",
  REDIS_URL: "rediss://u:p@cache.staging.example-staging.net:6379",
  S3_ENDPOINT: "https://objects.staging.example-staging.net",
  S3_ACCESS_KEY: "staging-scoped-access-authority",
  STRIPE_SECRET_KEY: syntheticStripeTestSecret(),
  PAYPAL_API_BASE: "https://api-m.sandbox.paypal.com",
  SAML_METADATA_URL: "https://idp.staging.example-staging.net/metadata",
  RESEND_API_KEY: "",
  EMAIL_TRANSPORT: "recording",
  STAGING_TEST_MAILBOX: "p8@test.example-staging.net",
  OPS_ALERT_WEBHOOK_URL: "https://hooks.staging.example-staging.net/p8",
};

describe("PHASE 12 — POINT 8 STEP 2: the preflight refuses each production selection", () => {
  it("is green for a wholly Staging-named selection with no unknowns", () => {
    const r = preflight(CLEAN_STAGING_SELECTION, censusWith(0));
    expect(r.checks).toMatchObject({
      ProductionDatabaseSelected: false,
      ProductionRedisSelected: false,
      ProductionStorageSelected: false,
      ProductionPaymentModeSelected: false,
      ProductionIdentityTenantSelected: false,
      ProductionEmailAudienceSelected: false,
      ProductionWebhookReceiverSelected: false,
      UnknownCredentialSelections: 0,
    });
    expect(r.green).toBe(true);
  });

  it.each([
    ["ProductionDatabaseSelected", { DATABASE_URL: "postgresql://u:p@db.prod-host.net:5432/app" }],
    ["ProductionRedisSelected", { REDIS_URL: "rediss://u:p@cache.prod-host.net:6379" }],
    ["ProductionStorageSelected", { S3_ENDPOINT: "https://s3.eu-central-1.amazonaws.com" }],
    ["ProductionStorageSelected", { S3_ACCESS_KEY: "AKIAEXAMPLEEXAMPLE00" }],
    ["ProductionPaymentModeSelected", { STRIPE_SECRET_KEY: syntheticStripeLiveSecret() }],
    ["ProductionPaymentModeSelected", { PAYPAL_API_BASE: "https://api-m.paypal.com" }],
    ["ProductionIdentityTenantSelected", { SAML_METADATA_URL: "https://idp.corp-host.net/metadata" }],
    ["ProductionWebhookReceiverSelected", { OPS_ALERT_WEBHOOK_URL: "https://hooks.corp-host.net/live" }],
  ])("turns %s true when the selection is production in exactly that way", (flag, override) => {
    const r = preflight({ ...CLEAN_STAGING_SELECTION, ...override }, censusWith(0));
    expect(r.checks[flag as keyof typeof r.checks]).toBe(true);
    expect(r.green).toBe(false);
  });

  it("turns ProductionEmailAudienceSelected true when a real transport has no controlled mailbox", () => {
    const r = preflight(
      {
        ...CLEAN_STAGING_SELECTION,
        RESEND_API_KEY: "re_000000000000000000000000",
        EMAIL_TRANSPORT: "resend",
        STAGING_TEST_MAILBOX: "someone@a-real-customer-domain.net",
      },
      censusWith(0),
    );
    expect(r.checks.ProductionEmailAudienceSelected).toBe(true);
    expect(r.green).toBe(false);
  });

  it("a controlled test mailbox is recognised by its domain, and a real one is not", () => {
    expect(isControlledTestMailbox("p8@test.example-staging.net")).toBe(true);
    expect(isControlledTestMailbox("p8@staging.example-staging.net")).toBe(true);
    expect(isControlledTestMailbox("p8@mailhog.local")).toBe(true); // disposable inbox service
    expect(isControlledTestMailbox("someone@a-real-customer-domain.net")).toBe(false);
    expect(isControlledTestMailbox("someone@gmail.com")).toBe(false);
    expect(isControlledTestMailbox("")).toBe(false);
  });

  it("is not green while any required credential is CONFIGURED_BUT_UNKNOWN", () => {
    const r = preflight(CLEAN_STAGING_SELECTION, censusWith(1));
    expect(r.checks.UnknownCredentialSelections).toBe(1);
    expect(r.green).toBe(false);
  });

  it("classifies hosts by category and never returns the host itself", () => {
    expect(hostCategory("postgresql://u:p@localhost:5432/app")).toBe("loopback");
    expect(hostCategory("redis://redis:6379")).toBe("docker-service");
    expect(hostCategory("https://api-m.sandbox.paypal.com")).toBe("provider-sandbox-endpoint");
    expect(hostCategory("https://api.staging.example-staging.net")).toBe("staging-named-host");
    expect(hostCategory("https://api.some-real-host.net")).toBe("external-host");
    expect(hostCategory("not-a-url")).toBe("no-host");
  });
});

describe("PHASE 12 — POINT 8 STEP 1: the census of THIS repository", () => {
  const census = runCensus();

  it("identifies every env file that carries live credentials, so none can be selected", () => {
    const bearing = census.metrics.productionBearingEnvFiles as string[];

    // Every candidate is accounted for as either bearing or not — no silent gaps.
    expect(census.files.map((f: { file: string }) => f.file).sort()).toEqual([...ENV_FILES].sort());

    // The invariant is an IMPLICATION, not a population count: if a local env
    // file exists and carries a live marker, it is named, and therefore cannot
    // be selected. Asserting that `.env` and `services/api/.env` are always
    // present asserted a property of one developer's machine — a clean CI
    // checkout and the release artifact carry no env files at all, and naming
    // files that are not there would be a fabricated finding, which is the
    // opposite of what a credential census is for.
    for (const f of census.files as { file: string; productionBearing: boolean }[]) {
      if (!f.productionBearing) continue;
      expect(existsSync(resolve(REPO_ROOT, f.file)), `${f.file} named bearing but absent`).toBe(true);
      expect(bearing).toContain(f.file);
    }

    // The files Point 7 traced production Sentry/S3/Redis/payment contact to
    // are named WHENEVER they are present.
    for (const f of [".env", "services/api/.env"]) {
      if (existsSync(resolve(REPO_ROOT, f))) expect(bearing).toContain(f);
    }
  });

  it("an environment with nothing verified is REFUSED, not silently green", () => {
    // The regression this pins: `green` was computed only from refusals, so an
    // empty census — no env files, i.e. every clean checkout — turned every
    // refusal trivially false and reported GREEN for a Staging environment that
    // does not exist.
    const emptyCensus = {
      metrics: { unknownCredentialSelections: 0, sandboxOrStagingVerified: 0 },
    } as unknown as CensusResult;

    const r = preflight(CLEAN_STAGING_SELECTION, emptyCensus);

    expect(r.checks.SandboxOrStagingVerified).toBe(0);
    expect(r.green).toBe(false);
  });

  it("the local audit env files carry no live marker — they remain the only safe local selection", () => {
    for (const f of [".env.audit-local", "services/api/.env.local", "services/api/.env.audit-local"]) {
      expect(classifyEnvFile(f).productionBearing).toBe(false);
    }
  });

  it("HONEST STATE — no required credential is SANDBOX_OR_STAGING_VERIFIED, so no gate may run", () => {
    expect(census.metrics.sandboxOrStagingVerified).toBe(0);

    // Something WAS censused — "nothing is verified" must not be satisfiable by
    // looking at nothing.
    expect(census.metrics.censusItems).toBeGreaterThan(0);

    // …and no row is verified. HOW a row is unverified depends on the checkout
    // and must not be pinned: a developer machine carries local env files the
    // census can only call CONFIGURED_BUT_UNKNOWN, while a clean CI checkout has
    // no env files at all and every row is MISSING. Both are honest "not
    // verified". Asserting the UNKNOWN shape made this suite pass only where a
    // local `.env` happened to exist and fail in the clean checkout the gate
    // exists to protect — the absence of credentials must be a deterministic
    // classification, never a crash and never a false green.
    for (const item of census.items) {
      expect(item.classification).not.toBe("SANDBOX_OR_STAGING_VERIFIED");
    }

    // The preflight computed against the repository as it stands cannot be
    // green, which is precisely why Point 8 is reported blocked rather than
    // executed. If this ever starts failing, a Staging environment has arrived
    // and the gates become runnable.
    const r = preflight(CLEAN_STAGING_SELECTION, census);
    expect(r.green).toBe(false);
  });

  it("emits no credential value anywhere in the census artifact", () => {
    const serialised = JSON.stringify(census);
    // Provider secret shapes, and the one live-mode marker that must never be
    // echoed even in classification output.
    for (const shape of [/sk_live_[A-Za-z0-9]/, /sk_test_[A-Za-z0-9]/, /re_[A-Za-z0-9]{8}/, /AKIA[A-Z0-9]{8}/, /whsec_[A-Za-z0-9]/]) {
      expect(serialised).not.toMatch(shape);
    }
    // No absolute URLs and no bare credentials-in-URL forms.
    expect(serialised).not.toMatch(/https?:\/\//);
    expect(serialised).not.toMatch(/postgres(ql)?:\/\//);
    expect(serialised).not.toMatch(/rediss?:\/\//);
  });
});
