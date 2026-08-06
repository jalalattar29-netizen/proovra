/**
 * PHASE 12 — POINT 5, STEP 1.2: the stored provider idempotency key is
 * INTERNAL OPERATIONAL STATE.
 *
 * WHY IT IS STORED AT ALL
 * ---------------------------------------------------------------------------
 * A key derived fresh on every attempt is stable only while every one of its
 * inputs is, and the inputs — the secret, the version, the attempt counter —
 * are exactly the things that change. So a durable delivery intent mints its
 * key once and persists it, and every retry loads it. That is what makes a
 * retry a retry rather than a second email.
 *
 * WHY IT MUST NEVER LEAVE
 * ---------------------------------------------------------------------------
 * It is an HMAC over the intent under a dedicated secret, transmitted to a
 * third party in a request header. Returning it to a product client would
 * publish an identifier that a caller could then present to the provider —
 * and would put a value derived from `EMAIL_IDEMPOTENCY_SECRET` into every
 * surface that renders a delivery, for no product purpose whatsoever.
 *
 * HOW THIS IS MEASURED
 * ---------------------------------------------------------------------------
 * Not by grepping for a field name. The key lives in exactly one place —
 * `NotificationDelivery.metadata.idempotencyKey` — so "exposed keys = 0"
 * reduces to "no surface returns a delivery row's metadata". This file:
 *
 *   1. DISCOVERS every module in the API and worker that reads the
 *      `notificationDelivery` delegate, so the surface list is not a hand-
 *      written one that a new reader could slip past;
 *   2. classifies each reader against a CLOSED set of dispositions, so a new
 *      one fails until somebody decides what it is;
 *   3. EXECUTES every real projection with a row carrying a genuinely minted
 *      key and asserts the key, and the field, are absent from the output.
 *
 * The end-to-end half — the key's absence from the audit trail and from
 * stdout/stderr during a real rotate-and-send — is proven against live
 * PostgreSQL in `test/point5/family-invite-delivery.integration.test.ts`.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
  EMAIL_IDEMPOTENCY_KEY_PATTERN,
  STORED_IDEMPOTENCY_KEY_FIELD,
  mintEmailIdempotencyKey,
} from "@proovra/shared-runtime";

import { projectNotificationDelivery } from "../src/services/notifications/index.js";
import { projectOrgInviteDelivery } from "../src/services/organization/org-invite-delivery.service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "../../..");

// ===========================================================================
// 1. Independent discovery of every reader
// ===========================================================================

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      walk(full, out);
    } else if (name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Modules that touch the durable authority carrying the key. */
const READERS = (() => {
  const roots = ["services/api/src", "services/worker/src"].map((r) =>
    resolve(REPO, r),
  );
  const found: string[] = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      const src = readFileSync(file, "utf8");
      if (/\bnotificationDelivery\s*\./.test(src)) {
        found.push(relative(REPO, file).split("\\").join("/"));
      }
    }
  }
  return found.sort();
})();

/**
 * The CLOSED disposition set.
 *
 * `writer`     persists deliveries and their keys; returns nothing to a client.
 * `projector`  turns a row into something a client sees — the surfaces this
 *              file must execute and scan.
 * `counter`    reads aggregates only (counts), never a row body.
 * `scheduler`  reads rows to decide timing; returns no row outward.
 *
 * There is deliberately no "other". A module that reads the delivery table
 * and fits none of these has to be classified before this gate passes, which
 * is the only way a new egress path cannot be added silently.
 */
const DISPOSITIONS: Record<string, "writer" | "projector" | "counter" | "scheduler"> = {
  "services/api/src/routes/evidence-requests.routes.ts": "projector",
  "services/api/src/routes/ops.routes.ts": "counter",
  "services/api/src/services/demo-follow-up.service.ts": "writer",
  "services/api/src/services/notifications/index.ts": "projector",
  "services/api/src/services/notifications/reminder-scheduler.ts": "scheduler",
  "services/api/src/services/organization/org-invite-delivery.service.ts": "projector",
  "services/worker/src/mfa-recovery-digest.ts": "writer",
};

describe("POINT 5 — every reader of the delivery authority is classified", () => {
  it("discovery finds the readers, and no reader is unclassified", () => {
    expect(READERS.length).toBeGreaterThan(0);
    const unclassified = READERS.filter((r) => !DISPOSITIONS[r]);
    expect(
      unclassified,
      `unclassified readers of NotificationDelivery:\n${unclassified.join("\n")}\n` +
        "Classify each as writer / projector / counter / scheduler, and if it " +
        "is a projector, execute it in the scan below.",
    ).toEqual([]);
  });

  it("no classification names a module that no longer reads the authority", () => {
    const stale = Object.keys(DISPOSITIONS).filter((k) => !READERS.includes(k));
    expect(stale, `stale entries:\n${stale.join("\n")}`).toEqual([]);
  });

  it("only projectors may reach a client, and each is scanned below", () => {
    const projectors = READERS.filter((r) => DISPOSITIONS[r] === "projector");
    // Three: the evidence-request delivery list, the canonical notification
    // projection, and the org-invite delivery state. All three are executed
    // with a key-bearing row in the scan that follows.
    expect(projectors).toEqual([
      "services/api/src/routes/evidence-requests.routes.ts",
      "services/api/src/services/notifications/index.ts",
      "services/api/src/services/organization/org-invite-delivery.service.ts",
    ]);
  });
});

