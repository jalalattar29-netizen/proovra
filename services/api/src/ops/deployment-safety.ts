/**
 * F-08 / F-39 / F-41 (independent forward audit, 2026-10-21) — THE DEPLOYMENT
 * SAFETY REPORT an operator runs on a host before (and after) a deploy.
 *
 * It answers, from the process environment and — optionally — the signing-key
 * registry, the questions the audit found answered by accident:
 *   - what environment does this process believe it is in, and is that
 *     DECLARED or guessed;
 *   - is the reverse-proxy trust declared and valid;
 *   - would the development-only surfaces (persona login, E2E bypass, the
 *     rate-limit reset) be live;
 *   - is the configured signing key the repository's committed fixture, and is
 *     that fixture registered and unrevoked.
 *
 * SAFE TO PRINT, BY CONSTRUCTION: every field is a boolean, a count or a closed
 * enum. No variable value, path, CIDR, key, fingerprint or secret is ever
 * returned. PRIVATE key material is never read: the fixture is recognised by
 * the configured private-key LOCATION and by the PUBLIC key's fingerprint.
 */
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { objectLockPostureViolations } from "@proovra/shared";
import {
  committedFixtureKeyAllowed,
  deployedInfrastructureRequired,
  developmentSurfacesAllowed,
  isCommittedFixtureFingerprint,
  publicFingerprintOfPem,
  resolveDeploymentEnvironment,
  type DeploymentEnvironmentKind,
} from "@proovra/shared-runtime";
import { parseProxyTrustPolicy, validateProxyTrustPolicy } from "@proovra/shared-runtime/technical-metadata";

type Env = Record<string, string | undefined>;

export type KeyMaterialFinding = "NOT_APPLICABLE" | "NOT_CONFIGURED" | "UNREADABLE" | "COMMITTED_FIXTURE" | "OTHER_KEY";

export const DEPLOYMENT_UNSAFE_REASONS = [
  "ENVIRONMENT_AMBIGUOUS",
  "ENVIRONMENT_NOT_DECLARED",
  "PROXY_TRUST_INVALID",
  "DEVELOPMENT_SURFACE_LIVE",
  "SIGNING_KEY_IS_COMMITTED_FIXTURE",
  "SIGNING_KEY_NOT_CONFIGURED",
  "COMMITTED_FIXTURE_REGISTERED_ACTIVE",
  "OBJECT_LOCK_POSTURE_VIOLATION",
] as const;
export type DeploymentUnsafeReason = (typeof DEPLOYMENT_UNSAFE_REASONS)[number];

export type DeploymentSafetyReport = {
  environment: {
    kind: DeploymentEnvironmentKind | null;
    ambiguous: boolean;
    basis: "DECLARED" | "NODE_ENV" | "UNKNOWN";
    developmentSurfacesAllowed: boolean;
    deployedInfrastructureRequired: boolean;
    committedFixtureKeyAllowed: boolean;
  };
  proxyTrust: { mode: "off" | "hop" | "cidr"; valid: boolean; errorCount: number };
  developmentSurfaces: {
    devAuthRequested: boolean;
    devAuthLive: boolean;
    e2eBypassSecretConfigured: boolean;
    e2eBypassLive: boolean;
  };
  signing: {
    provider: "local-pem" | "aws-kms" | "other";
    evidencePrivateKeyAtFixtureLocation: boolean;
    evidencePublicKey: KeyMaterialFinding;
    packagePrivateKeyAtFixtureLocation: boolean;
    packagePublicKey: KeyMaterialFinding;
  };
  objectLock: { postureViolationCount: number };
  registry: { checked: boolean; committedFixtureRegistered: boolean | null; committedFixtureActive: boolean | null };
  verdict: "SAFE" | "UNSAFE" | "NOT_A_DEPLOYMENT";
  unsafeReasons: DeploymentUnsafeReason[];
};

const FIXTURE_PRIVATE_LOCATIONS = ["services/api/keys/signing-private.pem", "keys/signing-private.pem"];

/** A configured private-key path that IS the committed fixture's location (the file is never opened). */
export function isFixturePrivateKeyLocation(path: string | undefined): boolean {
  const p = (path ?? "").trim();
  if (!p) return false;
  const norm = resolve(p).replace(/\\/g, "/");
  return FIXTURE_PRIVATE_LOCATIONS.some((s) => norm.endsWith(`/${s}`)) || basename(norm) === "signing-private.pem";
}

function publicKeyFinding(env: Env, pemVar: string | null, pathVars: string[], provider: string): KeyMaterialFinding {
  if (provider !== "local-pem") return "NOT_APPLICABLE";
  const inline = pemVar ? env[pemVar]?.trim() : undefined;
  let pem: string | Buffer | undefined = inline || undefined;
  if (!pem) {
    const path = pathVars.map((v) => env[v]?.trim()).find((v) => !!v);
    if (!path) return "NOT_CONFIGURED";
    try {
      pem = readFileSync(resolve(path));
    } catch {
      return "UNREADABLE";
    }
  }
  const fp = publicFingerprintOfPem(pem);
  if (!fp) return "UNREADABLE";
  return isCommittedFixtureFingerprint(fp) ? "COMMITTED_FIXTURE" : "OTHER_KEY";
}

