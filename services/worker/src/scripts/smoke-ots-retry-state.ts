/**
 * Phase IA-OTS-forward-retry — runtime smoke for the OTS retry lifecycle.
 *
 * Read-only probe that classifies an evidence row's OTS state into one
 * of the bounded outcomes the forward-retry invariant defines:
 *
 *   ANCHORED_TERMINAL         — evidence.otsStatus === ANCHORED
 *                                + otsAnchoredAtUtc set
 *   FAILED_TERMINAL           — evidence.otsStatus === FAILED
 *                                + otsFailureReason explains why
 *   PENDING_RETRY_SCHEDULED   — evidence.otsStatus === PENDING
 *                                AND a delayed/waiting/active ots-upgrade
 *                                job exists for this evidence
 *   BROKEN_PENDING_NO_RETRY   — evidence.otsStatus === PENDING
 *                                AND no delayed/waiting/active job exists
 *                                AND budget is NOT exhausted
 *                                ← this is the bug the Phase IA fix closed
 *
 * Usage:
 *   pnpm tsx services/worker/src/scripts/smoke-ots-retry-state.ts \
 *     --evidence-id <uuid>
 *
 *   node dist/scripts/smoke-ots-retry-state.js --evidence-id <uuid>
 *
 * Exit codes:
 *   0  — terminal state (ANCHORED or FAILED) or PENDING_RETRY_SCHEDULED
 *   2  — BROKEN_PENDING_NO_RETRY (the invariant violation)
 *   1  — missing flag / fatal error
 *
 * Strict rules:
 *   * NO database writes.
 *   * NO queue mutations — only `getJobs` / `getJob`.
 *   * Connects to Redis read-only via the existing otsUpgradeQueue
 *     handle (initialised module-level in queue.ts). No new connections.
 */

import { prisma } from "../db.js";
import {
  otsUpgradeQueue,
  buildOtsUpgradeJobId,
} from "../queue.js";
import {
  buildFollowUpJobId,
  getOtsGlobalBudgetMs,
  isOtsGlobalBudgetExhausted,
} from "../ots-upgrade.processor.js";
// Phase IA-OTS-hybrid-fix — surface the verify result + the
// classifier output + the next delayed job runAt directly in the
// smoke output. The probe stays read-only: `verifyOtsProof` is
// pure (writes nothing), and `classifyOtsResult` is a pure
// function. The point is to give operators a single command that
// answers "why is this evidence still PENDING?"
import { getOtsProofInfo, verifyOtsProof } from "../ots.service.js";
import {
  classifyOtsResult,
  parseOtsUpgradeOutput,
} from "../ots-upgrade-output.js";

type Args = {
  evidenceId: string | null;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { evidenceId: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--evidence-id") {
      args.evidenceId = (argv[i + 1] ?? "").trim() || null;
      i += 1;
    } else if (a === "--json") {
      args.json = true;
    }
  }
  return args;
}

type Verdict =
  | "ANCHORED_TERMINAL"
  | "FAILED_TERMINAL"
  | "PENDING_RETRY_SCHEDULED"
  | "BROKEN_PENDING_NO_RETRY"
  | "UNKNOWN";

type Probe = { name: string; value: string };

