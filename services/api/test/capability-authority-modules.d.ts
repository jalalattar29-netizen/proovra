/**
 * Ambient declarations for the capability-authority analyzer modules.
 *
 * They are plain `.mjs` on purpose: they run as scripts under bare Node during
 * generation and CI, with no build step between an edit and a regenerated map.
 * That is the right trade for a generator — but it leaves the adversarial suite
 * importing untyped modules, and `noImplicitAny` is correct to complain.
 *
 * These declarations exist so the SUITE typechecks without weakening the
 * compiler for the service. They are deliberately loose: the assertions in the
 * tests are what pin the behaviour, and a hand-written type here would be a
 * second description of the analyzer that could drift from the first.
 */

declare module "*/capability-authority/analyzer.mjs" {
  export const INTERP: string;
  export const REPO: string;
  export const DYNAMIC_UNRESOLVED: string;
  export const TREES: ReadonlyArray<{ class: string; product: boolean; roots: string[] }>;
  export function parse(file: string, text: string): unknown;
  export function resolvePathExpr(node: unknown, ctx: unknown): { resolved: boolean; value?: string; reason?: string };
  export function normalizePath(raw: string): string;
  export function candidatePaths(normalized: string): string[];
  export function matches(routePattern: string, consumerPath: string): boolean;
  export function segMatch(routeSeg: string, consumerSeg: string): boolean;
  export function literalUnionOf(node: unknown): string[] | null;
  export function expandTemplate(node: unknown, resolve: (n: unknown) => unknown, cap?: number): string[];
  export function analyzeSources(): Record<string, unknown>;
  export function calleeName(call: unknown): string | null;
  export function calleeObject(call: unknown): string | null;
  export function isTestPath(p: string): boolean;
}

declare module "*/capability-authority/routes.mjs" {
  export function indexApiFunctions(): unknown;
  export function extractRoutes(index: unknown, routesDir?: string): {
    routes: Array<Record<string, unknown>>;
    dynamicUnresolved: Array<Record<string, unknown>>;
    knownGuards: Set<string>;
  };
  export function classifyRouteAuth(route: unknown, index: unknown): {
    authClassification: string;
    authEvidence: string[];
    gates: string[];
  };
  export function classifyGuard(guardName: string, index: unknown, depth?: number, seen?: Set<string>): Map<string, string>;
  export function collectMarkers(node: unknown, index: unknown, depth: number, seen?: Set<string>): Map<string, string>;
  export function registrationPath(raw: string): string;
  export function isUnreachableAliasRegistration(routePath: string): boolean;
}

declare module "*/capability-authority/consumers.mjs" {
  export const WRONG_ORIGIN: string;
  export function analyzeConsumers(
    originResolutions?: Map<string, string>,
    dynamicResolutions?: Map<string, string>,
  ): {
    consumers: Array<Record<string, unknown>>;
    dynamicUnresolved: Array<Record<string, unknown>>;
    foreignOrUnknownOrigin: Array<Record<string, unknown>>;
    fileCount: number;
    requestFnCount: number;
  };
  export function attachConsumers(
    routeIds: string[],
    consumers: Array<Record<string, unknown>>,
    matches: (pattern: string, p: string) => boolean,
    resolutions?: Map<string, string[]>,
  ): {
    byRoute: Map<string, Array<Record<string, unknown>>>;
    unmatched: Array<Record<string, unknown>>;
    ambiguous: Array<Record<string, unknown>>;
  };
}

declare module "*/generate-runtime-capability-map.mjs" {
  export const GENERATOR_VERSION: string;
  export function build(): Record<string, unknown>;
}

declare module "*/audit/engine/facts.mjs" {
  export function freshnessHash(): string;
  export function buildFacts(): Promise<Record<string, unknown>>;
  export function engineProblems(facts: unknown, governance: unknown): string[];
  export function closureProblems(facts: unknown): string[];
  export function releaseBlockingProblems(facts: unknown): string[];
  export function architectureBacklogProblems(facts: unknown): string[];
}

