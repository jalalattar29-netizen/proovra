/**
 * Shared types for hand-built Prisma doubles in the API test suite.
 *
 * Test doubles are deliberately loose — a suite stubs only the delegates it
 * exercises — but "loose" must not mean `any`: an `any` argument silently
 * accepts a delegate call whose shape the production code changed, which is
 * exactly the drift these suites exist to catch.
 *
 * `JsonRecord` keeps values at `unknown`, so a test that reads a nested field
 * has to say what it expects. `asPrismaDouble` is the ONE place a double is
 * asserted to satisfy the client interface, and it goes through `unknown`
 * rather than `any`, so the assertion is visible at the call site.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonRecord
  | JsonValue[];

export type JsonRecord = { [key: string]: JsonValue | unknown };

/** The subset of Prisma delegate arguments the doubles in this suite read. */
export type DelegateArgs = {
  where?: JsonRecord;
  data?: JsonRecord;
  select?: JsonRecord;
  include?: JsonRecord;
  orderBy?: JsonRecord | JsonRecord[];
  take?: number;
  skip?: number;
  cursor?: JsonRecord;
};

/**
 * Assert a hand-built double satisfies the client interface the code under
 * test expects. Deliberately routed through `unknown`: the double is partial
 * by design, and this is the single, greppable place that says so.
 */
export function asPrismaDouble<T>(double: unknown): T {
  return double as T;
}

/** Read a nested record field without widening the whole argument to `any`. */
export function rec(value: unknown): JsonRecord {
  return (value ?? {}) as JsonRecord;
}

/** Read a nested array-of-records field (e.g. a Prisma `OR` clause). */
export function recs(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? (value as JsonRecord[]) : [];
}

/** Read a field expected to be a string, or null when it is absent. */
export function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
