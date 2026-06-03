/**
 * PROOVRA C2PA — generation readiness probe (api side, Phase M2.1).
 *
 * Returns the bounded readiness state for C2PA manifest generation.
 * Reads only env + filesystem; NEVER opens key bytes.
 *
 * Mirror of `services/worker/src/c2pa/generation-readiness.ts` so the
 * api endpoint can answer the readiness query without crossing the
 * api↔worker boundary.
 */
import { promises as fs } from "node:fs";
const BOUNDED_TARGETS = ["derived_exports", "report_pdfs", "verification_packages"];
export async function probeC2paGenerationReadiness() {
    const env = process.env;
    const configuredTargets = parseConfiguredTargets(env.C2PA_GENERATION_TARGETS);
    if (env.C2PA_GENERATE_MANIFESTS !== "true") {
        return result("disabled", "C2PA manifest generation is disabled by configuration.", configuredTargets);
    }
    if (env.C2PA_SIGNING_ENABLED !== "true") {
        return result("disabled", "C2PA signing is disabled; refusing to generate unsigned manifests.", configuredTargets);
    }
    if (!env.C2PA_BIN) {
        return result("tooling_unavailable", "C2PA_BIN is not configured; the provider cannot run generation.", configuredTargets);
    }
    if (!env.C2PA_SIGNING_CERT_PATH) {
        return result("missing_cert", "C2PA signing certificate path is not configured.", configuredTargets);
    }
    if (!env.C2PA_SIGNING_KEY_PATH) {
        return result("missing_key", "C2PA signing key path is not configured.", configuredTargets);
    }
    if (!(await fileReadable(env.C2PA_SIGNING_CERT_PATH))) {
        return result("missing_cert", "C2PA signing certificate file is not readable at the configured path.", configuredTargets);
    }
    if (!(await fileReadable(env.C2PA_SIGNING_KEY_PATH))) {
        return result("missing_key", "C2PA signing key file is not readable at the configured path.", configuredTargets);
    }
    if (configuredTargets.length === 0) {
        return result("unsupported_target", "No bounded C2PA generation targets are configured.", configuredTargets);
    }
    return result("ready", "C2PA generation is configured and ready for derivative artifacts.", configuredTargets);
}
function parseConfiguredTargets(raw) {
    if (!raw)
        return [];
    const tokens = raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    return tokens.filter((t) => BOUNDED_TARGETS.includes(t));
}
async function fileReadable(path) {
    try {
        await fs.access(path, fs.constants.R_OK);
        return true;
    }
    catch {
        return false;
    }
}
function result(state, reason, configuredTargets) {
    return {
        state,
        reason: reason.slice(0, 240),
        configuredTargets,
        canAttempt: state === "ready",
    };
}
