/**
 * Types for `runtime-schema-requirements.mjs`.
 *
 * The implementation is plain `.mjs` on purpose: `runtime-schema-gate.mjs`
 * and `db-preflight.mjs` run it from the image before anything is trusted.
 * These declarations let tests import it statically.
 */

export type RuntimeSchemaRequirement = {
  readonly id: string;
  readonly kind: "enum_type" | "enum_value" | "column" | "index" | "table" | "constraint";
  readonly detail: string;
  readonly requiredBy: string;
  readonly suppliedBy: string;
};

export type RuntimeSchemaCheckResult = {
  ok: boolean;
  missing: RuntimeSchemaRequirement[];
  indeterminate: string[];
};

export declare const RUNTIME_SCHEMA_REQUIREMENTS: ReadonlyArray<RuntimeSchemaRequirement>;

export declare function checkRuntimeSchemaRequirements(
  probe: (sql: string) => Promise<boolean>,
): Promise<RuntimeSchemaCheckResult>;

export declare function describeRuntimeSchemaFailure(result: {
  missing: RuntimeSchemaRequirement[];
  indeterminate: string[];
}): string;
