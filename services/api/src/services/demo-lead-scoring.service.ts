export type DemoLeadTrack = "DISCOVERY" | "SALES" | "ENTERPRISE";
export type DemoLeadQuality = "LOW" | "MEDIUM" | "HIGH";
export type DemoLeadAction =
  | "reply_with_resources"
  | "offer_demo"
  | "route_enterprise";

export type ScoreDemoLeadInput = {
  workEmail: string;
  organization?: string | null;
  jobTitle?: string | null;
  country?: string | null;
  teamSize?: string | null;
  useCase: string;
  message?: string | null;
  sourcePath?: string | null;
};

export type ScoreDemoLeadResult = {
  leadQuality: DemoLeadQuality;
  leadTrack: DemoLeadTrack;
  recommendedAction: DemoLeadAction;
  responseSlaHours: number;
  score: number;
  reasons: string[];
  usesFreeEmailDomain: boolean;
};

const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "aol.com",
  "gmx.de",
  "web.de",
  "proton.me",
  "protonmail.com",
]);

const HIGH_INTENT_KEYWORDS = [
  "legal",
  "compliance",
  "claims",
  "claim",
  "investigation",
  "investigations",
  "audit",
  "forensic",
  "forensics",
  "enterprise",
  "retention",
  "procurement",
  "internal review",
  "journalism",
  "evidence handling",
];

const ENTERPRISE_KEYWORDS = [
  "shared access",
  "team workflow",
  "retention",
  "volume",
  "enterprise",
  "procurement",
  "security review",
  "compliance review",
  "audit",
  "policy",
  "deployment",
  "rollout",
];

const STRONG_JOB_TITLES = [
  "counsel",
  "legal",
  "compliance",
  "investigator",
  "claims",
  "risk",
  "audit",
  "security",
  "head of",
  "director",
  "manager",
  "lead",
  "founder",
  "ceo",
  "cto",
  "coo",
  "vp",
];

function normalize(value?: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

function emailDomain(email: string): string {
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  return domain;
}

function includesAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function teamSizeScore(
  teamSize?: string | null
): { score: number; reason?: string } {
  const value = normalize(teamSize);

  if (!value) return { score: 0 };

  if (value === "1000+" || value === "201-1000") {
    return { score: 28, reason: "large_team_size" };
  }
  if (value === "51-200") {
    return { score: 20, reason: "mid_large_team_size" };
  }
  if (value === "21-50") {
    return { score: 14, reason: "growing_team_size" };
  }
  if (value === "6-20") {
    return { score: 8, reason: "small_team_signal" };
  }
  if (value === "1-5") {
    return { score: 2, reason: "very_small_team" };
  }

  return { score: 0 };
}

export function scoreDemoLead(
  input: ScoreDemoLeadInput
): ScoreDemoLeadResult {
  const workEmail = normalize(input.workEmail);
  const organization = normalize(input.organization);
  const jobTitle = normalize(input.jobTitle);
  const useCase = normalize(input.useCase);
  const message = normalize(input.message);
  const sourcePath = normalize(input.sourcePath);

  const combinedText = `${organization} ${jobTitle} ${useCase} ${message}`.trim();

  let score = 0;
  const reasons: string[] = [];

  const domain = emailDomain(workEmail);
  const usesFreeEmailDomain = FREE_EMAIL_DOMAINS.has(domain);

  if (!usesFreeEmailDomain && domain) {
    score += 12;
    reasons.push("corporate_email_domain");
  } else {
    reasons.push("free_email_domain");
  }

  if (organization) {
    score += 10;
    reasons.push("organization_present");
  }

  if (jobTitle) {
    score += 8;
    reasons.push("job_title_present");
  }

  if (includesAny(jobTitle, STRONG_JOB_TITLES)) {
    score += 16;
    reasons.push("strong_job_title_signal");
  }

  if (includesAny(combinedText, HIGH_INTENT_KEYWORDS)) {
    score += 18;
    reasons.push("high_intent_use_case_signal");
  }

  if (includesAny(combinedText, ENTERPRISE_KEYWORDS)) {
    score += 20;
    reasons.push("enterprise_signal");
  }

  if (sourcePath.includes("/contact-sales")) {
    score += 24;
    reasons.push("enterprise_page_source");
  } else if (sourcePath.includes("track=enterprise")) {
    score += 18;
    reasons.push("enterprise_query_track");
  }

  const teamScore = teamSizeScore(input.teamSize);
  score += teamScore.score;
  if (teamScore.reason) reasons.push(teamScore.reason);

  if (useCase.length >= 40) {
    score += 8;
    reasons.push("detailed_use_case");
  } else if (useCase.length >= 20) {
    score += 4;
    reasons.push("basic_use_case_detail");
  }

  if (message.length >= 30) {
    score += 6;
    reasons.push("additional_context_present");
  }

  let leadTrack: DemoLeadTrack = "DISCOVERY";
  if (
    sourcePath.includes("/contact-sales") ||
    includesAny(combinedText, ENTERPRISE_KEYWORDS) ||
    input.teamSize === "51-200" ||
    input.teamSize === "201-1000" ||
    input.teamSize === "1000+"
  ) {
    leadTrack = "ENTERPRISE";
  } else if (score >= 26) {
    leadTrack = "SALES";
  }

  let leadQuality: DemoLeadQuality = "LOW";
  if (score >= 52) {
    leadQuality = "HIGH";
  } else if (score >= 26) {
    leadQuality = "MEDIUM";
  }

  let recommendedAction: DemoLeadAction = "reply_with_resources";
  let responseSlaHours = 24;

  if (leadTrack === "ENTERPRISE") {
    recommendedAction = "route_enterprise";
    responseSlaHours = 4;
  } else if (leadQuality === "HIGH" || leadQuality === "MEDIUM") {
    recommendedAction = "offer_demo";
    responseSlaHours = 8;
  }

  return {
    leadQuality,
    leadTrack,
    recommendedAction,
    responseSlaHours,
    score,
    reasons,
    usesFreeEmailDomain,
  };
}