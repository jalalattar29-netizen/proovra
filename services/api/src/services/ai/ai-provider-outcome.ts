/**
 * RG-05 (PRO-AI1-02 / PRO-AI1-03) — what the PROVIDER TRANSPORT did, as a
 * server-authored fact that decides AI spend.
 *
 * The commit/release decision used to read `result.status`, a value the model
 * itself writes into its JSON (the strict schema lets it choose ok / blocked /
 * disabled / error). A caller who steered the model to a non-ok status got an
 * answered, provider-billed call refunded on both meters. And every thrown or
 * timed-out call was refunded although the provider may have generated and
 * billed it.
 *
 * Three outcomes, set only by server code at the transport boundary:
 *
 *   NOT_SENT      no request reached the provider, or the provider refused it
 *                 before generation (connection refused, 4xx, 429). Releases.
 *   ANSWERED      the provider returned a response. Spends — even when the
 *                 server's own filters then block the content.
 *   SENT_UNKNOWN  the request was sent and no answer is known (timeout, abort,
 *                 5xx, broken connection). DEC-13 bounded rule: the operation
 *                 is KEPT (charged once). It is never refunded and resent, so
 *                 one explicit action costs at most one operation across its
 *                 transport retries, and repeated ambiguous failures cannot
 *                 buy free provider calls.
 *
 * The outcome rides on the result object as `providerOutcome` and is removed
 * before a result is returned to a client (`withoutProviderOutcome`).
 */
import type { AiResult } from "./ai-types.js";
import {
  buildPrismaLedgerStore,
  reconcileAiUsage,
  releaseAiReservation,
} from "./ai-usage-ledger.service.js";

export type AiProviderOutcome = "NOT_SENT" | "SENT_UNKNOWN" | "ANSWERED";

export type MeteredAiResult = AiResult & {
  providerOutcome?: AiProviderOutcome;
  /** Provider-reported cost of the answered call, when usage was returned. */
  providerCostUsdMicros?: bigint | null;
};

/**
 * The outcome of a result. A result with no recorded outcome never passed a
 * provider transport (a deterministic short-circuit, a refusal before the
 * call, a test double) — it is NOT_SENT, whatever its status says.
 */
export function providerOutcomeOf(result: MeteredAiResult | null | undefined): AiProviderOutcome {
  return result?.providerOutcome ?? "NOT_SENT";
}

/** The provider-reported cost riding on a result, if any. */
export function providerCostOf(result: MeteredAiResult | null | undefined): bigint | null {
  return result?.providerCostUsdMicros ?? null;
}

/** Does this result spend the reserved operation? */
export function aiResultSpends(result: MeteredAiResult | null | undefined): boolean {
  return providerOutcomeOf(result) !== "NOT_SENT";
}

export function withProviderOutcome<T extends AiResult>(
  result: T,
  outcome: AiProviderOutcome,
  costUsdMicros: bigint | null = null,
): T & { providerOutcome: AiProviderOutcome; providerCostUsdMicros: bigint | null } {
  return { ...result, providerOutcome: outcome, providerCostUsdMicros: costUsdMicros };
}

/** Strip the internal meter fact before a result leaves the API. */
export function withoutProviderOutcome<T extends MeteredAiResult>(result: T): AiResult {
  const { providerOutcome: _omit, providerCostUsdMicros: _cost, ...rest } = result;
  void _omit;
  void _cost;
  return rest as AiResult;
}

/**
 * Classify a thrown transport error. Only an error that proves the provider
 * did not generate (no connection, or an HTTP refusal before generation)
 * is NOT_SENT; everything else is SENT_UNKNOWN.
 */
export function classifyProviderError(err: unknown): AiProviderOutcome {
  const e = err as {
    name?: string;
    status?: number;
    code?: string;
    cause?: { code?: string };
  } | null;
  if (!e || typeof e !== "object") return "SENT_UNKNOWN";
  const name = String(e.name ?? "");
  // Timeouts and aborts: the request was on the wire.
  if (/Timeout|Abort/i.test(name)) return "SENT_UNKNOWN";
  if (typeof e.status === "number") {
    // 4xx (bad request, auth, not found, unprocessable, rate limited):
    // refused before any generation.
    if (e.status >= 400 && e.status < 500) return "NOT_SENT";
    return "SENT_UNKNOWN";
  }
  const code = String(e.code ?? e.cause?.code ?? "");
  // Connection never established.
  if (/^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET_BEFORE_SEND)$/.test(code)) return "NOT_SENT";
  if (name === "APIConnectionError" && /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(code)) return "NOT_SENT";
  return "SENT_UNKNOWN";
}

/**
 * THE one commit/release decision for an AI call that reserved spend: the
 * workspace budget ledger reservation and the plan-allowance operation are
 * both settled from the transport outcome. NOT_SENT gives both back; ANSWERED
 * and SENT_UNKNOWN keep both. Counter failures never surface to the caller.
 */
export async function settleAiSpend(input: {
  outcome: AiProviderOutcome;
  ledgerReservationId: string | null | undefined;
  /** Provider-reported cost when known (PRO-AI1-12); null keeps the estimate. */
  actualCostUsdMicros?: bigint | null;
  releasePlanOperation: () => Promise<unknown>;
}): Promise<void> {
  const store = buildPrismaLedgerStore();
  if (input.outcome === "NOT_SENT") {
    if (input.ledgerReservationId) {
      await releaseAiReservation(store, input.ledgerReservationId).catch(() => undefined);
    }
    await input.releasePlanOperation().catch(() => undefined);
    return;
  }
  if (input.ledgerReservationId) {
    await reconcileAiUsage(store, input.ledgerReservationId, input.actualCostUsdMicros ?? null).catch(
      () => undefined,
    );
  }
}

/**
 * Token price used to turn provider-reported usage into the ledger's ACTUAL
 * cost (PRO-AI1-12). Operator-configurable; the defaults are the published
 * gpt-4.1-mini list prices per million tokens.
 */
function usdMicrosPerMillionTokens(envVar: string, fallbackUsd: number): number {
  const raw = Number.parseFloat(process.env[envVar] ?? "");
  const usd = Number.isFinite(raw) && raw >= 0 ? raw : fallbackUsd;
  return usd * 1_000_000;
}

export function costFromUsageUsdMicros(usage: { input_tokens?: number; output_tokens?: number } | undefined): bigint | null {
  if (!usage || (typeof usage.input_tokens !== "number" && typeof usage.output_tokens !== "number")) return null;
  const inMicros = ((usage.input_tokens ?? 0) * usdMicrosPerMillionTokens("OPENAI_INPUT_USD_PER_MTOK", 0.4)) / 1_000_000;
  const outMicros = ((usage.output_tokens ?? 0) * usdMicrosPerMillionTokens("OPENAI_OUTPUT_USD_PER_MTOK", 1.6)) / 1_000_000;
  return BigInt(Math.ceil(inMicros + outMicros));
}

