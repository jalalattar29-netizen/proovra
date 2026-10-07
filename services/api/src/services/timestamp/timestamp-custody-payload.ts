/**
 * THE TIMESTAMP_APPLIED / TIMESTAMP_FAILED custody payload — what the RFC 3161
 * step recorded for a record at completion, in one place beside the validator
 * that produced it.
 */
import type { TimestampResult } from "../timestamp.service.js";

export function timestampCustodyPayload(tsaResult: TimestampResult, tsaInputKind: string | null) {
  return {
    tsaProvider: tsaResult.provider,
    tsaUrl: tsaResult.url,
    tsaSerialNumber: tsaResult.serialNumber,
    tsaGenTimeUtc: tsaResult.genTimeUtc?.toISOString() ?? null,
    tsaMessageImprint: tsaResult.messageImprint,
    tsaInputDigestHex: tsaResult.requestDigestHex,
    tsaInputKind,
    tsaHashAlgorithm: tsaResult.hashAlgorithm,
    tsaStatus: tsaResult.status,
    tsaFailureReason: tsaResult.failureReason,
    // ET-TSA-01/06: the validation fact and the bounded failure code.
    tsaFailureCode: tsaResult.failureCode,
    tsaValidatedAtUtc: tsaResult.validatedAtUtc?.toISOString() ?? null,
    // What the validation established (trust anchor, token certificates,
    // nonce, policy) — read by the package's timestamp-validation.json; null
    // when not validated.
    tsaValidation: tsaResult.validationEvidence ?? null,
    // Phase IA-digest-policy-hard-invariant — soft parser issues for STAMPED
    // rows ("the timestamp landed but our parser missed the serial"). Empty on
    // fully-clean STAMPED and on every FAILED row.
    tsaParseWarnings: tsaResult.warnings,
  };
}