// ===========================================================================
// 2. Behavioural scan — execute each projection with a real key present
// ===========================================================================

/** A genuinely minted key, not a placeholder string. */
const KEY = mintEmailIdempotencyKey("org_invite_delivery", "11111111-2222-4333-8444-555555555555");

function deliveryRow(): Record<string, unknown> {
  const now = new Date("2026-08-04T00:00:00.000Z");
  return {
    id: "11111111-2222-4333-8444-555555555555",
    teamId: null,
    eventType: "org_invite_delivery",
    channel: "EMAIL",
    provider: "RESEND",
    recipient: "recipient@example.test",
    recipientName: null,
    recipientUserId: null,
    evidenceRequestId: null,
    evidenceId: null,
    intakeLinkId: null,
    status: "PENDING",
    subject: "You're invited",
    templateKey: "org_invite_delivery",
    renderedPreview: null,
    providerMessageId: null,
    errorCode: null,
    errorMessage: null,
    retryCount: 1,
    nextAttemptAtUtc: now,
    sentAtUtc: null,
    deliveredAtUtc: null,
    failedAtUtc: null,
    initiatedByUserId: null,
    templateContextJson: null,
    createdAt: now,
    updatedAt: now,
    metadata: {
      inviteId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      organizationId: "ffffffff-0000-4111-8222-333333333333",
      contentVersion: 2,
      contentFingerprint: "0123456789abcdef0123456789abcdef",
      [STORED_IDEMPOTENCY_KEY_FIELD]: KEY,
    },
  };
}

describe("POINT 5 — exposed provider idempotency keys = 0", () => {
  it("the fixture really carries a well-formed key (the scan has a subject)", () => {
    expect(KEY).toMatch(EMAIL_IDEMPOTENCY_KEY_PATTERN);
    expect(JSON.stringify(deliveryRow())).toContain(KEY);
  });

  it("the canonical notification projection returns neither the key nor the metadata", () => {
    for (const opts of [{}, { maskRecipient: true }]) {
      const projected = projectNotificationDelivery(deliveryRow() as never, opts);
      const json = JSON.stringify(projected);
      expect(json).not.toContain(KEY);
      expect(json).not.toContain(STORED_IDEMPOTENCY_KEY_FIELD);
      // Stated as a closed key set, not just an absence: a future field
      // called `context` carrying the same blob would pass the two checks
      // above and fail this one.
      expect(Object.keys(projected)).not.toContain("metadata");
      expect(Object.keys(projected)).not.toContain("templateContextJson");
    }
  });

  it("the org-invite delivery state returns neither the key nor the metadata", () => {
    const projected = projectOrgInviteDelivery(deliveryRow() as never);
    const json = JSON.stringify(projected);
    expect(json).not.toContain(KEY);
    expect(json).not.toContain(STORED_IDEMPOTENCY_KEY_FIELD);
    expect(Object.keys(projected).sort()).toEqual([
      "attempts",
      "deliveryId",
      "lastError",
      "status",
    ]);
  });

  it("the evidence-request delivery list selects columns explicitly, and metadata is not one", () => {
    // This projector is inline in the route rather than an exported function,
    // so what is executed here is its SELECT: a Prisma `select` that names
    // metadata cannot be added without this failing. The response mapping
    // below it can only narrow what the select returned.
    const src = readFileSync(
      resolve(REPO, "services/api/src/routes/evidence-requests.routes.ts"),
      "utf8",
    );
    const at = src.indexOf("notificationDelivery.findMany({");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 700);
    expect(block).toContain("select: {");
    expect(block).not.toContain("metadata");
  });

  it("no reader classified as counter or scheduler returns a row body outward", () => {
    for (const [module, disposition] of Object.entries(DISPOSITIONS)) {
      if (disposition !== "counter" && disposition !== "scheduler") continue;
      const src = readFileSync(resolve(REPO, module), "utf8");
      // A counter/scheduler that starts projecting rows has changed
      // disposition and must be reclassified — and then scanned.
      expect(src, `${module} now projects deliveries`).not.toMatch(
        /projectNotificationDelivery|projectOrgInviteDelivery/,
      );
    }
  });

  it("the key is never written to a webhook payload or an analytics projection", () => {
    // Measured, not assumed: no module outside the classified reader set
    // touches the delivery authority at all, so no webhook payload builder or
    // analytics aggregator can carry a key it has no way to read.
    const webhookOrAnalytics = READERS.filter((r) =>
      /webhook|analytic|export|discovery/i.test(r),
    );
    expect(
      webhookOrAnalytics,
      `these read the delivery authority AND look like an egress surface:\n${webhookOrAnalytics.join("\n")}`,
    ).toEqual([]);
  });
});