declare module "*/audit/engine/governance.mjs" {
  export function buildInventory(): { records: Map<string, unknown>; packageScripts: unknown[] };
  export function evaluateGovernance(): {
    schemaVersion: string;
    counters: Record<string, number>;
    byRole: Record<string, number>;
    problems: string[];
    records: Array<Record<string, unknown>>;
    [k: string]: unknown;
  };
}

declare module "*/audit/engine/registry.mjs" {
  export const REPO: string;
  export const ENGINE_VERSION: string;
  export const FACTS_SCHEMA_VERSION: string;
  export const INVENTORY_SCHEMA_VERSION: string;
  export const CANONICAL: Record<string, Record<string, string | string[]>>;
  export const DOMAIN_AUTHORITIES: ReadonlyArray<Record<string, string>>;
  export const DELEGATES: ReadonlyArray<Record<string, string>>;
  export const HISTORICAL_PREFIXES: ReadonlyArray<string>;
  export const DIAGNOSTICS: ReadonlyArray<{ path: string; producer: string; why: string }>;
  /** Paths the audit engine writes on every run — held out of its own change set. */
  export const ENGINE_GENERATED_PATHS: ReadonlyArray<string>;
  export function isHistorical(rel: string): boolean;
}

declare module "*/audit/engine/checkpoint-truth.mjs" {
  export function derivedScalars(facts: unknown): Record<string, number | boolean | string>;
  export function evaluateCheckpoint(input: {
    markdown: string;
    facts: unknown;
    commandTargetExists: (relPath: string) => boolean;
  }): {
    pass: boolean;
    duplicateActiveStateSections: number;
    checkpointContradictions: number;
    staleNextCommands: number;
    scalarsChecked: number;
    violations: Array<{ kind: string; detail: string }>;
  };
}

declare module "*/audit/engine/domain-proofs.mjs" {
  export function readDomainProofs(): Array<Record<string, unknown>>;
  export function staleDomainProofs(proofs: unknown[]): unknown[];
}

declare module "*/capability-authority/security-families.mjs" {
  export const SECURITY_FAMILIES: readonly string[];
  export function derivePrimarySecurityFamily(row: {
    method: string;
    path: string;
    authorizationClass: string;
    gates?: string[];
  }): string | null;
  export function deriveSecondarySecurityFamilies(row: unknown, primary: string | null): string[];
  export function deriveSecurityAuthorities(row: unknown): {
    authenticationAuthority: string;
    authorizationAuthority: string;
    tenantBindingAuthority: string | null;
  };
  export function classifyRouteSecurity<T extends Record<string, unknown>>(row: T): T & {
    primarySecurityFamily: string | null;
    secondarySecurityFamilies: string[];
    authenticationAuthority: string;
    authorizationAuthority: string;
    tenantBindingAuthority: string | null;
  };
}

// ===========================================================================
// PHASE 13 — the tenancy and mutation modules.
//
// Deliberately loose, for the same reason the declarations above are: the
// assertions in the suites are what pin the behaviour, and a hand-written type
// here would be a second description of the analyzer that could drift from it.
// ===========================================================================

declare module "*/capability-authority/tenant-binding.mjs" {
  export const MEMBERSHIP_AUTHORITIES: ReadonlyArray<{ id: string; why: string }>;
  export const TENANT_OWNED_MODELS: ReadonlySet<string>;
  export const DATA_SCOPES: readonly string[];
  export const TENANT_TYPES: readonly string[];
  export function deriveTenantOwnedModels(): ReadonlySet<string>;
  export function buildCallGraph(): { graph: Map<string, any>; fileSet: Set<string> };
  export function prismaAccess(node: unknown): unknown;
  export function analyzeHandlerTenancy(
    handlerNode: unknown,
    handlerFile: string,
    cg: unknown,
    maxDepth?: number,
    extraRoots?: unknown[],
  ): Record<string, any>;
  export function classifyTenantBinding(row: unknown, analysis: unknown): Record<string, any>;
}

