/**
 * Types for `operations-writer-schema-contract.mjs`.
 *
 * The implementation is plain `.mjs` on purpose: it is imported by
 * `db-preflight.mjs` (a release gate that runs before anything is built) AND
 * by the running API through `operations-writer-readiness.ts`. One authority,
 * two consumers, no build step between them.
 */

export type WriterCriticality = "MANDATORY" | "BEST_EFFORT";

export type OperationsWriterModel = {
  readonly model: string;
  readonly criticality: WriterCriticality;
  readonly stage: string;
};

export declare const OPERATIONS_WRITER_MODELS: ReadonlyArray<OperationsWriterModel>;

export type ResolvedWriterTable = {
  model: string;
  table: string;
  columns: string[];
  criticality: WriterCriticality;
  stage: string;
};

export type WriterContractMissing = {
  model: string;
  table: string;
  criticality: WriterCriticality;
  stage: string;
  columns: string[];
};

export type WriterContractResult = {
  ok: boolean;
  checkedTables: string[];
  missing: WriterContractMissing[];
  /** Legacy duplicate columns physically present. Empty is healthy. */
  legacy: WriterContractLegacy[];
  /** Constraints/indexes that do not bind the canonical columns. */
  bindings: WriterContractBinding[];
  indeterminate: string[];
};

/** Anything shaped like a Prisma data model. Kept structural so the pure
 *  functions can be exercised without importing Prisma at all. */
export type WriterDatamodel = {
  datamodel?: {
    readonly models?: ReadonlyArray<{
      readonly name: string;
      readonly dbName?: string | null;
      readonly fields?: ReadonlyArray<{
        readonly name: string;
        readonly kind: string;
        readonly dbName?: string | null;
        readonly relationName?: string | null;
      }>;
    }>;
  };
};

export declare function writerModelColumns(
  dmmf: WriterDatamodel,
  modelName: string,
): { table: string; columns: string[] } | null;

export declare function resolveWriterContract(
  dmmf: WriterDatamodel,
): ResolvedWriterTable[];

export declare function writerContractModelsPresent(
  dmmf: WriterDatamodel,
): string[];

export declare function missingColumnsSql(entry: {
  table: string;
  columns: string[];
}): string;

export declare function checkOperationsWriterContract(
  dmmf: WriterDatamodel,
  // The probes return different column names (missing_column,
  // legacy_column, or a bare existence row), so the caller supplies one
  // generic row reader rather than a shape per probe.
  query: (sql: string) => Promise<Array<Record<string, unknown>>>,
): Promise<WriterContractResult>;

export declare function describeWriterContractFailure(result: {
  missing: WriterContractMissing[];
  legacy?: WriterContractLegacy[];
  bindings?: WriterContractBinding[];
  indeterminate: string[];
}): string;

export declare function loadDeployedDatamodel(): Promise<WriterDatamodel>;

export type WriterContractLegacy = {
  model: string;
  table: string;
  criticality: WriterCriticality;
  stage: string;
  columns: string[];
};

export type WriterContractBinding = {
  table: string;
  issue: string;
};

export declare function legacyColumnsFor(
  dmmf: WriterDatamodel,
  modelName: string,
): { table: string; columns: string[] } | null;

export declare function legacyColumnsSql(entry: {
  table: string;
  columns: string[];
}): string | null;

export declare function canonicalDedupeIndexSql(): string;
