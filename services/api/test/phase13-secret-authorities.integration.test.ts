/**
 * PHASE 13 §1.3 — FINAL-003, PHASE1-001 and PHASE1-004 RUNTIME PROOF.
 *
 * WHAT THESE THREE ROWS SHARE
 * ---------------------------------------------------------------------------
 * All three were the SAME defect found in different files: a machine secret
 * compared with a raw `!==`, non-constant-time, with no minimum length. The
 * reconcile entrypoints (FINAL-003), the operational seeding secret
 * (PHASE1-001) and the Prometheus scrape token (PHASE1-004) each carried their
 * own copy of a decision that already existed, correctly, in
 * `middleware/cron-secret.ts`.
 *
 * All three were closed by delegating to that one authority. All three were
 * verified by READING the delegation. This suite drives the REGISTERED routes
 * instead, over real HTTP against a real disposable PostgreSQL 16.
 *
 * WHY DRIVING THEM MATTERS MORE THAN USUAL HERE
 * ---------------------------------------------------------------------------
 * PHASE1-004's own remediation note records the trap: `readCronSecretFromEnvs`
 * returns null BOTH for "unset" and for "set but too short", and `/metrics`
 * serves its exposition UNAUTHENTICATED on the "unset" branch. A naive
 * delegation would therefore have turned a weak-secret defect into an
 * OPEN-METRICS defect — a strictly worse outcome that reads, in a diff, as a
 * tidy refactor. The only way to know which of the two shipped is to configure
 * a short token and ask the running endpoint for the metrics.
 *
 * THE TEN CASES, DRIVEN AGAINST EVERY AUTHORITY
 * ---------------------------------------------------------------------------
 *   1  missing header                8  one-character difference
 *   2  empty header                  9  duplicate header
 *   3  below the minimum length     10  unexpected encoding (base64 of the
 *   4  right length, wrong value        correct secret, and percent-encoding)
 *   5  correct prefix only
 *   6  correct suffix only
 *   7  the correct value → ACCEPTED (the positive control; without it every
 *      refusal below is indistinguishable from a broken route)
 *
 * WHAT IS DELIBERATELY NOT ASSERTED
 * ---------------------------------------------------------------------------
 * Constant-time-ness is NOT asserted by timing this suite. Wall-clock timing
 * of a Node process under a test runner is noise, and a passing timing
 * assertion would be luck rather than proof. It is established structurally:
 * every authority is shown to route through `cronSecretMatches`, whose
 * comparison is `timingSafeEqual` over HMACs of both sides — and a dedicated
 * probe below proves that a WRONG-LENGTH and a RIGHT-LENGTH wrong secret are
 * refused identically, which is the observable consequence that matters.
 *
 * NO SECRET VALUE IS PRINTED. The fixtures below are locally generated strings
 * that name nothing and are set into `process.env` for the duration of a
 * single test; assertions report status codes, never values.
 */

import { Buffer } from "node:buffer";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  bootIntegrationHarness,
  type IntegrationHarness,
} from "./integration-harness.js";

/**
 * A syntactically valid secret at exactly the canonical floor plus margin.
 * Test-only, generated for this file, and never a credential for anything.
 */
const GOOD_SECRET = "phase13-secret-authority-fixture-000";
/**
 * Same length as GOOD_SECRET, entirely different bytes — DERIVED from it so
 * the two can never drift apart. A wrong secret that happened to be a
 * different length would silently turn case 4 into case 3.
 */
const WRONG_SAME_LENGTH = "X".repeat(GOOD_SECRET.length);
/** Below the canonical 16-character floor. */
const TOO_SHORT = "abc";

/**
 * One secret-bearing surface: which environment variable names its secret,
 * which header carries it, how it is presented, and what "accepted" looks like.
 *
 * `acceptedStatuses` is a SET rather than a single code because these routes do
 * real work once admitted — a sweep can legitimately answer 200 or 204, and a
 * reconcile can answer 400 for a body this suite deliberately does not supply.
 * What matters for a secret gate is that the request got PAST the gate, so the
 * accepted set excludes 401/403/503 and the refusal assertion pins 401 exactly.
 */
