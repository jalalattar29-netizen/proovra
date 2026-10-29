/**
 * BITCOIN VERIFIER READINESS → OPERATIONS.
 *
 * When live Bitcoin verification is enabled, the worker probes the verifier's
 * readiness on its telemetry cadence (at most every 5 minutes) and records the
 * result as a `worker_telemetry_snapshots` row (kind OTS, workerId
 * `bitcoin-verifier:<worker id>`). The API's platform-conditions pass reads the
 * newest such row and records — or auto-resolves —
 * `platform.bitcoin_verifier_unavailable` through the existing Operations
 * incident authority. The API never touches the node or its credentials.
 *
 * With verification DISABLED a row is published only while ANCHORED records
 * wait unchecked (code BTC_VERIFIER_DISABLED, see publishBitcoinVerifierReadiness);
 * every row carries the `anchoredAwaitingChainVerification` gauge.
 *
 * The row is bounded and credential-free: readiness, a bounded code and
 * detail, chain, tip height and node version. Never the node address, the user
 * or the password.
 */
import { prisma } from "./db.js";
import { logger } from "./logger.js";
import { resolveOtsBitcoinVerifierConfig } from "./ots-bitcoin-config.js";
import { probeOtsBitcoinVerifierReadiness, type OtsBitcoinVerifierReadiness } from "./ots-bitcoin-verifier.js";

export const BITCOIN_VERIFIER_TELEMETRY_PREFIX = "bitcoin-verifier:";
export const BITCOIN_VERIFIER_PROBE_INTERVAL_MS = 5 * 60 * 1000;

let lastProbeAt = 0;

/** The bounded telemetry document for one readiness observation. */
export function bitcoinVerifierTelemetryMetadata(r: OtsBitcoinVerifierReadiness): Record<string, unknown> {
  return {
    bitcoinVerifier: {
      enabled: r.enabled,
      ready: r.ready,
      code: r.code,
      chain: r.chain,
      tipHeight: r.tipHeight,
      nodeVersion: r.nodeVersion,
      observedAtUtc: r.observedAtUtc,
    },
  };
}

/** The bounded code a disabled verifier reports while anchored proofs wait on it. */
export const BITCOIN_VERIFIER_DISABLED_CODE = "BTC_VERIFIER_DISABLED";

/**
 * THE GAUGE (2026-10-29): records whose proof is ANCHORED — it names a Bitcoin
 * block — and has NOT been independently verified against the main chain
 * (no chain outcome yet, or a non-terminal one: unavailable, not configured,
 * insufficient confirmations). They read "Bitcoin attestation recorded — not
 * independently checked"; this counts them so the wait is visible.
 */
export async function countAnchoredAwaitingChainVerification(): Promise<number> {
  return prisma.evidence.count({
    where: {
      deletedAt: null,
      otsStatus: "ANCHORED",
      OR: [{ otsChainVerificationStatus: null }, { otsChainVerificationStatus: { notIn: ["VERIFIED", "FAILED"] } }],
    },
  });
}

/**
 * Probe and publish, rate-limited. Never throws: telemetry never takes a worker down.
 *
 * DISABLED VERIFIER (2026-10-29): with live verification off an ANCHORED
 * record keeps stating an unchecked attestation forever — truthfully, but
 * silently. When any such record exists, a DEGRADED row with the bounded code
 * BTC_VERIFIER_DISABLED is published, which the API's platform-conditions pass
 * records as `platform.bitcoin_verifier_unavailable`; with none waiting,
 * nothing is published (a deployment that never anchors needs no verifier).
 * Nothing here verifies anything, marks anything verified, or touches a record.
 */
export async function publishBitcoinVerifierReadiness(workerId: string, opts: { force?: boolean; now?: number } = {}): Promise<void> {
  const now = opts.now ?? Date.now();
  if (!opts.force && now - lastProbeAt < BITCOIN_VERIFIER_PROBE_INTERVAL_MS) return;
  lastProbeAt = now;
  try {
    const config = resolveOtsBitcoinVerifierConfig();
    const workerKey = `${BITCOIN_VERIFIER_TELEMETRY_PREFIX}${workerId}`.slice(0, 120);
    if (config.kind === "disabled") {
      const awaiting = await countAnchoredAwaitingChainVerification();
      if (awaiting === 0) return;
      const detail = `Live Bitcoin verification is disabled; ${awaiting} anchored record(s) remain not independently checked against Bitcoin.`;
      await prisma.workerTelemetrySnapshot.create({
        data: {
          workerId: workerKey,
          workerKind: "OTS",
          status: "DEGRADED",
          lastSuccessfulRunAtUtc: null,
          lastFailedRunAtUtc: new Date(now),
          lastErrorCode: BITCOIN_VERIFIER_DISABLED_CODE,
          lastErrorMessage: detail,
          metadataJson: {
            ...bitcoinVerifierTelemetryMetadata({
              enabled: false,
              ready: false,
              code: BITCOIN_VERIFIER_DISABLED_CODE,
              detail,
              chain: null,
              tipHeight: null,
              nodeVersion: null,
              endpoint: null,
              observedAtUtc: new Date(now).toISOString(),
            }),
            anchoredAwaitingChainVerification: awaiting,
          } as never,
        },
      });
      logger.warn({ anchoredAwaitingChainVerification: awaiting }, "worker.bitcoin_verifier.disabled_with_unchecked_anchors");
      return;
    }
    const r = await probeOtsBitcoinVerifierReadiness({ config });
    const awaiting = await countAnchoredAwaitingChainVerification().catch(() => null);
    await prisma.workerTelemetrySnapshot.create({
      data: {
        workerId: workerKey,
        workerKind: "OTS",
        status: r.ready ? "HEALTHY" : "CRITICAL",
        lastSuccessfulRunAtUtc: r.ready ? new Date(now) : null,
        lastFailedRunAtUtc: r.ready ? null : new Date(now),
        lastErrorCode: r.code ? r.code.slice(0, 80) : null,
        lastErrorMessage: r.detail ? r.detail.slice(0, 400) : null,
        metadataJson: { ...bitcoinVerifierTelemetryMetadata(r), anchoredAwaitingChainVerification: awaiting } as never,
      },
    });
  } catch (err) {
    logger.warn({ errCode: (err as { code?: unknown })?.code ?? null }, "worker.bitcoin_verifier.telemetry_failed");
  }
}
