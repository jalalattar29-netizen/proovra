/**
 * B6-F-20 (Free-user audit 0ea0) — THE plan-allowance meter for AI surfaces
 * whose provider call sits behind other gates (policy, selection, schema
 * repair).
 *
 * The evidence, case and reviewer copilots and evidence categorization asked
 * only whether the plan INCLUDES AI (`cap > 0`) and recorded usage in the
 * workspace budget ledger. They never took an operation from the plan's
 * monthly allowance (`entitlement_usage`), so a Free account could run them
 * without limit after its 10 operations were spent.
 *
 * This takes ONE operation through the existing writer,
 * `reserveWorkspaceAiOperation`, on the first provider call, so a request that
 * the policy or selection gate stops before the provider costs nothing, and a
 * schema-repair retry inside the same request does not cost twice. `refund()`
 * gives it back when the provider did not answer, through the existing
 * `releaseWorkspaceAiOperation`. A refused reservation throws
 * `AiPlanAllowanceRefused` carrying the canonical denial shape.
 */
import {
  reserveWorkspaceAiOperation,
  releaseWorkspaceAiOperation,
  type AiOperationReservation,
} from "../billing-enforcement.service.js";
import type { WorkspaceScope } from "../workspace-billing.service.js";

export class AiPlanAllowanceRefused extends Error {
  constructor(
    readonly denial: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "AiPlanAllowanceRefused";
  }
}

export type AiPlanOperationMeter = {
  /** Takes the operation once; later calls in the same request are free. */
  take(): Promise<void>;
  /** Gives the operation back (provider unavailable / no answer). Idempotent. */
  refund(): Promise<void>;
  /** Whether an operation is currently held by this meter. */
  readonly taken: boolean;
};

/**
 * `scope` is resolved lazily so a request stopped before the provider never
 * pays for the commercial-scope read either. A null scope (no commercial
 * subject) is the plan not including AI.
 */
export function meterAiPlanOperation(resolveScope: () => Promise<WorkspaceScope | null>): AiPlanOperationMeter {
  let held: AiOperationReservation | null | undefined; // undefined = nothing taken
  return {
    get taken() {
      return held !== undefined;
    },
    async take() {
      if (held !== undefined) return;
      const scope = await resolveScope();
      if (!scope) {
        throw new AiPlanAllowanceRefused("AI_NOT_INCLUDED", 402, "AI assistance is not included in the current plan");
      }
      const outcome = await reserveWorkspaceAiOperation(scope);
      if (!outcome.allowed) throw new AiPlanAllowanceRefused(outcome.denial, outcome.statusCode, outcome.message);
      held = outcome.reservation;
    },
    async refund() {
      if (held === undefined) return;
      const reservation = held;
      held = undefined;
      await releaseWorkspaceAiOperation(reservation).catch(() => undefined);
    },
  };
}
