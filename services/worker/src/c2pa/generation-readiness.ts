/**
 * PROOVRA C2PA — bounded generation readiness probe (Phase M2.1).
 *
 * The probe is HONESTLY DEFENSIVE:
 *   * Returns `disabled` when `C2PA_GENERATE_MANIFESTS=false`.
 *   * Returns `missing_cert` when signing cert path is absent or
 *     unreadable.
 *   * Returns `missing_key` when signing key path is absent or
 *     unreadable.
 *   * Returns `tooling_unavailable` when `C2PA_BIN` is unset.
 *   * Returns `unsupported_target` when configured targets are not
 *     in the bounded allowlist.
 *   * Returns `ready` ONLY when every check passes.
 *
 * The probe NEVER reads or returns key bytes. It only checks
 * existence + readability via `fs.access` and bounds the configured
 * target labels against the published allowlist.
 *
 * The probe never throws. Every failure path is bounded.
 */

import { promises as fs } from "node:fs";
import {
  type C2paGenerationReadiness,
  type C2paGenerationReadinessState,
} from "@proovra/shared";
import { env } from "../config.js";

const BOUNDED_TARGETS: ReadonlyArray<
  "derived_exports" | "report_pdfs" | "verification_packages"
> = ["derived_exports", "report_pdfs", "verification_packages"];

export async function probeC2paGenerationReadiness(): Promise<C2paGenerationReadiness> {
  const configuredTargets = parseConfiguredTargets(env.C2PA_GENERATION_TARGETS);
  if (env.C2PA_GENERATE_MANIFESTS !== "true") {
    return result("disabled", "C2PA manifest generation is disabled by configuration.", configuredTargets);
  }
  if (env.C2PA_SIGNING_ENABLED !== "true") {
    return result(
      "disabled",
      "C2PA signing is disabled; refusing to generate unsigned manifests.",
      configuredTargets,
    );
  }
  if (!env.C2PA_BIN) {
    return result(
      "tooling_unavailable",
      "C2PA_BIN is not configured; the provider cannot run generation.",
      configuredTargets,
    );
  }
  if (!env.C2PA_SIGNING_CERT_PATH) {
    return result(
      "missing_cert",
      "C2PA signing certificate path is not configured.",
      configuredTargets,
    );
  }
  if (!env.C2PA_SIGNING_KEY_PATH) {
    return result(
      "missing_key",
      "C2PA signing key path is not configured.",
      configuredTargets,
    );
  }
  if (!(await fileReadable(env.C2PA_SIGNING_CERT_PATH))) {
    return result(
      "missing_cert",
      "C2PA signing certificate file is not readable at the configured path.",
      configuredTargets,
    );
  }
  if (!(await fileReadable(env.C2PA_SIGNING_KEY_PATH))) {
    return result(
      "missing_key",
      "C2PA signing key file is not readable at the configured path.",
      configuredTargets,
    );
  }
  if (configuredTargets.length === 0) {
    return result(
      "unsupported_target",
      "No bounded C2PA generation targets are configured.",
      configuredTargets,
    );
  }
  return result(
    "ready",
    "C2PA generation is configured and ready for derivative artifacts.",
    configuredTargets,
  );
}

function parseConfiguredTargets(
  raw: string | undefined,
): C2paGenerationReadiness["configuredTargets"] {
  if (!raw) return [];
  const tokens = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return tokens.filter((t): t is (typeof BOUNDED_TARGETS)[number] =>
    (BOUNDED_TARGETS as ReadonlyArray<string>).includes(t),
  );
}

async function fileReadable(path: string): Promise<boolean> {
  try {
    await fs.access(path, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function result(
  state: C2paGenerationReadinessState,
  reason: string,
  configuredTargets: C2paGenerationReadiness["configuredTargets"],
): C2paGenerationReadiness {
  return {
    state,
    reason: reason.slice(0, 240),
    configuredTargets,
    canAttempt: state === "ready",
  };
}