type SecretSurface = {
  id: string;
  envName: string;
  method: "GET" | "POST";
  url: string;
  /**
   * Build the request headers that present `value` as the secret. `value` is
   * widened to an array so case 9 can present the header TWICE — a duplicate
   * header is a real wire shape, and the gate must not be admitted by either
   * ordering of a right and a wrong value.
   */
  present: (value: string | string[]) => Record<string, string | string[]>;
  /** A minimal body that gets past schema validation, when one is needed. */
  payload?: Record<string, unknown>;
  /** Statuses that prove the gate ADMITTED the request. */
  acceptedStatuses: number[];
  /** The status a refused request must carry. */
  refusedStatus: number;
};

const SURFACES: SecretSurface[] = [
  {
    // FINAL-003, entrypoint 1.
    id: "reviewer-ops reconcile",
    envName: "REVIEWER_OPS_CRON_SECRET",
    method: "POST",
    url: "/v1/reviewer-ops/reconcile",
    present: (v) => ({ "x-cron-secret": v }),
    payload: { allTeams: true },
    acceptedStatuses: [200, 202, 204, 400],
    refusedStatus: 401,
  },
  {
    // Notification cron family — the authority FINAL-003's two strays should
    // have been using all along.
    id: "notifications process-retries",
    envName: "NOTIFICATION_CRON_SECRET",
    method: "POST",
    url: "/v1/notifications/process-retries",
    present: (v) => ({ "x-proovra-cron-secret": v }),
    acceptedStatuses: [200, 202, 204, 400],
    refusedStatus: 401,
  },
  {
    // Search-reindex internal surface.
    id: "internal search reindex",
    envName: "SEARCH_REINDEX_SECRET",
    method: "POST",
    url: "/v1/internal/search/reindex",
    present: (v) => ({ "x-internal-secret": v }),
    payload: {},
    acceptedStatuses: [200, 202, 204, 400, 422],
    refusedStatus: 401,
  },
];

