/**
 * PHASE 12 — POINT 7: bounded READ-ONLY collector for the production queue
 * incident (Sentry `630a6b0c05a946018acb6279a6b26841`,
 * `0bf44308342249e1bedcb863b09c07f1`).
 *
 * WHAT THIS WILL NOT DO
 * ---------------------------------------------------------------------------
 * It will not read `REDIS_URL`. It will not read anything from `.env`. It
 * refuses to start without an EXPLICIT incident credential supplied for this
 * purpose and nothing else:
 *
 *     P7_PRODUCTION_QUEUE_READONLY_URL
 *
 * That refusal is the whole design. The incident being investigated is a test
 * process reaching production because a credential was lying around where code
 * could find it, and an investigation tool that reuses the same credential
 * would be repeating the mistake with better intentions.
 *
 * It issues only read commands. It never writes, never removes a job, never
 * drains, never touches a queue's structure, and it contains no code path that
 * could. `FLUSHALL`, `FLUSHDB` and queue deletion are not implemented here and
 * must never be — see the runbook for the exact-job quarantine procedure, which
 * is an OWNER action against named job ids.
 *
 * WHAT IT COLLECTS
 * ---------------------------------------------------------------------------
 * Only the metadata the incident question needs, for jobs inside the two event
 * windows, and only for the two affected queues. Identifier VALUES are hashed
 * before they are written; payload contents, tokens, emails and tenant
 * identifiers never leave the process in readable form.
 *
 * USAGE (owner-operated)
 * ---------------------------------------------------------------------------
 *     P7_PRODUCTION_QUEUE_READONLY_URL="rediss://<readonly-user>:<pw>@<host>:<port>" \
 *       node services/api/scripts/p7-queue-incident-collector.mjs \
 *         --out p7-queue-incident.json
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const CREDENTIAL_ENV = "P7_PRODUCTION_QUEUE_READONLY_URL";

/** The two Sentry event windows, widened by ten minutes on each side. */
const WINDOWS = [
  {
    issue: "630a6b0c05a946018acb6279a6b26841",
    fromUtc: "2026-08-05T01:37:00.000Z",
    toUtc: "2026-08-05T01:57:00.000Z",
    taggedJobKind: "graph-reconcile",
  },
  {
    issue: "0bf44308342249e1bedcb863b09c07f1",
    fromUtc: "2026-08-05T02:08:00.000Z",
    toUtc: "2026-08-05T02:28:00.000Z",
    taggedJobKind: "evidence-purge",
  },
];

/** Only these queues. A collector that scans everything is not bounded. */
const QUEUES = ["evidence-purge", "graph-reconcile", "reconciliation", "evidence"];

function hashId(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function fail(message) {
  // eslint-disable-next-line no-console
  console.error(`p7-queue-incident-collector: ${message}`);
  process.exit(2);
}

const url = (process.env[CREDENTIAL_ENV] ?? "").trim();
if (!url) {
  fail(
    `${CREDENTIAL_ENV} is not set.\n\n` +
      "This collector deliberately refuses to fall back to REDIS_URL, to any\n" +
      "value in .env, or to any other credential. Supply a READ-ONLY queue\n" +
      "credential created for this incident, or run the owner export procedure\n" +
      "in docs/operations/point7-queue-incident-runbook.md instead.",
  );
}
if (/(^|[^a-z])redis:\/\//i.test(url) && !/readonly|read-only|ro@/i.test(url)) {
  // A soft warning, not a block: naming conventions vary. The hard guarantee is
  // that this script issues no write command.
  // eslint-disable-next-line no-console
  console.warn(
    "p7-queue-incident-collector: the supplied credential is not obviously a " +
      "read-only role. This tool issues only read commands, but please confirm " +
      "the role cannot write before running it against production.",
  );
}

const outIndex = process.argv.indexOf("--out");
const outPath = outIndex > -1 ? process.argv[outIndex + 1] : "p7-queue-incident.json";

const { default: IORedis } = await import("ioredis");

/**
 * A client with no retry and no offline queue: an investigation must fail
 * loudly rather than sit in a reconnect loop against production.
 */
const redis = new IORedis(url, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  lazyConnect: true,
  connectTimeout: 10_000,
});