declare module "*/capability-authority/call-graph.mjs" {
  export const REPO: string;
  export const ts: any;
  export function buildCallGraph(): { graph: Map<string, any>; fileSet: Set<string> };
  export function resolveCall(call: unknown, file: string, cg: unknown): Record<string, any>;
  export function resolveValueDeclaration(node: unknown, file: string, cg: unknown): Record<string, any> | null;
  export function traverse(
    startNode: unknown,
    startFile: string,
    cg: unknown,
    opts: Record<string, any>,
  ): { unresolved: unknown[]; functionsVisited: number };
}

/**
 * PHASE 13 (NEW-047) — the structural authority/reachability primitives that
 * replaced the two fixed-character-window regexes.
 *
 * Loose for the same stated reason as everything above: the adversarial battery
 * is what pins the behaviour, and a hand-written type here would be a second
 * description of the analyzer that could drift from the first.
 */
declare module "*/capability-authority/structural-reach.mjs" {
  export const ts: any;
  export function parseModule(fileName: string, text: string): any;
  export function moduleSpecifiersOf(
    fileName: string,
    text: string,
  ): {
    edges: Array<{ spec: string; kind: string; line: number; typeOnly: boolean; via: string }>;
    unresolved: Array<{ kind: string; line: number; expression: string }>;
  };
  export function resolveAuthority(
    cg: unknown,
    file: string,
    name: string,
  ): { ok: boolean; file?: string; name?: string; node?: any; via?: string; reason?: string };
  export function resolveReference(node: unknown, file: string, cg: unknown): Record<string, any> | null;
  export function reachesFrom(
    cg: unknown,
    start: unknown,
    opts: { match: (node: any, file: string) => unknown; maxDepth?: number; maxFunctions?: number },
  ): {
    reached: boolean;
    evidence: Array<Record<string, any>>;
    unresolved: Array<Record<string, any>>;
    functionsVisited: number;
    startResolved: boolean;
    startReason: string | null;
  };
  export function whereKeysOf(
    callNode: unknown,
  ): { ok: true; keys: string[] } | { ok: false; reason: string };
  export function indexModules(
    sources: Array<{ file: string; text: string }>,
  ): { graph: Map<string, any>; fileSet: Set<string> };
}

declare module "*/capability-authority/mutation-closure.mjs" {
  export const MUTATION_FAMILIES: readonly string[];
  export const NON_REQUEST_DISPOSITIONS: readonly string[];
  export const DELEGATES: ReadonlySet<string>;
  export function deriveDelegates(): ReadonlySet<string>;
  export function terminalWriterAt(
    node: unknown,
    fileText: string,
  ): { kind: string; target: string; op: string } | null;
  export function classifyMutationFamily(writer: Record<string, any>): string | null;
  export function discoverMutationTerminals(cg: unknown): Map<string, any>;
  export function buildReachability(cg: unknown, writers: unknown): Record<string, any>;
  export function resolveMutationEntrypoints(
    cg: unknown,
    writers: unknown,
    entrypoints: unknown[],
  ): Record<string, any>;
  export function dispositionUnreached(file: string): string;
  export function deriveMutationInvariants(
    writer: Record<string, any>,
    routeFactsById: Map<string, any>,
    workRegistryByProducerFile: Map<string, any>,
  ): Record<string, any>;
  export const WRITER_BUCKETS: readonly string[];
  export function writerBucket(w: Record<string, any>): string;
  export function evaluateMutationClosure(writers: Map<string, any>): Record<string, any>;
  export function readWorkRegistry(): Array<Record<string, any>>;
  export function queueTopology(cg: unknown, writers: unknown, registry: unknown): Record<string, any>;
}
