/**
 * Phase A3 — Provider privacy / No-training enforcement.
 *
 * Makes the "No training on customer data" claim enforceable and observable at
 * the request + account level, using only OpenAI SDK v6-supported controls:
 *   - request-level `store: false` on Responses API calls (opt out of OpenAI
 *     storing the response for retrieval),
 *   - explicit project / organization binding on the client,
 *   - an env-declared data-use/retention mode surfaced (bounded) in Trust Hub.
 *
 * We do NOT invent unsupported SDK fields, and we NEVER assert ZDR unless it is
 * explicitly declared configured via env. Enterprise ZDR / no-training is an
 * OpenAI account/project setting; this module records + verifies that operators
 * have declared it and pins the request-level control that IS in our code.
 */

export type ProviderDataUseMode =
  | "NO_TRAINING_ATTESTED"
  | "ZERO_DATA_RETENTION_ATTESTED"
  | "STANDARD_API"
  | "UNKNOWN";

export type ProviderPrivacyConfiguration = {
  provider: "openai";
  project: string | null;
  organization: string | null;
  /** Whether request-level `store:false` is applied (default true = applied). */
  requestStorageDisabled: boolean;
  dataUseMode: ProviderDataUseMode;
  retentionMode: string;
  region: string;
  transferMechanism: string;
  /** Operator-declared verification of the account setting. */
  verifierSource: string | null;
  lastVerifiedAtUtc: string | null;
};

/**
 * Whether to send `store: false` on OpenAI Responses calls. Default TRUE
 * (i.e. we DO opt out of storage) unless an operator explicitly sets
 * OPENAI_STORE=true. Returns the boolean to pass as the `store` param.
 */
export function openAiRequestStore(): boolean {
  // store=false is our default posture → the request param `store` is false.
  return process.env.OPENAI_STORE === "true" ? true : false;
}

function resolveDataUseMode(): ProviderDataUseMode {
  const raw = (process.env.OPENAI_DATA_USE_MODE ?? "").trim().toUpperCase();
  if (raw === "ZDR" || raw === "ZERO_DATA_RETENTION") return "ZERO_DATA_RETENTION_ATTESTED";
  if (raw === "NO_TRAINING") return "NO_TRAINING_ATTESTED";
  if (raw === "STANDARD") return "STANDARD_API";
  // If not explicitly declared, we do NOT claim no-training in code.
  return "UNKNOWN";
}

/** Resolve the current provider privacy configuration from env (no secrets). */
export function resolveOpenAiPrivacyConfig(): ProviderPrivacyConfiguration {
  return {
    provider: "openai",
    project: process.env.OPENAI_PROJECT?.trim() || null,
    organization: process.env.OPENAI_ORG?.trim() || process.env.OPENAI_ORGANIZATION?.trim() || null,
    requestStorageDisabled: openAiRequestStore() === false,
    dataUseMode: resolveDataUseMode(),
    retentionMode:
      openAiRequestStore() === false
        ? "Request storage disabled (store:false); account-level retention per project setting"
        : "Request storage enabled (store:true) by operator override",
    region: process.env.OPENAI_DATA_REGION?.trim() || "OpenAI global (US)",
    transferMechanism: "SCC / DPA (see Subprocessors)",
    verifierSource: process.env.OPENAI_PRIVACY_VERIFIER?.trim() || null,
    lastVerifiedAtUtc: process.env.OPENAI_PRIVACY_VERIFIED_AT?.trim() || null,
  };
}

/** Client constructor options derived from the privacy config (project/org binding). */
export function openAiClientPrivacyOptions(): { project?: string; organization?: string } {
  const cfg = resolveOpenAiPrivacyConfig();
  const opts: { project?: string; organization?: string } = {};
  if (cfg.project) opts.project = cfg.project;
  if (cfg.organization) opts.organization = cfg.organization;
  return opts;
}

export type ProviderPrivacyValidation = {
  ok: boolean;
  severity: "ok" | "warn" | "block";
  code:
    | "PRIVACY_CONFIG_OK"
    | "PRIVACY_MODE_UNKNOWN"
    | "PRIVACY_STORAGE_ENABLED";
  message: string;
};

/**
 * Startup validation. In production, an UNKNOWN data-use mode or an explicit
 * store-enabled override is a policy concern. When AI_REQUIRE_PROVIDER_PRIVACY=
 * "true" this returns severity "block" so the caller can refuse to boot the AI
 * surface; otherwise it warns. Never throws by itself — caller decides.
 */
export function validateProviderPrivacyConfig(): ProviderPrivacyValidation {
  const cfg = resolveOpenAiPrivacyConfig();
  const isProd = process.env.NODE_ENV === "production";
  const strict = process.env.AI_REQUIRE_PROVIDER_PRIVACY === "true";

  if (!cfg.requestStorageDisabled) {
    return {
      ok: false,
      severity: strict ? "block" : "warn",
      code: "PRIVACY_STORAGE_ENABLED",
      message:
        "OPENAI_STORE=true — OpenAI request storage is enabled; the No-training posture is weakened.",
    };
  }
  if (isProd && cfg.dataUseMode === "UNKNOWN") {
    return {
      ok: false,
      severity: strict ? "block" : "warn",
      code: "PRIVACY_MODE_UNKNOWN",
      message:
        "OPENAI_DATA_USE_MODE is not declared (expected NO_TRAINING or ZDR). store:false is applied at request level, but the account-level no-training mode is unverified in config.",
    };
  }
  return {
    ok: true,
    severity: "ok",
    code: "PRIVACY_CONFIG_OK",
    message: "Provider privacy configuration is declared and request storage is disabled.",
  };
}

/** Bounded Trust-Hub status projection (no secrets, no keys). */
export function getProviderPrivacyStatus() {
  const cfg = resolveOpenAiPrivacyConfig();
  const validation = validateProviderPrivacyConfig();
  return {
    provider: cfg.provider,
    requestStorageDisabled: cfg.requestStorageDisabled,
    dataUseMode: cfg.dataUseMode,
    retentionMode: cfg.retentionMode,
    region: cfg.region,
    transferMechanism: cfg.transferMechanism,
    projectBound: Boolean(cfg.project),
    organizationBound: Boolean(cfg.organization),
    verifierSource: cfg.verifierSource,
    lastVerifiedAtUtc: cfg.lastVerifiedAtUtc,
    validation: { ok: validation.ok, code: validation.code, severity: validation.severity },
  };
}
