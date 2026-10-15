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

/** Probe and publish, rate-limited. Never throws: telemetry never takes a worker down. */
export async function publishBitcoinVerifierReadiness(workerId: string, opts: { force?: boolean; now?: number } = {}): Promise<void> {
  const now = opts.now ?? Date.now();
  if (!opts.force && now - lastProbeAt < BITCOIN_VERIFIER_PROBE_INTERVAL_MS) return;
  lastProbeAt = now;
  try {
    const config = resolveOtsBitcoinVerifierConfig();
    if (config.kind === "disabled") return;
    const r = await probeOtsBitcoinVerifierReadiness({ config });
    await prisma.workerTelemetrySnapshot.create({
      data: {
        workerId: `${BITCOIN_VERIFIER_TELEMETRY_PREFIX}${workerId}`.slice(0, 120),
        workerKind: "OTS",
        status: r.ready ? "HEALTHY" : "CRITICAL",
        lastSuccessfulRunAtUtc: r.ready ? new Date(now) : null,
        lastFailedRunAtUtc: r.ready ? null : new Date(now),
        lastErrorCode: r.code ? r.code.slice(0, 80) : null,
        lastErrorMessage: r.detail ? r.detail.slice(0, 400) : null,
        metadataJson: bitcoinVerifierTelemetryMetadata(r) as never,
      },
    });
  } catch (err) {
    logger.warn({ errCode: (err as { code?: unknown })?.code ?? null }, "worker.bitcoin_verifier.telemetry_failed");
  }
}