async function probe(evidenceId: string): Promise<{
  verdict: Verdict;
  probes: Probe[];
}> {
  const probes: Probe[] = [];
  probes.push({ name: "evidenceId", value: evidenceId });

  const ev = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: {
      id: true,
      createdAt: true,
      fingerprintHash: true,
      otsStatus: true,
      otsHash: true,
      otsProofBase64: true,
      otsBitcoinTxid: true,
      otsAnchoredAtUtc: true,
      otsUpgradedAtUtc: true,
      otsFailureReason: true,
    },
  });

  if (!ev) {
    probes.push({ name: "error", value: `evidence not found: ${evidenceId}` });
    return { verdict: "UNKNOWN", probes };
  }

  probes.push({ name: "otsStatus", value: ev.otsStatus ?? "null" });
  probes.push({ name: "otsHash", value: ev.otsHash ?? "null" });
  probes.push({
    name: "fingerprintHash",
    value: ev.fingerprintHash ?? "null",
  });
  probes.push({
    name: "otsProofBase64Length",
    value: String(ev.otsProofBase64?.length ?? 0),
  });
  probes.push({
    name: "otsBitcoinTxid",
    value: ev.otsBitcoinTxid ?? "null",
  });
  probes.push({
    name: "otsAnchoredAtUtc",
    value: ev.otsAnchoredAtUtc?.toISOString() ?? "null",
  });
  probes.push({
    name: "otsUpgradedAtUtc",
    value: ev.otsUpgradedAtUtc?.toISOString() ?? "null",
  });
  probes.push({
    name: "otsFailureReason",
    value: ev.otsFailureReason ?? "null",
  });

  // -------------------------------------------------------------------
  // Queue state — read-only. We look at the stable + initial jobIds
  // explicitly AND scan for ANY job whose data.evidenceId matches.
  // The scan catches discriminated jobIds (the Phase IA fix appends a
  // timestamp suffix when self-rescheduling).
  // -------------------------------------------------------------------
  const initialId = buildOtsUpgradeJobId(evidenceId);
  const followupId = buildFollowUpJobId(evidenceId);
  const directJobs = await Promise.all([
    otsUpgradeQueue.getJob(initialId),
    otsUpgradeQueue.getJob(followupId),
  ]);
  const scanBatch = await otsUpgradeQueue.getJobs(
    ["waiting", "delayed", "active", "prioritized"],
    0,
    999,
  );
  const matchingScan = scanBatch.filter(
    (j) => j.data?.evidenceId === evidenceId,
  );

  const runnable = [
    ...directJobs.filter(Boolean),
    ...matchingScan,
  ];
  const dedupedById = new Map<string, (typeof runnable)[number]>();
  for (const j of runnable) {
    if (!j) continue;
    dedupedById.set(String(j.id ?? ""), j);
  }

  const queueSummary: string[] = [];
  let nextDelayedRunAt: string | null = null;
  for (const j of dedupedById.values()) {
    if (!j) continue;
    const st = await j.getState();
    queueSummary.push(`${j.id}=${st}`);
    // Phase IA-OTS-hybrid-fix — surface the runAt of the soonest
    // delayed follow-up so the operator can tell at a glance when
    // the next retry will fire. BullMQ stores the delay window on
    // the job (`delay` ms from `processedOn` / `timestamp`). We
    // never invent a wall-clock — only report what's already on the
    // job.
    if (st === "delayed") {
      const baseMs = j.processedOn ?? j.timestamp ?? null;
      const delayMs = typeof j.opts?.delay === "number" ? j.opts.delay : 0;
      if (baseMs !== null) {
        const runAt = new Date(baseMs + delayMs).toISOString();
        if (nextDelayedRunAt === null || runAt < nextDelayedRunAt) {
          nextDelayedRunAt = runAt;
        }
      }
    }
  }
  probes.push({
    name: "ots_upgrade_queue_jobs",
    value: queueSummary.length === 0 ? "none" : queueSummary.join("; "),
  });
  probes.push({
    name: "next_delayed_job_runAt",
    value: nextDelayedRunAt ?? "none",
  });

  // -------------------------------------------------------------------
  // Phase IA-OTS-hybrid-fix — read-only verify probe.
  //
  // We replay `ots verify` against the persisted proof so the operator
  // can see WHY the proof is still PENDING:
  //
  //   - verify.status: VERIFIED / INCOMPLETE / ERROR / BINARY_MISSING /
  //     DISABLED — the canonical "is the proof actually anchored?" read.
  //   - verify.verified.blockHeight + anchoredAtUtc when the proof IS
  //     fully anchored.
  //   - classifier.kind: the deterministic outcome that the next
  //     follow-up's processor will see if it re-runs verify with the
  //     same persisted bytes. Helps operators predict the next
  //     transition.
  //
  // The verify call writes nothing — it's a pure read of the proof
  // bytes against an in-memory temp file the helper cleans up.
  // -------------------------------------------------------------------
  if (ev.otsProofBase64 && ev.otsHash) {
    try {
      const verifyResult = await verifyOtsProof({
        proofBase64: ev.otsProofBase64,
        hashHex: ev.otsHash,
      });
      probes.push({ name: "verify_status", value: verifyResult.status });
      if (verifyResult.verify) {
        probes.push({
          name: "verify_verified",
          value: String(verifyResult.verify.verified),
        });
        probes.push({
          name: "verify_blockHeight",
          value:
            verifyResult.verify.blockHeight === null
              ? "null"
              : String(verifyResult.verify.blockHeight),
        });
        probes.push({
          name: "verify_anchoredAtUtc",
          value: verifyResult.verify.anchoredAtUtc ?? "null",
        });
      } else {
        probes.push({ name: "verify_verified", value: "n/a" });
      }
      if (verifyResult.error) {
        probes.push({
          name: "verify_error",
          value: verifyResult.error.slice(0, 180),
        });
      }

      // Phase IA-OTS-info-fallback — also run `ots info` so the smoke
      // output answers "would the classifier promote to ANCHORED if
      // the processor re-ran right now?" The info call is a pure
      // local read (no Bitcoin RPC, no calendar network).
      const infoResult = await getOtsProofInfo({
        proofBase64: ev.otsProofBase64,
      });
      probes.push({ name: "info_status", value: infoResult.status });
      if (infoResult.info) {
        probes.push({
          name: "info_fileHash",
          value: infoResult.info.fileHash ?? "null",
        });
        probes.push({
          name: "info_fileHash_matches",
          value: String(
            infoResult.info.fileHash != null &&
              ev.otsHash != null &&
              infoResult.info.fileHash === ev.otsHash.toLowerCase(),
          ),
        });
        probes.push({
          name: "info_blockHeights",
          value:
            infoResult.info.bitcoinBlockHeights.length === 0
              ? "none"
              : infoResult.info.bitcoinBlockHeights.join(","),
        });
        probes.push({
          name: "info_pendingCalendars",
          value:
            infoResult.info.pendingCalendars.length === 0
              ? "none"
              : infoResult.info.pendingCalendars.join(" | "),
        });
        probes.push({
          name: "info_txid",
          value: infoResult.info.txid ?? "null",
        });
      }
      if (infoResult.error) {
        probes.push({
          name: "info_error",
          value: infoResult.error.slice(0, 180),
        });
      }

      // Predict the next classification by running the classifier
      // against the verify + info outputs we just produced + the
      // persisted txid. We pass an empty upgrade output because the
      // smoke script never invokes `ots upgrade` (would mutate the
      // proof file). The persisted txid is read from the evidence row.
      const emptyUpgrade = parseOtsUpgradeOutput("", "");
      const verifyForClassifier =
        verifyResult.status === "VERIFIED" ||
        verifyResult.status === "INCOMPLETE"
          ? verifyResult.verify
          : null;
      const classification = classifyOtsResult({
        upgrade: emptyUpgrade,
        verify: verifyForClassifier,
        info: infoResult.status === "PARSED" ? infoResult.info : null,
        expectedFileHashHex: ev.otsHash,
        existingTxid: ev.otsBitcoinTxid,
        commandErrored: false,
      });
      probes.push({
        name: "classifier_kind",
        value: classification.kind,
      });
      probes.push({
        name: "classifier_phase",
        value: classification.phase,
      });
      probes.push({
        name: "classifier_reason",
        value: classification.reason.slice(0, 180),
      });
    } catch (err) {
      probes.push({
        name: "verify_status",
        value: "PROBE_FAILED",
      });
      probes.push({
        name: "verify_error",
        value: (err instanceof Error ? err.message : String(err)).slice(
          0,
          180,
        ),
      });
    }
  } else {
    probes.push({ name: "verify_status", value: "SKIPPED_NO_PROOF_OR_HASH" });
  }

  const runnableExists = (
    await Promise.all(
      Array.from(dedupedById.values())
        .filter((j): j is NonNullable<typeof j> => j !== undefined && j !== null)
        .map(async (j) => {
          const st = await j.getState();
          return st === "delayed" || st === "waiting" || st === "active" || st === "prioritized";
        }),
    )
  ).some(Boolean);

  // -------------------------------------------------------------------
  // Classification
  // -------------------------------------------------------------------
  const status = (ev.otsStatus ?? "").toUpperCase();

  if (status === "ANCHORED") {
    return { verdict: "ANCHORED_TERMINAL", probes };
  }
  if (status === "FAILED") {
    return { verdict: "FAILED_TERMINAL", probes };
  }
  if (status === "PENDING") {
    if (runnableExists) {
      return { verdict: "PENDING_RETRY_SCHEDULED", probes };
    }
    // No queued retry. Is budget exhausted? If yes, the row SHOULD be
    // FAILED — that's an open governance question (out of scope of
    // this probe). If budget is not exhausted, this is the invariant
    // violation: PENDING + no future retry + budget remains.
    const budgetExhausted = isOtsGlobalBudgetExhausted({
      firstAttemptAtUtc: ev.createdAt,
      nowUtc: new Date(),
      budgetMs: getOtsGlobalBudgetMs(),
    });
    probes.push({
      name: "ots_budget_exhausted",
      value: String(budgetExhausted),
    });
    if (budgetExhausted) {
      // Edge case: budget already exhausted but row not transitioned
      // to FAILED. Treat as broken so the operator notices.
      return { verdict: "BROKEN_PENDING_NO_RETRY", probes };
    }
    return { verdict: "BROKEN_PENDING_NO_RETRY", probes };
  }
  return { verdict: "UNKNOWN", probes };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.evidenceId) {
    process.stdout.write(
      "[smoke-ots-retry-state] --evidence-id <uuid> is required\n",
    );
    return 1;
  }

  const result = await probe(args.evidenceId);

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(
      `[smoke-ots-retry-state] verdict=${result.verdict}\n`,
    );
    for (const p of result.probes) {
      process.stdout.write(`  ${p.name} = ${p.value}\n`);
    }
  }

  if (result.verdict === "BROKEN_PENDING_NO_RETRY") return 2;
  return 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    await otsUpgradeQueue.close();
    process.exit(code);
  })
  .catch(async (err) => {
    await prisma.$disconnect().catch(() => {});
    await otsUpgradeQueue.close().catch(() => {});
    process.stderr.write(
      `[smoke-ots-retry-state] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