export function buildDeploymentSafetyReport(
  env: Env = process.env,
  registry: { committedFixtureRegistered: boolean; committedFixtureActive: boolean } | null = null,
): DeploymentSafetyReport {
  const d = resolveDeploymentEnvironment(env);
  const deployed = deployedInfrastructureRequired(env);
  const devAllowed = developmentSurfacesAllowed(env);

  const { policy, errors } = parseProxyTrustPolicy(env, { isProduction: deployed });
  const proxyErrors = errors.length + validateProxyTrustPolicy(policy).length;

  const devAuthRequested = env.DEV_AUTH_ENABLED === "true";
  const e2eSecret = (env.E2E_AUTH_BYPASS_SECRET ?? "").trim().length >= 32;

  const rawProvider = (env.SIGNER_PROVIDER ?? "local-pem").trim().toLowerCase().replace(/_/g, "-");
  const provider: DeploymentSafetyReport["signing"]["provider"] =
    rawProvider === "local-pem" || rawProvider === "aws-kms" ? rawProvider : "other";
  const localPem = provider === "local-pem";

  const report: DeploymentSafetyReport = {
    environment: {
      kind: d.kind,
      ambiguous: d.ambiguous,
      basis: d.basis,
      developmentSurfacesAllowed: devAllowed,
      deployedInfrastructureRequired: deployed,
      committedFixtureKeyAllowed: committedFixtureKeyAllowed(env),
    },
    proxyTrust: { mode: policy.mode, valid: proxyErrors === 0, errorCount: proxyErrors },
    developmentSurfaces: {
      devAuthRequested,
      devAuthLive: devAllowed && devAuthRequested,
      e2eBypassSecretConfigured: e2eSecret,
      e2eBypassLive: devAllowed && e2eSecret,
    },
    signing: {
      provider,
      evidencePrivateKeyAtFixtureLocation: localPem && isFixturePrivateKeyLocation(env.SIGNING_PRIVATE_KEY_PATH),
      evidencePublicKey: publicKeyFinding(env, "SIGNING_PUBLIC_KEY_PEM", ["SIGNING_PUBLIC_KEY_PATH"], provider),
      packagePrivateKeyAtFixtureLocation:
        localPem && isFixturePrivateKeyLocation(env.PACKAGE_SIGNING_PRIVATE_KEY_PATH?.trim() || env.SIGNING_PRIVATE_KEY_PATH),
      packagePublicKey: publicKeyFinding(env, null, ["PACKAGE_SIGNING_PUBLIC_KEY_PATH", "SIGNING_PUBLIC_KEY_PATH"], provider),
    },
    objectLock: { postureViolationCount: objectLockPostureViolations(env).length },
    registry: registry
      ? { checked: true, committedFixtureRegistered: registry.committedFixtureRegistered, committedFixtureActive: registry.committedFixtureActive }
      : { checked: false, committedFixtureRegistered: null, committedFixtureActive: null },
    verdict: "SAFE",
    unsafeReasons: [],
  };

  if (!deployed) {
    report.verdict = "NOT_A_DEPLOYMENT";
    return report;
  }
  const reasons = new Set<DeploymentUnsafeReason>();
  if (d.ambiguous) reasons.add("ENVIRONMENT_AMBIGUOUS");
  if (d.basis !== "DECLARED") reasons.add("ENVIRONMENT_NOT_DECLARED");
  if (proxyErrors > 0) reasons.add("PROXY_TRUST_INVALID");
  if (report.developmentSurfaces.devAuthLive || report.developmentSurfaces.e2eBypassLive) reasons.add("DEVELOPMENT_SURFACE_LIVE");
  const s = report.signing;
  if (
    s.evidencePrivateKeyAtFixtureLocation ||
    s.packagePrivateKeyAtFixtureLocation ||
    s.evidencePublicKey === "COMMITTED_FIXTURE" ||
    s.packagePublicKey === "COMMITTED_FIXTURE"
  ) {
    reasons.add("SIGNING_KEY_IS_COMMITTED_FIXTURE");
  }
  if (localPem && !env.SIGNING_PRIVATE_KEY_PATH?.trim() && !env.SIGNING_PRIVATE_KEY_PEM?.trim()) reasons.add("SIGNING_KEY_NOT_CONFIGURED");
  if (registry?.committedFixtureActive) reasons.add("COMMITTED_FIXTURE_REGISTERED_ACTIVE");
  if (d.kind === "production" && report.objectLock.postureViolationCount > 0) reasons.add("OBJECT_LOCK_POSTURE_VIOLATION");
  report.unsafeReasons = DEPLOYMENT_UNSAFE_REASONS.filter((r) => reasons.has(r));
  report.verdict = report.unsafeReasons.length > 0 ? "UNSAFE" : "SAFE";
  return report;
}

/**
 * The registry question, answered as two booleans: is a committed-fixture key
 * registered at all, and is one registered and NOT revoked. Rows are compared
 * by the SPKI fingerprint of their public key; nothing is returned about them.
 */
export async function readCommittedFixtureRegistration(client: {
  signingKey: { findMany: (args: { select: { publicKeyPem: true; revokedAt: true } }) => Promise<Array<{ publicKeyPem: string; revokedAt: Date | null }>> };
}): Promise<{ committedFixtureRegistered: boolean; committedFixtureActive: boolean }> {
  const rows = await client.signingKey.findMany({ select: { publicKeyPem: true, revokedAt: true } });
  const fixtures = rows.filter((r) => isCommittedFixtureFingerprint(publicFingerprintOfPem(r.publicKeyPem)));
  return { committedFixtureRegistered: fixtures.length > 0, committedFixtureActive: fixtures.some((r) => r.revokedAt === null) };
}
