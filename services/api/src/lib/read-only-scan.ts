/**
 * A READ-ONLY SCAN — a dry run that must write nothing, not even telemetry.
 *
 * Some read paths record their own USE as an audit event (the legacy
 * enterprise-contract fallback does, so its remaining use can be measured and
 * the fallback retired). That is right for a customer's request and wrong for
 * an operator's dry run: a scan over thousands of records would write
 * thousands of rows claiming customer use that never happened, and a dry run
 * that writes is not a dry run.
 *
 * Scoped to the async call tree of `runReadOnlyScan`, so nothing outside it —
 * a concurrent request on the same process — is affected. Only USAGE
 * telemetry consults it; no authorization, audit of an action, or state
 * change may be skipped because of it.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage<{ readOnlyScan: true }>();

export function runReadOnlyScan<T>(fn: () => Promise<T>): Promise<T> {
  return scope.run({ readOnlyScan: true }, fn);
}

export function isReadOnlyScan(): boolean {
  return scope.getStore()?.readOnlyScan === true;
}