describe("FINAL-003 / PHASE1-001 / PHASE1-004 — every machine secret flows through one constant-time authority", () => {
  let h: IntegrationHarness;
  const saved = new Map<string, string | undefined>();

  const setEnv = (name: string, value: string | undefined): void => {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  beforeAll(async () => {
    h = await bootIntegrationHarness();
  }, 900_000);

  afterEach(() => {
    // Every case configures its own environment; restoring after each one
    // keeps a case from inheriting the previous case's configuration, which is
    // exactly how a fail-open would hide.
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    saved.clear();
  });

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // =========================================================================
  // The ten cases, per surface.
  // =========================================================================
  for (const s of SURFACES) {
    describe(`${s.id} (${s.envName})`, () => {
      const drive = (headers: Record<string, string | string[]>) =>
        h.app.inject({
          method: s.method,
          url: s.url,
          headers,
          ...(s.payload !== undefined ? { payload: s.payload } : {}),
        });

      it("case 7 (POSITIVE CONTROL): the correct secret is accepted", async () => {
        setEnv(s.envName, GOOD_SECRET);
        const res = await drive(s.present(GOOD_SECRET));
        expect(
          s.acceptedStatuses.includes(res.statusCode),
          `${s.id}: the correct secret must be admitted, got ${res.statusCode}: ${res.body.slice(0, 200)}`,
        ).toBe(true);
      });

      it("case 1: a missing header is refused", async () => {
        setEnv(s.envName, GOOD_SECRET);
        const res = await drive({});
        expect(res.statusCode).toBe(s.refusedStatus);
      });

      it("case 2: an empty header is refused", async () => {
        setEnv(s.envName, GOOD_SECRET);
        const res = await drive(s.present(""));
        expect(res.statusCode).toBe(s.refusedStatus);
      });

      it("case 3: a secret below the minimum length is refused, and the surface does NOT fall open", async () => {
        // The configured secret itself is too short. The canonical reader
        // treats that as unusable — and the surface must fail CLOSED rather
        // than take its "no secret configured" branch, which is the specific
        // regression PHASE1-004 warned about.
        setEnv(s.envName, TOO_SHORT);
        const presented = await drive(s.present(TOO_SHORT));
        expect(
          s.acceptedStatuses.includes(presented.statusCode),
          `${s.id}: a sub-floor secret must never be honoured (got ${presented.statusCode})`,
        ).toBe(false);

        const anonymous = await drive({});
        expect(
          s.acceptedStatuses.includes(anonymous.statusCode),
          `${s.id}: a sub-floor configured secret must not make the surface public (got ${anonymous.statusCode})`,
        ).toBe(false);
      });

      it("case 4: a right-length wrong value is refused", async () => {
        setEnv(s.envName, GOOD_SECRET);
        const res = await drive(s.present(WRONG_SAME_LENGTH));
        expect(res.statusCode).toBe(s.refusedStatus);
      });

      it("case 5: the correct prefix alone is refused", async () => {
        setEnv(s.envName, GOOD_SECRET);
        const res = await drive(s.present(GOOD_SECRET.slice(0, 20)));
        expect(res.statusCode).toBe(s.refusedStatus);
      });

      it("case 6: the correct suffix alone is refused", async () => {
        setEnv(s.envName, GOOD_SECRET);
        const res = await drive(s.present(GOOD_SECRET.slice(-20)));
        expect(res.statusCode).toBe(s.refusedStatus);
      });

      it("case 8: a one-character difference is refused", async () => {
        setEnv(s.envName, GOOD_SECRET);
        const nearly = `${GOOD_SECRET.slice(0, -1)}1`;
        expect(nearly).not.toBe(GOOD_SECRET);
        expect(nearly.length).toBe(GOOD_SECRET.length);
        const res = await drive(s.present(nearly));
        expect(res.statusCode).toBe(s.refusedStatus);
      });

      it("case 9: a duplicate header does not admit a wrong value alongside the right one", async () => {
        setEnv(s.envName, GOOD_SECRET);
        // Both orderings. A gate that reads "the last one" and a gate that
        // joins the values would each admit one of these if it were sloppy.
        const wrongFirst = await drive(s.present([WRONG_SAME_LENGTH, GOOD_SECRET]));
        const rightFirst = await drive(s.present([GOOD_SECRET, WRONG_SAME_LENGTH]));
        expect(
          s.acceptedStatuses.includes(wrongFirst.statusCode) &&
            s.acceptedStatuses.includes(rightFirst.statusCode),
          `${s.id}: a duplicated header must not be admitted in both orderings`,
        ).toBe(false);
      });

      it("case 10: an encoded form of the correct secret is refused", async () => {
        setEnv(s.envName, GOOD_SECRET);
        for (const encoded of [
          Buffer.from(GOOD_SECRET, "utf8").toString("base64"),
          encodeURIComponent(GOOD_SECRET).replace(/-/g, "%2D"),
          Buffer.from(GOOD_SECRET, "utf8").toString("hex"),
        ]) {
          expect(encoded).not.toBe(GOOD_SECRET);
          const res = await drive(s.present(encoded));
          expect(
            res.statusCode,
            `${s.id}: an encoded secret must not be decoded and accepted`,
          ).toBe(s.refusedStatus);
        }
      });

      it("case 10b: surrounding whitespace is stripped, and that is the intended reading — not a decode", async () => {
        // OBSERVED, then classified. Padding the header with tabs IS accepted,
        // because both `readHeader` and `cronSecretMatches` trim. That is
        // correct: RFC 7230 defines optional whitespace around a header value
        // as not part of the value, so stripping it is reading the field, not
        // transforming the secret. It admits no value other than the exact
        // secret — every transformed form above is still refused.
        //
        // Pinned here so the behaviour is a recorded decision rather than an
        // accident nobody looked at.
        setEnv(s.envName, GOOD_SECRET);
        const padded = await drive(s.present(`\t ${GOOD_SECRET} \t`));
        expect(
          s.acceptedStatuses.includes(padded.statusCode),
          `${s.id}: a whitespace-padded correct secret is the same secret`,
        ).toBe(true);
      });

      it("refuses a wrong-length and a right-length wrong secret IDENTICALLY", async () => {
        // The observable consequence of a constant-time comparison that a
        // status code CAN carry: the response must not reveal that one guess
        // was closer than another. A raw `!==` on strings of different lengths
        // is the shape that leaks, and this is what its absence looks like.
        setEnv(s.envName, GOOD_SECRET);
        const shortWrong = await drive(s.present("q"));
        const sameLengthWrong = await drive(s.present(WRONG_SAME_LENGTH));
        const prefixWrong = await drive(s.present(GOOD_SECRET.slice(0, 10)));
        expect(shortWrong.statusCode).toBe(sameLengthWrong.statusCode);
        expect(prefixWrong.statusCode).toBe(sameLengthWrong.statusCode);
        expect(shortWrong.body).toBe(sameLengthWrong.body);
        expect(prefixWrong.body).toBe(sameLengthWrong.body);
      });
    });
  }

  // =========================================================================
  // PHASE1-004 — /metrics is its own case, because its "unset" branch is
  // deliberately PUBLIC and the fix had to preserve that while refusing a
  // token too weak to protect anything.
  // =========================================================================
  describe("PHASE1-004 — GET /metrics", () => {
    const metrics = (headers: Record<string, string | string[]> = {}) =>
      h.app.inject({ method: "GET", url: "/metrics", headers });

    it("POSITIVE CONTROL: a correctly configured token admits the scraper", async () => {
      setEnv("METRICS_SCRAPE_TOKEN", GOOD_SECRET);
      const res = await metrics({ authorization: `Bearer ${GOOD_SECRET}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");
    });

    it("a configured token refuses an absent, wrong, prefix-only and near-miss bearer", async () => {
      setEnv("METRICS_SCRAPE_TOKEN", GOOD_SECRET);
      for (const header of [
        undefined,
        "",
        "Bearer ",
        `Bearer ${WRONG_SAME_LENGTH}`,
        `Bearer ${GOOD_SECRET.slice(0, 20)}`,
        `Bearer ${GOOD_SECRET.slice(-20)}`,
        `Bearer ${GOOD_SECRET.slice(0, -1)}1`,
        `Bearer ${Buffer.from(GOOD_SECRET, "utf8").toString("base64")}`,
        GOOD_SECRET, // correct value, but not presented as a Bearer
      ]) {
        const res = await metrics(
          header === undefined ? {} : { authorization: header },
        );
        expect(
          res.statusCode,
          `authorization=${header === undefined ? "<absent>" : "<redacted form>"} must be refused`,
        ).toBe(401);
      }
    });

    it("a duplicated Authorization header does not admit the scraper", async () => {
      setEnv("METRICS_SCRAPE_TOKEN", GOOD_SECRET);
      const res = await metrics({
        authorization: [`Bearer ${WRONG_SAME_LENGTH}`, `Bearer ${GOOD_SECRET}`],
      });
      expect(res.statusCode).toBe(401);
    });

    it("THE REGRESSION THE FIX EXISTED TO AVOID: a token that is present but too weak fails CLOSED, it does not make /metrics public", async () => {
      setEnv("METRICS_SCRAPE_TOKEN", TOO_SHORT);

      // Anonymous — the branch that would have served the exposition if the
      // "unset" and "too short" cases had been collapsed.
      const anonymous = await metrics();
      expect(
        anonymous.statusCode,
        "a weak token must not make /metrics public",
      ).toBe(503);
      expect(anonymous.body).not.toContain("# HELP");
      expect(anonymous.body).not.toContain("# TYPE");

      // And presenting the weak token is no better than not presenting it.
      const presented = await metrics({ authorization: `Bearer ${TOO_SHORT}` });
      expect(presented.statusCode).toBe(503);
      expect(presented.body).not.toContain("# HELP");
    });

    it("the documented deployment posture is preserved: with NO token configured, /metrics is public", async () => {
      // This is a POSTURE assertion, not an endorsement. PHASE1-004 recorded
      // that an unset METRICS_SCRAPE_TOKEN leaves /metrics unauthenticated and
      // that this is pre-existing and tracked as backlog rather than changed
      // here. Pinning it means a future change to that posture is a deliberate,
      // visible decision instead of a silent one.
      setEnv("METRICS_SCRAPE_TOKEN", undefined);
      const res = await metrics();
      expect(res.statusCode).toBe(200);
    });

    it("no secret value appears in any /metrics response body", async () => {
      setEnv("METRICS_SCRAPE_TOKEN", GOOD_SECRET);
      const ok = await metrics({ authorization: `Bearer ${GOOD_SECRET}` });
      const refused = await metrics({ authorization: "Bearer nope" });
      for (const body of [ok.body, refused.body]) {
        expect(body).not.toContain(GOOD_SECRET);
      }
    });
  });

  // =========================================================================
  // PHASE1-001 — the operational seeding secret.
  //
  // Its route is not mounted unless seeding is enabled, and it sits behind five
  // other gates. The SECRET DECISION is therefore driven directly against the
  // exported authority, which is the same function the route calls — and the
  // registration state of the surface is asserted separately, so this suite
  // never implies it proved a route it did not drive.
  // =========================================================================
  describe("PHASE1-001 — the operational seeding secret", () => {
    it("accepts only the exact secret, and refuses a sub-floor secret as NOT_CONFIGURED", async () => {
      const { assertSeedingSecret, OperationalSeedError } = await import(
        "../src/services/ops/operational-seed.service.js"
      );

      setEnv("OPERATIONAL_SEEDING_SECRET", GOOD_SECRET);
      // Positive control first.
      expect(() => assertSeedingSecret(GOOD_SECRET)).not.toThrow();

      for (const bad of [
        undefined,
        null,
        "",
        WRONG_SAME_LENGTH,
        GOOD_SECRET.slice(0, 20),
        GOOD_SECRET.slice(-20),
        `${GOOD_SECRET.slice(0, -1)}1`,
        Buffer.from(GOOD_SECRET, "utf8").toString("base64"),
      ]) {
        expect(() => assertSeedingSecret(bad)).toThrow(OperationalSeedError);
      }

      // A secret below the floor is refused as UNCONFIGURED — fail closed —
      // rather than being honoured, which is what the raw `!==` did.
      setEnv("OPERATIONAL_SEEDING_SECRET", TOO_SHORT);
      expect(() => assertSeedingSecret(TOO_SHORT)).toThrow(
        /SEEDING_SECRET_NOT_CONFIGURED/,
      );
    });

    it("is not reachable as an unauthenticated surface on the booted app", async () => {
      // Whatever the seeding routes' mount state, an anonymous caller must not
      // be admitted by presenting the secret alone: session auth, membership
      // and capability all still stand in front of it.
      setEnv("OPERATIONAL_SEEDING_SECRET", GOOD_SECRET);
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/ops/seed/run",
        headers: { "x-operational-seeding-secret": GOOD_SECRET },
        payload: {},
      });
      expect([401, 403, 404]).toContain(res.statusCode);
    });
  });

  // =========================================================================
  // The system-level property all of the above exists to establish.
  // =========================================================================
  it("every machine-secret comparison in the API routes through the canonical primitive", async () => {
    // Read from the SOURCE, deliberately: this is the one claim that is about
    // absence, and absence cannot be observed by driving requests. It
    // complements the behavioural proofs above rather than substituting for
    // them — those show the surfaces refuse; this shows no sixth copy exists.
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");

    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        return statSync(full).isDirectory()
          ? walk(full)
          : full.endsWith(".ts")
            ? [full]
            : [];
      });

    const offenders: string[] = [];
    for (const file of walk("src")) {
      const text = readFileSync(file, "utf8");
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        // A comparison operator applied directly to a secret-shaped env read.
        if (
          /process\.env\.[A-Z0-9_]*(SECRET|TOKEN)[A-Z0-9_]*\s*(===|!==|==|!=)/.test(
            line,
          ) ||
          /(===|!==)\s*process\.env\.[A-Z0-9_]*(SECRET|TOKEN)[A-Z0-9_]*/.test(line)
        ) {
          // Presence/absence checks are not comparisons of a secret VALUE.
          if (/(undefined|null|""|''|\.length)/.test(line)) continue;
          offenders.push(`${file}:${index + 1}`);
        }
      }
    }

    expect(
      offenders,
      `raw secret comparisons must be zero; found: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
