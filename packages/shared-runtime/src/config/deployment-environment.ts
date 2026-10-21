/**
 * THE DEPLOYMENT ENVIRONMENT (F-08 / F-41, independent forward audit
 * 2026-10-21) — ONE classification of where this process runs, read by every
 * gate that must fail closed outside a development or test machine.
 *
 * Several modules decided "is this production?" on their own, most by the
 * exact string NODE_ENV === "production". A staging (or mislabelled) deployment
 * with any other NODE_ENV therefore opened development-only surfaces (the
 * impersonation login, the test rate-limit reset), and a production process
 * with no proxy-trust declaration silently trusted nothing — so every public
 * visitor shared the reverse proxy's address and one rate-limit bucket.
 *
 * The classification:
 *   - DECLARED by PROOVRA_ENV (canonical), or APP_ENV / DEPLOY_ENV (legacy
 *     aliases): production | staging | development | test. Declarations that
 *     disagree are AMBIGUOUS.
 *   - Otherwise INFERRED from NODE_ENV: production → production,
 *     test → test, development → development; anything else is UNKNOWN.
 *   - A declaration of development / test on a NODE_ENV=production build is
 *     AMBIGUOUS (a production build claiming to be a laptop).
 *
 * Gates:
 *   - developmentSurfacesAllowed: only an unambiguous development or test
 *     classification — never unknown, never ambiguous.
 *   - deployedInfrastructureRequired: production, staging, or ambiguous — the
 *     environments whose infrastructure (proxy trust, signing keys) must be
 *     declared, never defaulted.
 */

export type DeploymentEnvironmentKind = "production" | "staging" | "development" | "test";

export type DeploymentEnvironment = {
  kind: DeploymentEnvironmentKind | null;
  ambiguous: boolean;
  /** How the kind was established. */
  basis: "DECLARED" | "NODE_ENV" | "UNKNOWN";
  /** Bounded explanation, safe to print (names of variables, never values beyond the enum). */
  reason: string;
};

type Env = Record<string, string | undefined>;

const ALIASES: Record<string, DeploymentEnvironmentKind> = {
  production: "production",
  prod: "production",
  staging: "staging",
  stage: "staging",
  development: "development",
  dev: "development",
  local: "development",
  test: "test",
  ci: "test",
};

function normalize(value: string | undefined): DeploymentEnvironmentKind | "INVALID" | null {
  const v = (value ?? "").trim().toLowerCase();
  if (!v) return null;
  return ALIASES[v] ?? "INVALID";
}

export function resolveDeploymentEnvironment(env: Env = process.env): DeploymentEnvironment {
  const declaredBy: Array<[string, DeploymentEnvironmentKind | "INVALID"]> = [];
  for (const name of ["PROOVRA_ENV", "APP_ENV", "DEPLOY_ENV"] as const) {
    const n = normalize(env[name]);
    if (n !== null) declaredBy.push([name, n]);
  }
  const nodeEnv = (env.NODE_ENV ?? "").trim().toLowerCase();

  if (declaredBy.length > 0) {
    if (declaredBy.some(([, k]) => k === "INVALID")) {
      return { kind: null, ambiguous: true, basis: "DECLARED", reason: `unrecognised value in ${declaredBy.filter(([, k]) => k === "INVALID").map(([n]) => n).join(", ")}` };
    }
    const kinds = new Set(declaredBy.map(([, k]) => k as DeploymentEnvironmentKind));
    if (kinds.size > 1) {
      return { kind: null, ambiguous: true, basis: "DECLARED", reason: `${declaredBy.map(([n]) => n).join(", ")} disagree` };
    }
    const kind = [...kinds][0]!;
    if (nodeEnv === "production" && (kind === "development" || kind === "test")) {
      return { kind, ambiguous: true, basis: "DECLARED", reason: `${declaredBy[0]![0]} declares ${kind} on a NODE_ENV=production build` };
    }
    return { kind, ambiguous: false, basis: "DECLARED", reason: `declared by ${declaredBy[0]![0]}` };
  }

  if (nodeEnv === "production") return { kind: "production", ambiguous: false, basis: "NODE_ENV", reason: "NODE_ENV=production" };
  if (nodeEnv === "test") return { kind: "test", ambiguous: false, basis: "NODE_ENV", reason: "NODE_ENV=test" };
  if (nodeEnv === "development") return { kind: "development", ambiguous: false, basis: "NODE_ENV", reason: "NODE_ENV=development" };
  return { kind: null, ambiguous: false, basis: "UNKNOWN", reason: "no environment declared (PROOVRA_ENV unset, NODE_ENV not production / development / test)" };
}

/** Development-only surfaces (impersonation login, test hooks): an unambiguous development or test environment only. */
export function developmentSurfacesAllowed(env: Env = process.env): boolean {
  const d = resolveDeploymentEnvironment(env);
  return !d.ambiguous && (d.kind === "development" || d.kind === "test");
}

/** Infrastructure that must be DECLARED, never defaulted: production, staging, or an ambiguous classification. */
export function deployedInfrastructureRequired(env: Env = process.env): boolean {
  const d = resolveDeploymentEnvironment(env);
  return d.ambiguous || d.kind === "production" || d.kind === "staging";
}
