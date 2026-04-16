import { getAbsoluteSalesAssets } from "./sales-assets";

type FounderReplyInput = {
  firstName?: string | null;
  useCase?: string | null;
  organization?: string | null;
};

function greet(firstName?: string | null) {
  return firstName?.trim() ? `Hi ${firstName.trim()},` : "Hi,";
}

function normalizeSentence(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "your workflow";
}

export function buildDiscoveryReplyTemplate(input: FounderReplyInput): string {
  const useCase = normalizeSentence(input.useCase);
  const assets = getAbsoluteSalesAssets();

  return `${greet(input.firstName)}

Thank you for your interest in PROOVRA.

From what you shared, it looks like you are exploring a workflow around ${useCase}.

Before scheduling a walkthrough, these resources usually give the clearest picture of how PROOVRA works in practice:

Sample verification report:
${assets.sampleReportUrl}

Verification demo:
${assets.verificationDemoUrl}

Verification methodology:
${assets.methodologyUrl}

Pricing:
${assets.pricingUrl}

If this looks relevant, I’d be happy to walk you through a short demo this week.

Best regards,
Jalal Attar
Founder & CEO, PROOVRA`;
}

export function buildQualifiedReplyTemplate(input: FounderReplyInput): string {
  const useCase = normalizeSentence(input.useCase);
  const assets = getAbsoluteSalesAssets();

  return `${greet(input.firstName)}

Thank you for your request and for your interest in PROOVRA.

Based on what you shared, PROOVRA may be relevant for ${useCase}, especially where digital material may later need stronger review, dispute handling, or internal scrutiny.

A short walkthrough usually covers:
- how a file becomes a structured evidence record
- what the verification page exposes for later review
- how the report supports legal, compliance, claims, or investigation workflows
- what integrity verification does and does not confirm

Helpful links before the call:

Sample report:
${assets.sampleReportUrl}

Verification demo:
${assets.verificationDemoUrl}

Methodology:
${assets.methodologyUrl}

Pricing:
${assets.pricingUrl}

If useful, I can propose a short 20-minute walkthrough this week.

Best regards,
Jalal Attar
Founder & CEO, PROOVRA`;
}

export function buildEnterpriseReplyTemplate(input: FounderReplyInput): string {
  const org = input.organization?.trim() || "your team";
  const useCase = normalizeSentence(input.useCase);
  const assets = getAbsoluteSalesAssets();

  return `${greet(input.firstName)}

Thank you for reaching out about PROOVRA.

Based on what you shared, this looks closer to an enterprise or team workflow discussion for ${org}, particularly around ${useCase}.

The most useful next step is usually a short workflow conversation covering:
- who captures evidence
- who reviews it internally
- whether shared access, retention, or audit requirements matter
- how the verification layer and report output would fit into your process

Helpful resources in advance:

Sample report:
${assets.sampleReportUrl}

Verification demo:
${assets.verificationDemoUrl}

Methodology:
${assets.methodologyUrl}

Pricing:
${assets.pricingUrl}

If you’d like, I can suggest a short call window and tailor the walkthrough to your workflow.

Best regards,
Jalal Attar
Founder & CEO, PROOVRA`;
}

export function buildFollowUpTemplate(input: FounderReplyInput): string {
  const assets = getAbsoluteSalesAssets();

  return `${greet(input.firstName)}

Just following up on your PROOVRA request in case it is still relevant.

Here are the most useful links again:

Sample report:
${assets.sampleReportUrl}

Verification demo:
${assets.verificationDemoUrl}

Methodology:
${assets.methodologyUrl}

Pricing:
${assets.pricingUrl}

Happy to arrange a short walkthrough if helpful.

Best regards,
Jalal Attar`;
}