const findings = [];

try {
  await redis.connect();

  for (const queue of QUEUES) {
    for (const state of ["failed", "completed", "wait", "active", "delayed"]) {
      // BullMQ v5 key layout. `ZRANGE`/`LRANGE` are reads; nothing here mutates.
      const key = `bull:${queue}:${state}`;
      let ids = [];
      try {
        const type = await redis.type(key);
        if (type === "zset") ids = await redis.zrange(key, 0, 500);
        else if (type === "list") ids = await redis.lrange(key, 0, 500);
        else continue;
      } catch {
        continue;
      }

      for (const id of ids) {
        const raw = await redis.hgetall(`bull:${queue}:${id}`);
        if (!raw || Object.keys(raw).length === 0) continue;

        const timestamp = Number(raw.timestamp ?? 0);
        const window = WINDOWS.find(
          (w) =>
            timestamp >= Date.parse(w.fromUtc) && timestamp <= Date.parse(w.toUtc),
        );
        if (!window) continue;

        let data = {};
        try {
          data = JSON.parse(raw.data ?? "{}");
        } catch {
          data = { __unparseable: true };
        }
        const body =
          data && typeof data.body === "object" && data.body !== null ? data.body : {};

        findings.push({
          issue: window.issue,
          queue,
          state,
          jobId: hashId(id),
          jobName: typeof raw.name === "string" ? raw.name : null,
          createdAtUtc: timestamp ? new Date(timestamp).toISOString() : null,
          attempts: Number(raw.attemptsMade ?? 0),
          failedReason:
            typeof raw.failedReason === "string" ? raw.failedReason.slice(0, 300) : null,
          // NAMES only — never values.
          payloadKeys: Object.keys(data ?? {}).sort(),
          bodyKeys: Object.keys(body ?? {}).sort(),
          schemaVersion:
            typeof data.schemaVersion === "number" ? data.schemaVersion : null,
          hasCommandId: typeof data.commandId === "string" && data.commandId.length > 0,
          hasEvidenceId:
            (typeof data.evidenceId === "string" && data.evidenceId.length > 0) ||
            (typeof body.evidenceId === "string" && body.evidenceId.length > 0),
          commandIdIsNullish:
            "commandId" in (data ?? {}) &&
            (data.commandId === null || data.commandId === undefined),
          evidenceIdIsNullish:
            ("evidenceId" in (data ?? {}) &&
              (data.evidenceId === null || data.evidenceId === undefined)) ||
            ("evidenceId" in body &&
              (body.evidenceId === null || body.evidenceId === undefined)),
          traceIdPresent: typeof data.traceId === "string" && data.traceId.length > 0,
          producerBuildId:
            typeof data.producerBuildId === "string" ? data.producerBuildId : null,
          // Hashed so two records can be compared without either being readable.
          referenceHash: hashId(data.commandId ?? data.evidenceId ?? body.evidenceId),
        });
      }
    }
  }
} finally {
  await redis.quit().catch(() => undefined);
}

const report = {
  $comment:
    "PHASE 12 POINT 7 — bounded read-only queue incident collection. Metadata " +
    "and hashed identifiers only; no payload values, tokens or tenant ids.",
  collectedAtUtc: new Date().toISOString(),
  windows: WINDOWS,
  queuesInspected: QUEUES,
  jobsMatched: findings.length,
  findings,
};

writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
// eslint-disable-next-line no-console
console.log(
  `p7-queue-incident-collector: ${findings.length} job(s) inside the two ` +
    `windows written to ${outPath}. No write command was issued.`,
);
